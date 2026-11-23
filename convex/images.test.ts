import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import {
  inspectImageBytes,
  MAX_OPEN_UPLOAD_INTENTS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_INTENTS_PER_WINDOW,
  UPLOAD_RATE_WINDOW_MS,
} from './imageValidation'
import schema from './schema'
import { modules } from './test.setup'
import { sha256Hex } from './uploadToken'

function createTestBackend() {
  return convexTest(schema, modules)
}

function makePngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(32))
  // PNG signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR chunk length (13) + "IHDR"
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

function makeGifBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(14))
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // GIF89a
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return bytes
}

function makeJpegBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(16))
  bytes[0] = 0xff
  bytes[1] = 0xd8 // SOI
  bytes[2] = 0xff
  bytes[3] = 0xc0 // SOF0
  const view = new DataView(bytes.buffer)
  view.setUint16(4, 11, false) // segment length
  bytes[6] = 8 // precision
  view.setUint16(7, height, false)
  view.setUint16(9, width, false)
  return bytes
}

function makeWebpVp8xBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(32))
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >> 8) & 0xff
  bytes[26] = (w >> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >> 8) & 0xff
  bytes[29] = (h >> 16) & 0xff
  return bytes
}

async function seedImages(options: {
  ownerAuthId?: string
  guestOwnerKey?: string
  editKey?: string
  isPublic?: boolean
} = {}) {
  const t = createTestBackend()
  let ownerId: Id<'users'> | undefined

  const seeded = await t.run(async (ctx) => {
    if (options.ownerAuthId) {
      ownerId = await ctx.db.insert('users', {
        authId: options.ownerAuthId,
        email: `${options.ownerAuthId}@example.com`,
      })
    }

    const sessionId = await ctx.db.insert('paintingSessions', {
      createdBy: ownerId,
      guestOwnerKey: options.guestOwnerKey,
      editKey: options.editKey,
      isPublic: options.isPublic ?? false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 1,
      paintLayerOrder: 0,
    })
    const storageId = await ctx.storage.store(
      new Blob([makePngBytes(100, 100)], { type: 'image/png' }),
    )
    const uploadedImageId = await ctx.db.insert('uploadedImages', {
      sessionId,
      storageId,
      filename: 'original.png',
      mimeType: 'image/png',
      width: 100,
      height: 100,
      x: 50,
      y: 50,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 1,
    })
    const aiImageId = await ctx.db.insert('aiGeneratedImages', {
      sessionId,
      imageUrl: 'https://example.com/ai.png',
      width: 100,
      height: 100,
      x: 50,
      y: 50,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 2,
      createdAt: Date.now(),
    })
    const strokeId = await ctx.db.insert('strokes', {
      sessionId,
      layerId: uploadedImageId,
      userColor: '#000000',
      points: [{ x: 1, y: 1 }],
      brushColor: '#000000',
      brushSize: 2,
      opacity: 1,
      strokeOrder: 1,
    })

    return { sessionId, storageId, uploadedImageId, aiImageId, strokeId }
  })

  return { t, ownerId, ...seeded }
}

type TestBackend = ReturnType<typeof createTestBackend>
type Intent = { intentId: Id<'imageUploadIntents'>; uploadToken: string }

const APP_ORIGIN = 'http://localhost:3000'
const STORAGE_ORIGIN = 'https://some-deployment.convex.cloud'

async function postUpload(
  t: TestBackend,
  intent: Intent,
  body: BodyInit | null,
  extraHeaders: Record<string, string> = {},
) {
  return await t.fetch('/uploads/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Upload-Intent': intent.intentId,
      'X-Upload-Token': intent.uploadToken,
      ...extraHeaders,
    },
    body,
  })
}

async function storageCount(t: TestBackend): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)
}

function commitArgs(
  sessionId: Id<'paintingSessions'>,
  intent: Intent,
  extra: Record<string, unknown> = {},
) {
  return {
    sessionId,
    intentId: intent.intentId,
    uploadToken: intent.uploadToken,
    filename: 'new.png',
    x: 400,
    y: 300,
    ...extra,
  }
}

/** Create an intent, upload `bytes` through the HTTP action, expect 200. */
async function uploadThroughIntent(
  t: TestBackend,
  caller: Pick<TestBackend, 'mutation'>,
  sessionId: Id<'paintingSessions'>,
  bytes: Uint8Array<ArrayBuffer> = makePngBytes(120, 90),
  guestKey?: string,
  editKey?: string,
): Promise<Intent> {
  const intent = await caller.mutation(api.images.createUploadIntent, { sessionId, guestKey, editKey })
  const response = await postUpload(t, intent, bytes)
  expect(response.status).toBe(200)
  return intent
}

beforeEach(() => {
  vi.stubEnv('SITE_URL', APP_ORIGIN)
  vi.stubEnv('CONVEX_CLOUD_URL', STORAGE_ORIGIN)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('binary image header validation (AUD-009)', () => {
  test('decodes valid PNG, JPEG, GIF, and WebP headers and rejects non-images', () => {
    expect(inspectImageBytes(makePngBytes(320, 240))).toEqual({
      mimeType: 'image/png',
      width: 320,
      height: 240,
    })
    expect(inspectImageBytes(makeJpegBytes(640, 480))).toEqual({
      mimeType: 'image/jpeg',
      width: 640,
      height: 480,
    })
    expect(inspectImageBytes(makeGifBytes(128, 64))).toEqual({
      mimeType: 'image/gif',
      width: 128,
      height: 64,
    })
    expect(inspectImageBytes(makeWebpVp8xBytes(512, 256))).toEqual({
      mimeType: 'image/webp',
      width: 512,
      height: 256,
    })
    expect(inspectImageBytes(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull()
    expect(inspectImageBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
  })
})

describe('upload token hashing', () => {
  test('sha256Hex matches known vectors and WebCrypto across block boundaries', async () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const length of [55, 56, 63, 64, 65, 1000]) {
      const input = 'x'.repeat(length)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
      const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      expect(sha256Hex(input)).toBe(expected)
    }
  })
})

// t.fetch loads the HTTP router (including the Better Auth component) on first
// use, which can be slow on a loaded machine.
describe('image upload flow: intent -> POST /uploads/image -> commit (AUD-009)', { timeout: 120_000 }, () => {
  test('owner upload stores server-decoded metadata and the intent is single-use', async () => {
    const ownerAuthId = 'image-owner'
    const { t, ownerId, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    const intent = await owner.mutation(api.images.createUploadIntent, { sessionId })
    expect(intent.uploadToken).toMatch(/^[0-9a-f]{64}$/)
    const stored = await t.run((ctx) => ctx.db.get(intent.intentId))
    // Only the hash is persisted
    expect(stored?.uploadTokenHash).toBe(sha256Hex(intent.uploadToken))
    expect(JSON.stringify(stored)).not.toContain(intent.uploadToken)

    // Lie about the Content-Type; the decoded type wins
    const response = await postUpload(t, intent, makePngBytes(320, 180), {
      'Content-Type': 'text/html',
      Origin: APP_ORIGIN,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN)
    expect(await response.json()).toEqual({ ok: true, mimeType: 'image/png', width: 320, height: 180 })

    const imageId = await owner.mutation(
      api.images.commitImageUpload,
      commitArgs(sessionId, intent, { filename: '../../evil\x00.png' }),
    )

    const { image, blobType, sameBlob } = await t.run(async (ctx) => {
      const image = await ctx.db.get(imageId)
      const intentRow = await ctx.db.get(intent.intentId)
      return {
        image,
        intentRow,
        blobType: image ? (await ctx.storage.get(image.storageId))?.type : undefined,
        sameBlob: image?.storageId === intentRow?.storageId,
      }
    })
    expect(image).toMatchObject({
      userId: ownerId,
      mimeType: 'image/png',
      width: 320,
      height: 180,
      filename: '.._.._evil.png',
    })
    expect(blobType).toBe('image/png')
    expect(sameBlob).toBe(true)

    // Replays: neither the upload endpoint nor commit accept the intent again
    expect((await postUpload(t, intent, makePngBytes(50, 50))).status).toBe(409)
    await expect(
      owner.mutation(api.images.commitImageUpload, commitArgs(sessionId, intent)),
    ).rejects.toThrow('Upload intent already used')
    expect(await storageCount(t)).toBe(2) // seed blob + this upload
  })

  test('denies intents and commits to callers without session edit access', async () => {
    const { t, sessionId } = await seedImages({ ownerAuthId: 'owner' })
    const owner = t.withIdentity({ subject: 'owner' })
    const outsider = t.withIdentity({ subject: 'outsider' })

    await expect(t.mutation(api.images.createUploadIntent, { sessionId })).rejects.toThrow('Unauthorized')
    await expect(outsider.mutation(api.images.createUploadIntent, { sessionId })).rejects.toThrow(
      'Unauthorized',
    )

    // Even holding the owner's intent and token, an outsider can't commit
    const intent = await uploadThroughIntent(t, owner, sessionId)
    await expect(
      outsider.mutation(api.images.commitImageUpload, commitArgs(sessionId, intent)),
    ).rejects.toThrow('Unauthorized')

    const uploaded = await t.run(async (ctx) => (await ctx.db.query('uploadedImages').collect()).length)
    expect(uploaded).toBe(1)
  })

  test('a blob created after the intent by someone else can never be attached or deleted via it', async () => {
    const { t, sessionId: victimSessionId } = await seedImages({ ownerAuthId: 'victim' })
    const attackerSessionId = await t.run(async (ctx) => {
      const attackerId = await ctx.db.insert('users', { authId: 'attacker', email: 'a@example.com' })
      return await ctx.db.insert('paintingSessions', {
        createdBy: attackerId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
    })
    const attacker = t.withIdentity({ subject: 'attacker' })
    const victim = t.withIdentity({ subject: 'victim' })

    // Attacker opens an intent first...
    const attackerIntent = await attacker.mutation(api.images.createUploadIntent, {
      sessionId: attackerSessionId,
    })
    // ...then the victim uploads (not yet committed) and some other workflow
    // (AI output, background removal) stores a blob whose id leaks.
    const victimIntent = await uploadThroughIntent(t, victim, victimSessionId, makePngBytes(77, 77))
    const leakedBlobId = await t.run((ctx) =>
      ctx.storage.store(new Blob([makePngBytes(66, 66)], { type: 'image/png' })),
    )
    const victimBlobId = (await t.run((ctx) => ctx.db.get(victimIntent.intentId)))!.storageId!

    // No storageId is accepted by commit at all
    await expect(
      attacker.mutation(api.images.commitImageUpload, {
        ...commitArgs(attackerSessionId, attackerIntent),
        storageId: leakedBlobId,
      } as never),
    ).rejects.toThrow(/storageId/)
    // Nothing was uploaded through the attacker's intent
    await expect(
      attacker.mutation(api.images.commitImageUpload, commitArgs(attackerSessionId, attackerIntent)),
    ).rejects.toThrow('has not finished')
    // The victim's intent can't be used without its token
    const forged = { intentId: victimIntent.intentId, uploadToken: attackerIntent.uploadToken }
    expect((await postUpload(t, forged, makePngBytes(10, 10))).status).toBe(403)
    await expect(
      attacker.mutation(api.images.commitImageUpload, commitArgs(attackerSessionId, forged)),
    ).rejects.toThrow('Invalid upload intent')

    // Expiring and sweeping the attacker's intent deletes nothing of theirs
    await t.run((ctx) => ctx.db.patch(attackerIntent.intentId, { expiresAt: Date.now() - 1 }))
    await t.mutation(internal.images.cleanupExpiredUploadIntents, {})
    const intact = await t.run(async (ctx) => ({
      victimBlob: (await ctx.storage.get(victimBlobId)) !== null,
      leakedBlob: (await ctx.storage.get(leakedBlobId)) !== null,
    }))
    expect(intact).toEqual({ victimBlob: true, leakedBlob: true })

    // The victim's own commit still binds exactly their blob
    const imageId = await victim.mutation(api.images.commitImageUpload, commitArgs(victimSessionId, victimIntent))
    const image = await t.run((ctx) => ctx.db.get(imageId))
    expect(image?.storageId).toBe(victimBlobId)
    expect(image).toMatchObject({ width: 77, height: 77 })
  })

  test('rejects missing, malformed and mismatched tokens without storing anything', async () => {
    const ownerAuthId = 'token-owner'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })
    const intent = await owner.mutation(api.images.createUploadIntent, { sessionId })
    const before = await storageCount(t)

    const attempts: Array<Record<string, string>> = [
      { 'X-Upload-Token': 'f'.repeat(64) },
      { 'X-Upload-Token': 'not-a-token' },
      { 'X-Upload-Token': '' },
      { 'X-Upload-Intent': 'not-an-id' },
      { 'X-Upload-Intent': '' },
    ]
    for (const headers of attempts) {
      const response = await postUpload(t, intent, makePngBytes(10, 10), headers)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Invalid upload token' })
    }
    await expect(
      owner.mutation(
        api.images.commitImageUpload,
        commitArgs(sessionId, { ...intent, uploadToken: 'f'.repeat(64) }),
      ),
    ).rejects.toThrow('Invalid upload intent')
    expect(await storageCount(t)).toBe(before)

    // The genuine token still works afterwards
    expect((await postUpload(t, intent, makePngBytes(10, 10))).status).toBe(200)
  })

  test('enforces a hard body cap (with or without Content-Length) and validates image bytes', async () => {
    const ownerAuthId = 'upload-validator'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })
    const newIntent = () => owner.mutation(api.images.createUploadIntent, { sessionId })
    const before = await storageCount(t)

    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1)
    oversized.set(makePngBytes(100, 100), 0)

    // 1. Declared Content-Length over the cap is refused before reading
    const declared = await postUpload(t, await newIntent(), makePngBytes(10, 10), {
      'Content-Length': String(MAX_UPLOAD_BYTES + 1),
    })
    expect(declared.status).toBe(413)

    // 2. Oversized body without a Content-Length header
    const noLength = await postUpload(t, await newIntent(), oversized)
    expect(noLength.status).toBe(413)

    // 3. Oversized chunked stream (a lying/absent length can't bypass the cap)
    const chunk = new Uint8Array(1024 * 1024)
    chunk.set(makePngBytes(100, 100), 0)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPLOAD_BYTES) {
          controller.close()
          return
        }
        sent += chunk.byteLength
        controller.enqueue(chunk.slice())
      },
    })
    const intent = await newIntent()
    const streamed = await t.fetch('/uploads/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-Upload-Intent': intent.intentId,
        'X-Upload-Token': intent.uploadToken,
      },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    expect(streamed.status).toBe(413)

    // 4. Spoofed HTML labelled image/png
    const html = await postUpload(
      t,
      await newIntent(),
      new TextEncoder().encode('<html><script>alert(1)</script></html>'),
    )
    expect(html.status).toBe(415)

    // 5. Oversized dimensions, 6. empty body
    expect((await postUpload(t, await newIntent(), makePngBytes(5000, 5000))).status).toBe(422)
    expect((await postUpload(t, await newIntent(), new Uint8Array(0))).status).toBe(400)

    // Nothing was stored for any rejected upload
    expect(await storageCount(t)).toBe(before)

    // Exactly at the cap is accepted
    const atCap = new Uint8Array(MAX_UPLOAD_BYTES)
    atCap.set(makePngBytes(100, 100), 0)
    expect((await postUpload(t, await newIntent(), atCap)).status).toBe(200)
  })

  test('two uploads on one intent keep exactly one blob', async () => {
    const ownerAuthId = 'double-uploader'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })
    const intent = await owner.mutation(api.images.createUploadIntent, { sessionId })
    const before = await storageCount(t)

    const responses = await Promise.all([
      postUpload(t, intent, makePngBytes(11, 11)),
      postUpload(t, intent, makePngBytes(22, 22)),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await storageCount(t)).toBe(before + 1)

    const intentRow = await t.run((ctx) => ctx.db.get(intent.intentId))
    expect(await t.run(async (ctx) => (await ctx.storage.get(intentRow!.storageId!)) !== null)).toBe(true)

    // A racing upload that passed the pre-body check still loses at attach
    // time, and its freshly stored blob is deleted in that transaction
    const loserBlobId = await t.run((ctx) =>
      ctx.storage.store(new Blob([makePngBytes(33, 33)], { type: 'image/png' })),
    )
    const result = await t.mutation(internal.images.attachUploadToIntent, {
      intentId: intent.intentId,
      uploadTokenHash: sha256Hex(intent.uploadToken),
      storageId: loserBlobId,
      mimeType: 'image/png',
      width: 33,
      height: 33,
    })
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'An image was already uploaded for this intent',
    })
    const after = await t.run(async (ctx) => ({
      loserBlob: (await ctx.storage.get(loserBlobId)) !== null,
      winnerStillAttached: (await ctx.db.get(intent.intentId))?.storageId === intentRow!.storageId,
    }))
    expect(after).toEqual({ loserBlob: false, winnerStillAttached: true })
  })

  test('expired intents are refused and their uploaded blobs are deleted by the cleanup', async () => {
    const ownerAuthId = 'intent-owner'
    const { t, sessionId, storageId: seedBlobId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    // Upload refused on an expired intent, nothing stored
    const expired = await owner.mutation(api.images.createUploadIntent, { sessionId })
    await t.run((ctx) => ctx.db.patch(expired.intentId, { expiresAt: Date.now() - 1 }))
    const before = await storageCount(t)
    expect((await postUpload(t, expired, makePngBytes(10, 10))).status).toBe(410)
    expect(await storageCount(t)).toBe(before)

    // Uploaded-but-never-committed, committed, and empty intents
    const abandoned = await uploadThroughIntent(t, owner, sessionId)
    const committed = await uploadThroughIntent(t, owner, sessionId)
    const committedImageId = await owner.mutation(
      api.images.commitImageUpload,
      commitArgs(sessionId, committed),
    )
    const blobs = await t.run(async (ctx) => ({
      abandoned: (await ctx.db.get(abandoned.intentId))!.storageId!,
      committed: (await ctx.db.get(committed.intentId))!.storageId!,
    }))
    await t.run(async (ctx) => {
      for (const id of [abandoned.intentId, committed.intentId]) {
        await ctx.db.patch(id, { expiresAt: Date.now() - 1 })
      }
    })
    await expect(
      owner.mutation(api.images.commitImageUpload, commitArgs(sessionId, abandoned)),
    ).rejects.toThrow('Upload intent expired')

    expect(await t.mutation(internal.images.cleanupExpiredUploadIntents, {})).toEqual({
      abandoned: 2, // `expired` (no blob) and `abandoned`
      purged: 0,
    })
    const afterSweep = await t.run(async (ctx) => ({
      abandonedBlob: (await ctx.storage.get(blobs.abandoned)) !== null,
      committedBlob: (await ctx.storage.get(blobs.committed)) !== null,
      seedBlob: (await ctx.storage.get(seedBlobId)) !== null,
      abandonedRow: await ctx.db.get(abandoned.intentId),
      image: await ctx.db.get(committedImageId),
    }))
    expect(afterSweep.abandonedBlob).toBe(false)
    expect(afterSweep.committedBlob).toBe(true)
    expect(afterSweep.seedBlob).toBe(true)
    expect(afterSweep.image).not.toBeNull()
    // The row is kept (blob-free) so it still counts toward the hourly limit
    expect(afterSweep.abandonedRow?.storageId).toBeUndefined()
    expect(afterSweep.abandonedRow?.abandonedAt).toBeTypeOf('number')

    // Once the rate window has passed, rows are purged; image blobs survive
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('imageUploadIntents').collect()) {
        await ctx.db.patch(row._id, { expiresAt: Date.now() - UPLOAD_RATE_WINDOW_MS - 1 })
      }
    })
    expect(await t.mutation(internal.images.cleanupExpiredUploadIntents, {})).toEqual({
      abandoned: 0,
      purged: 3,
    })
    expect(await t.run(async (ctx) => (await ctx.storage.get(blobs.committed)) !== null)).toBe(true)
  })

  test('a failed commit leaves the blob on the intent for the cleanup to delete', async () => {
    const ownerAuthId = 'commit-failer'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })
    const intent = await uploadThroughIntent(t, owner, sessionId)

    await expect(
      owner.mutation(api.images.commitImageUpload, commitArgs(sessionId, intent, { x: Number.NaN })),
    ).rejects.toThrow('x must be a finite number')
    const row = await t.run((ctx) => ctx.db.get(intent.intentId))
    expect(row?.consumedAt).toBeUndefined()
    const blobId = row!.storageId!

    await t.run((ctx) => ctx.db.patch(intent.intentId, { expiresAt: Date.now() - 1 }))
    await t.mutation(internal.images.cleanupExpiredUploadIntents, {})
    expect(await t.run(async (ctx) => (await ctx.storage.get(blobId)) === null)).toBe(true)
    expect(await t.run(async (ctx) => (await ctx.db.query('uploadedImages').collect()).length)).toBe(1)
  })

  test('cleanup works in bounded batches and reschedules itself while work remains', async () => {
    const { t, sessionId } = await seedImages({ ownerAuthId: 'batch-owner' })
    await t.run(async (ctx) => {
      const past = Date.now() - 1_000
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert('imageUploadIntents', { sessionId, createdAt: past, expiresAt: past })
      }
    })
    expect(await t.mutation(internal.images.cleanupExpiredUploadIntents, {})).toEqual({
      abandoned: 100,
      purged: 0,
    })
    const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(scheduled.map((job) => job.name)).toContain('images:cleanupExpiredUploadIntents')
  })

  test('rate-limits open intents and intents per hour per user, guest owner and public session', async () => {
    const ownerAuthId = 'rate-owner'
    const { t, ownerId, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    // Open (unexpired, uncommitted) intents are capped, across sessions
    const otherSessionId = await t.run((ctx) =>
      ctx.db.insert('paintingSessions', {
        createdBy: ownerId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      }),
    )
    const open: Intent[] = []
    for (let i = 0; i < MAX_OPEN_UPLOAD_INTENTS; i++) {
      open.push(await owner.mutation(api.images.createUploadIntent, { sessionId: i % 2 ? sessionId : otherSessionId }))
    }
    await expect(owner.mutation(api.images.createUploadIntent, { sessionId })).rejects.toThrow(
      'Too many uploads in progress',
    )
    // Finishing one frees a slot
    await postUpload(t, open[0], makePngBytes(10, 10))
    await owner.mutation(
      api.images.commitImageUpload,
      commitArgs(otherSessionId, open[0]),
    )
    await owner.mutation(api.images.createUploadIntent, { sessionId })

    // Hourly cap counts every intent created in the window, consumed or not
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 0; i < MAX_UPLOAD_INTENTS_PER_WINDOW; i++) {
        await ctx.db.insert('imageUploadIntents', {
          sessionId,
          userId: ownerId,
          rateKey: `user:${ownerId}`,
          createdAt: now - 30 * 60 * 1000,
          expiresAt: now - 20 * 60 * 1000,
          consumedAt: now - 25 * 60 * 1000,
        })
      }
    })
    await expect(owner.mutation(api.images.createUploadIntent, { sessionId })).rejects.toThrow(
      'Too many image uploads',
    )

    // Anonymous edit-link holders share one bucket: random (non-matching)
    // guest keys don't create new buckets
    const pubEditKey = 'pub-edit-key'
    const { t: pub, sessionId: publicSessionId } = await seedImages({
      isPublic: true,
      editKey: pubEditKey,
    })
    for (let i = 0; i < MAX_OPEN_UPLOAD_INTENTS; i++) {
      await pub.mutation(api.images.createUploadIntent, {
        sessionId: publicSessionId,
        guestKey: `random-${i}`,
        editKey: pubEditKey,
      })
    }
    await expect(
      pub.mutation(api.images.createUploadIntent, {
        sessionId: publicSessionId,
        guestKey: 'random-x',
        editKey: pubEditKey,
      }),
    ).rejects.toThrow('Too many uploads in progress')

    // A guest owner has their own bucket
    const { t: guest, sessionId: guestSessionId } = await seedImages({ guestOwnerKey: 'guest-key' })
    const guestIntent = await guest.mutation(api.images.createUploadIntent, {
      sessionId: guestSessionId,
      guestKey: 'guest-key',
    })
    const guestRow = await guest.run((ctx) => ctx.db.get(guestIntent.intentId))
    expect(guestRow?.rateKey).toBe(`guest:${guestSessionId}`)
    expect(JSON.stringify(guestRow)).not.toContain('guest-key')
  })

  test('answers CORS preflight only for the app origin and refuses other browser origins', async () => {
    const { t, sessionId } = await seedImages({ ownerAuthId: 'cors-owner' })
    const owner = t.withIdentity({ subject: 'cors-owner' })

    const preflight = await t.fetch('/uploads/image', {
      method: 'OPTIONS',
      headers: {
        Origin: APP_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-upload-intent,x-upload-token',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN)
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('X-Upload-Token')
    expect(preflight.headers.get('Vary')).toContain('Origin')

    const evilPreflight = await t.fetch('/uploads/image', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(evilPreflight.status).toBe(403)
    expect(evilPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull()

    // Preview frontends are allowed via PREVIEW_URL
    vi.stubEnv('PREVIEW_URL', 'https://preview-pr-7.wepaint.ai')
    const previewPreflight = await t.fetch('/uploads/image', {
      method: 'OPTIONS',
      headers: { Origin: 'https://preview-pr-7.wepaint.ai', 'Access-Control-Request-Method': 'POST' },
    })
    expect(previewPreflight.headers.get('Access-Control-Allow-Origin')).toBe('https://preview-pr-7.wepaint.ai')

    const intent = await owner.mutation(api.images.createUploadIntent, { sessionId })
    const evil = await postUpload(t, intent, makePngBytes(10, 10), { Origin: 'https://evil.example' })
    expect(evil.status).toBe(403)

    // Error responses carry CORS headers so the app can read the message
    const error = await postUpload(t, intent, new Uint8Array(0), { Origin: APP_ORIGIN })
    expect(error.status).toBe(400)
    expect(error.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN)
  })

  test('requires the matching guest key and permits every image mutation with it', async () => {
    const guestKey = 'guest-image-key'
    const { t, sessionId, uploadedImageId, aiImageId } =
      await seedImages({ guestOwnerKey: guestKey })

    await expect(
      t.mutation(api.images.updateImageTransform, {
        imageId: uploadedImageId,
        x: 75,
        guestKey: 'wrong-key',
      }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      t.mutation(api.images.createUploadIntent, { sessionId, guestKey: 'wrong-key' }),
    ).rejects.toThrow('Unauthorized')

    const intent = await uploadThroughIntent(t, t, sessionId, makePngBytes(120, 90), guestKey)
    await expect(
      t.mutation(api.images.commitImageUpload, commitArgs(sessionId, intent, { guestKey: 'wrong-key' })),
    ).rejects.toThrow('Unauthorized')
    await t.mutation(api.images.commitImageUpload, commitArgs(sessionId, intent, { guestKey }))
    await t.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      imageUrl: `${STORAGE_ORIGIN}/api/storage/guest-ai`,
      width: 100,
      height: 100,
      guestKey,
    })
    await t.mutation(api.images.updateImageTransform, {
      imageId: uploadedImageId,
      x: 75,
      guestKey,
    })
    await t.mutation(api.images.updateAIImageTransform, {
      imageId: aiImageId,
      opacity: 0.5,
      guestKey,
    })
    await t.mutation(api.images.updateImageLayerOrder, {
      imageId: uploadedImageId,
      newLayerOrder: 2,
      guestKey,
    })
    await t.mutation(api.images.updateAIImageLayerOrder, {
      imageId: aiImageId,
      newLayerOrder: 0,
      guestKey,
    })
    await t.mutation(api.images.deleteImage, { imageId: uploadedImageId, guestKey })
    await t.mutation(api.images.deleteAIImage, { imageId: aiImageId, guestKey })

    const deleted = await t.run(async (ctx) => ({
      uploaded: await ctx.db.get(uploadedImageId),
      ai: await ctx.db.get(aiImageId),
    }))
    expect(deleted).toEqual({ uploaded: null, ai: null })
  })

  test('keeps public sessions read-only for images and allows collaboration with valid editKey', async () => {
    const editKey = 'public-image-collab-key'
    const { t, sessionId, uploadedImageId } = await seedImages({ isPublic: true, editKey })

    // Public viewer can read images
    const images = await t.query(api.images.getSessionImages, { sessionId })
    expect(images).toHaveLength(2)

    // Public viewer without (or with a wrong/empty) editKey cannot upload or transform
    for (const badKey of [undefined, '', 'wrong-key']) {
      await expect(
        t.mutation(api.images.createUploadIntent, { sessionId, editKey: badKey }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        t.mutation(api.images.updateImageTransform, {
          imageId: uploadedImageId,
          rotation: 45,
          editKey: badKey,
        }),
      ).rejects.toThrow('Unauthorized')
    }
    const ownerIntent = await t.run(async (ctx) => {
      const now = Date.now()
      return ctx.db.insert('imageUploadIntents', {
        sessionId,
        createdAt: now,
        expiresAt: now + 60_000,
        uploadTokenHash: 'x'.repeat(64),
        rateKey: `anon:${sessionId}`,
      })
    })
    await expect(
      t.mutation(api.images.commitImageUpload, {
        sessionId,
        intentId: ownerIntent,
        uploadToken: 'tok',
        filename: 'x.png',
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow('Unauthorized')

    // Collaborator with valid editKey can upload, commit and transform
    const intent = await uploadThroughIntent(t, t, sessionId, makePngBytes(120, 90), undefined, editKey)
    const imageId = await t.mutation(
      api.images.commitImageUpload,
      commitArgs(sessionId, intent, { editKey }),
    )
    expect((await t.run((ctx) => ctx.db.get(imageId)))?.userId).toBeUndefined()
    await t.mutation(api.images.updateImageTransform, {
      imageId: uploadedImageId,
      rotation: 45,
      editKey,
    })

    const image = await t.run(async (ctx) => ctx.db.get(uploadedImageId))
    expect(image?.rotation).toBe(45)
  })
})

describe('retired upload API (stale tabs)', () => {
  test('generateUploadUrl and uploadImage fail loudly with a reload prompt', async () => {
    const { t, sessionId, storageId } = await seedImages({ ownerAuthId: 'stale-owner' })
    const owner = t.withIdentity({ subject: 'stale-owner' })

    await expect(owner.mutation(api.images.generateUploadUrl, { sessionId })).rejects.toThrow(
      'Please reload the page to upload images',
    )
    await expect(
      owner.mutation(api.images.uploadImage, {
        sessionId,
        storageId,
        filename: 'old.png',
        mimeType: 'image/png',
        width: 100,
        height: 100,
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow('Please reload the page to upload images')
    expect(await t.run(async (ctx) => (await ctx.db.query('uploadedImages').collect()).length)).toBe(1)
  })
})

describe('image mutation authorization', () => {
  test('denies all record-based mutations without destructive side effects', async () => {
    const { t, uploadedImageId, aiImageId, storageId, strokeId } =
      await seedImages({ ownerAuthId: 'owner' })
    const outsider = t.withIdentity({ subject: 'outsider' })

    const attempts = [
      () => outsider.mutation(api.images.updateImageTransform, {
        imageId: uploadedImageId,
        x: 999,
      }),
      () => outsider.mutation(api.images.updateAIImageTransform, {
        imageId: aiImageId,
        opacity: 0,
      }),
      () => outsider.mutation(api.images.updateImageLayerOrder, {
        imageId: uploadedImageId,
        newLayerOrder: 9,
      }),
      () => outsider.mutation(api.images.updateAIImageLayerOrder, {
        imageId: aiImageId,
        newLayerOrder: 9,
      }),
      () => outsider.mutation(api.images.deleteImage, { imageId: uploadedImageId }),
      () => outsider.mutation(api.images.deleteAIImage, { imageId: aiImageId }),
    ]
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow('Unauthorized')
    }

    const state = await t.run(async (ctx) => ({
      uploaded: await ctx.db.get(uploadedImageId),
      ai: await ctx.db.get(aiImageId),
      stroke: await ctx.db.get(strokeId),
      hasBlob: (await ctx.storage.get(storageId)) !== null,
    }))
    expect(state.uploaded).toMatchObject({ x: 50, layerOrder: 1 })
    expect(state.ai).toMatchObject({ opacity: 1, layerOrder: 2 })
    expect(state.stroke).not.toBeNull()
    expect(state.hasBlob).toBe(true)
  })

  test('addAIGeneratedImage accepts only this deployment\'s storage (or provider CDN) URLs and bounds sizes', async () => {
    const ownerAuthId = 'ai-owner'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })
    const add = (imageUrl: string, extra: Record<string, number> = {}) =>
      owner.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        imageUrl,
        width: 200,
        height: 100,
        ...extra,
      })

    const storageImageId = await add(`${STORAGE_ORIGIN}/api/storage/abc-123`, {
      canvasWidth: 1e12,
      canvasHeight: Number.NaN,
    })
    const stored = await t.run((ctx) => ctx.db.get(storageImageId))
    expect(stored?.imageUrl).toBe(`${STORAGE_ORIGIN}/api/storage/abc-123`)
    // Absurd client canvas hints are clamped / replaced by the session's
    expect(stored!.x).toBeLessThanOrEqual(8192 / 2)
    expect(Number.isFinite(stored!.y)).toBe(true)

    await add('https://pbxt.replicate.delivery/out/result.png')

    for (const bad of [
      'https://example.com/tracker.png',
      `${STORAGE_ORIGIN}/not-storage/abc`,
      'https://some-deployment.convex.cloud.evil.example/api/storage/x',
      'https://user:pass@pbxt.replicate.delivery/x.png',
      'http://pbxt.replicate.delivery/x.png',
      'javascript:alert(1)',
      'not a url',
    ]) {
      await expect(add(bad)).rejects.toThrow(/image URL|Image URL/)
    }
    await expect(add(`${STORAGE_ORIGIN}/api/storage/x`, { width: 0 })).rejects.toThrow('Image dimensions')
    await expect(add(`${STORAGE_ORIGIN}/api/storage/x`, { width: 9000 })).rejects.toThrow('Image dimensions')

    const outsider = t.withIdentity({ subject: 'outsider' })
    await expect(
      outsider.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        imageUrl: `${STORAGE_ORIGIN}/api/storage/abc`,
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('Unauthorized')
  })
})
