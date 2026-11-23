import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { inspectImageBytes, MAX_UPLOAD_BYTES } from './imageValidation'
import schema from './schema'
import { modules } from './test.setup'

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

function uploadArgs(
  sessionId: Id<'paintingSessions'>,
  intentId: Id<'imageUploadIntents'>,
  storageId: Id<'_storage'>,
) {
  return {
    sessionId,
    intentId,
    storageId,
    filename: 'new.png',
    mimeType: 'image/png',
    width: 200,
    height: 100,
    x: 400,
    y: 300,
  }
}

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

describe('image mutation authorization and upload security (AUD-009)', () => {
  test('allows the signed-in owner, derives attribution & true image metadata server-side', async () => {
    const ownerAuthId = 'image-owner'
    const { t, ownerId, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    const { uploadUrl, intentId } = await owner.mutation(api.images.generateUploadUrl, { sessionId })
    expect(uploadUrl).toContain('/api/storage/upload')

    const freshStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([makePngBytes(320, 180)], { type: 'image/png' })),
    )

    // Pass deliberately forged client mimeType/width/height/filename; server must store decoded metadata
    const uploadedImageId = await owner.action(api.images.uploadImage, {
      ...uploadArgs(sessionId, intentId, freshStorageId),
      filename: '../../evil\x00.png',
      mimeType: 'image/gif',
      width: 999999,
      height: 0,
    })

    await owner.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      imageUrl: 'https://example.com/new-ai.png',
      width: 200,
      height: 100,
    })

    const uploadedImage = await t.run(async (ctx) => ctx.db.get(uploadedImageId))
    expect(uploadedImage).toMatchObject({
      userId: ownerId,
      mimeType: 'image/png',
      width: 320,
      height: 180,
      filename: '.._.._evil.png',
    })

    // Replaying the same single-use intentId must fail
    const anotherStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([makePngBytes(50, 50)], { type: 'image/png' })),
    )
    await expect(
      owner.action(api.images.uploadImage, uploadArgs(sessionId, intentId, anotherStorageId)),
    ).rejects.toThrow('Upload intent already used')
  })

  test('denies private direct-session mutations before creating records or upload URLs', async () => {
    const { t, sessionId, storageId } = await seedImages({ ownerAuthId: 'owner' })
    const owner = t.withIdentity({ subject: 'owner' })
    const outsider = t.withIdentity({ subject: 'outsider' })

    const { intentId } = await owner.mutation(api.images.generateUploadUrl, { sessionId })

    await expect(
      t.mutation(api.images.generateUploadUrl, { sessionId }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      outsider.action(api.images.uploadImage, uploadArgs(sessionId, intentId, storageId)),
    ).rejects.toThrow('Unauthorized')
    await expect(
      outsider.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        imageUrl: 'https://example.com/unauthorized.png',
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('Unauthorized')

    const counts = await t.run(async (ctx) => ({
      uploaded: (await ctx.db.query('uploadedImages').collect()).length,
      ai: (await ctx.db.query('aiGeneratedImages').collect()).length,
    }))
    expect(counts).toEqual({ uploaded: 1, ai: 1 })
  })

  test('rejects cross-session and pre-existing storageId attachment without deleting victim blobs', async () => {
    const { t, sessionId: victimSessionId, storageId: victimStorageId } = await seedImages({
      ownerAuthId: 'victim',
    })

    const { attackerSessionId, unattachedVictimStorageId } = await t.run(async (ctx) => {
      const attackerId = await ctx.db.insert('users', {
        authId: 'attacker',
        email: 'attacker@example.com',
      })
      const attackerSessionId = await ctx.db.insert('paintingSessions', {
        createdBy: attackerId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      // Unattached blob created BEFORE attacker requests an upload intent
      const unattachedVictimStorageId = await ctx.storage.store(
        new Blob([makePngBytes(80, 80)], { type: 'image/png' }),
      )
      return { attackerSessionId, unattachedVictimStorageId }
    })

    const attacker = t.withIdentity({ subject: 'attacker' })
    const { intentId } = await attacker.mutation(api.images.generateUploadUrl, {
      sessionId: attackerSessionId,
    })

    // 1. Already-attached storageId from victim session must fail
    await expect(
      attacker.action(
        api.images.uploadImage,
        uploadArgs(attackerSessionId, intentId, victimStorageId),
      ),
    ).rejects.toThrow('Storage object is already registered')

    // 2. Unattached pre-existing storageId created before intent must fail
    await expect(
      attacker.action(
        api.images.uploadImage,
        uploadArgs(attackerSessionId, intentId, unattachedVictimStorageId),
      ),
    ).rejects.toThrow('Storage object does not match this upload intent')

    // 3. Intent issued for attackerSessionId cannot be redeemed on victimSessionId
    await expect(
      attacker.action(
        api.images.uploadImage,
        uploadArgs(victimSessionId, intentId, unattachedVictimStorageId),
      ),
    ).rejects.toThrow('Unauthorized')

    // Victim blobs remain intact
    const victimIntact = await t.run(async (ctx) => ({
      victimBlob: (await ctx.storage.get(victimStorageId)) !== null,
      unattachedBlob: (await ctx.storage.get(unattachedVictimStorageId)) !== null,
    }))
    expect(victimIntact).toEqual({ victimBlob: true, unattachedBlob: true })
  })

  test('rejects spoofed non-images, oversized files, and oversized dimensions and deletes rejected blobs', async () => {
    const ownerAuthId = 'upload-validator'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    // 1. Spoofed HTML payload with Content-Type: image/png
    const intentHtml = await owner.mutation(api.images.generateUploadUrl, { sessionId })
    const htmlStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' })),
    )
    await expect(
      owner.action(api.images.uploadImage, uploadArgs(sessionId, intentHtml.intentId, htmlStorageId)),
    ).rejects.toThrow('not a valid PNG, JPEG, GIF, or WebP image')
    expect(await t.run((ctx) => ctx.storage.get(htmlStorageId))).toBeNull()

    // 2. Oversized file (> 5 MiB)
    const intentBig = await owner.mutation(api.images.generateUploadUrl, { sessionId })
    const bigBytes = new Uint8Array(MAX_UPLOAD_BYTES + 1024)
    bigBytes.set(makePngBytes(100, 100), 0)
    const bigStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([bigBytes], { type: 'image/png' })),
    )
    await expect(
      owner.action(api.images.uploadImage, uploadArgs(sessionId, intentBig.intentId, bigStorageId)),
    ).rejects.toThrow('at most 5MB')
    expect(await t.run((ctx) => ctx.storage.get(bigStorageId))).toBeNull()

    // 3. Oversized dimensions (> 4096px)
    const intentHugeDim = await owner.mutation(api.images.generateUploadUrl, { sessionId })
    const hugeDimStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([makePngBytes(5000, 5000)], { type: 'image/png' })),
    )
    await expect(
      owner.action(
        api.images.uploadImage,
        uploadArgs(sessionId, intentHugeDim.intentId, hugeDimStorageId),
      ),
    ).rejects.toThrow('must not exceed 4096px')
    expect(await t.run((ctx) => ctx.storage.get(hugeDimStorageId))).toBeNull()
  })

  test('rejects expired intents, cleans up abandoned intents, and validates addAIGeneratedImage', async () => {
    const ownerAuthId = 'intent-owner'
    const { t, sessionId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    const { intentId } = await owner.mutation(api.images.generateUploadUrl, { sessionId })
    const storageId = await t.run(async (ctx) => {
      await ctx.db.patch(intentId, { expiresAt: Date.now() - 1_000 })
      return await ctx.storage.store(new Blob([makePngBytes(40, 40)], { type: 'image/png' }))
    })

    await expect(
      owner.action(api.images.uploadImage, uploadArgs(sessionId, intentId, storageId)),
    ).rejects.toThrow('Upload intent expired')

    const cleaned = await t.mutation(internal.images.cleanupExpiredUploadIntents, {})
    expect(cleaned).toBe(1)
    expect(await t.run((ctx) => ctx.db.get(intentId))).toBeNull()

    // addAIGeneratedImage rejects javascript: URLs and zero dimensions
    await expect(
      owner.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        imageUrl: 'javascript:alert(1)',
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('HTTPS')
    await expect(
      owner.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        imageUrl: 'https://example.com/valid.png',
        width: 0,
        height: 100,
      }),
    ).rejects.toThrow('Image dimensions')
  })

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

    const { uploadUrl, intentId } = await t.mutation(api.images.generateUploadUrl, {
      sessionId,
      guestKey,
    })
    expect(uploadUrl).toContain('/api/storage/upload')

    const newStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([makePngBytes(120, 90)], { type: 'image/png' })),
    )
    await t.action(api.images.uploadImage, {
      ...uploadArgs(sessionId, intentId, newStorageId),
      guestKey,
    })
    await t.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      imageUrl: 'https://example.com/guest-ai.png',
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

  test('preserves anonymous collaboration for public sessions', async () => {
    const { t, sessionId, uploadedImageId } = await seedImages({ isPublic: true })

    const { uploadUrl } = await t.mutation(api.images.generateUploadUrl, { sessionId })
    expect(uploadUrl).toContain('/api/storage/upload')
    await t.mutation(api.images.updateImageTransform, {
      imageId: uploadedImageId,
      rotation: 45,
    })

    const image = await t.run(async (ctx) => ctx.db.get(uploadedImageId))
    expect(image?.rotation).toBe(45)
  })
})
