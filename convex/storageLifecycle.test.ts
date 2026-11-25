import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import {
  DELETED_SESSION_GRACE_MS,
  PURGE_DOCS_PER_RUN,
  PURGE_DOCS_PER_SESSION_TURN,
} from './paintingSessions'
import schema from './schema'
import {
  ORPHAN_BLOB_TTL_MS,
  ORPHAN_SWEEP_BATCH_SIZE,
  STALE_OPERATION_TIMEOUT_MS,
} from './storageLifecycle'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

function makePngBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(32))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 64, false)
  view.setUint32(20, 64, false)
  return bytes
}

const VALID_BASE64_PNG = btoa('P'.repeat(160))

beforeEach(() => {
  vi.stubEnv('REPLICATE_POLL_INTERVAL_MS', '5')
  vi.stubEnv('REPLICATE_TIMEOUT_SECONDS', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AUD-010 cascading session purge (purgeDeletedSessions)', { timeout: 120_000 }, () => {
  test('removes all child tables and storage blobs for expired sessions while preserving live and in-grace sessions', async () => {
    const t = createTestBackend()
    const now = Date.now()
    const expiredDeletedAt = now - DELETED_SESSION_GRACE_MS - 60_000
    const recentDeletedAt = now - 60_000

    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        authId: 'purge-owner',
        email: 'purge@example.com',
        tokens: 10,
      })

      const expiredSessionId = await ctx.db.insert('paintingSessions', {
        name: 'Expired',
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 2,
        deletedAt: expiredDeletedAt,
      })
      const graceSessionId = await ctx.db.insert('paintingSessions', {
        name: 'Within grace',
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
        deletedAt: recentDeletedAt,
      })
      const liveSessionId = await ctx.db.insert('paintingSessions', {
        name: 'Live',
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })

      // Blobs owned by the expired session across every storage-bearing table
      const uploadedBlob = await ctx.storage.store(new Blob(['uploaded']))
      const genSnapshotBlob = await ctx.storage.store(new Blob(['snapshot']))
      const genSharedOutputBlob = await ctx.storage.store(new Blob(['gen-shared']))
      const standaloneAIBlob = await ctx.storage.store(new Blob(['ai-standalone']))
      const mergeBlob = await ctx.storage.store(new Blob(['merge-output']))
      const removalBlob = await ctx.storage.store(new Blob(['removal-output']))
      const unattachedIntentBlob = await ctx.storage.store(new Blob(['intent-abandoned']))

      // Blobs owned by live/grace sessions that MUST survive purge
      const graceBlob = await ctx.storage.store(new Blob(['grace-ai']))
      const liveBlob = await ctx.storage.store(new Blob(['live-upload']))

      await ctx.db.insert('uploadedImages', {
        sessionId: expiredSessionId,
        userId,
        storageId: uploadedBlob,
        filename: 'a.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
      })

      await ctx.db.insert('imageUploadIntents', {
        sessionId: expiredSessionId,
        userId,
        createdAt: expiredDeletedAt,
        expiresAt: expiredDeletedAt + 60_000,
        consumedAt: expiredDeletedAt + 1_000,
        storageId: uploadedBlob,
      })
      await ctx.db.insert('imageUploadIntents', {
        sessionId: expiredSessionId,
        userId,
        createdAt: expiredDeletedAt,
        expiresAt: now + 60_000,
        storageId: unattachedIntentBlob,
      })

      const genId = await ctx.db.insert('aiGenerations', {
        sessionId: expiredSessionId,
        userId: 'purge-owner',
        prompt: 'sunset',
        status: 'completed',
        provider: 'replicate',
        canvasSnapshotId: genSnapshotBlob,
        generatedImageId: genSharedOutputBlob,
        resultImageUrl: 'https://example.com/gen.png',
        createdAt: expiredDeletedAt,
      })

      await ctx.db.insert('aiGeneratedImages', {
        sessionId: expiredSessionId,
        imageUrl: 'https://example.com/gen.png',
        storageId: genSharedOutputBlob,
        width: 100,
        height: 100,
        x: 50,
        y: 50,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 2,
        createdAt: expiredDeletedAt,
      })
      await ctx.db.insert('aiGeneratedImages', {
        sessionId: expiredSessionId,
        imageUrl: 'https://example.com/standalone.png',
        storageId: standaloneAIBlob,
        width: 100,
        height: 100,
        x: 50,
        y: 50,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 3,
        createdAt: expiredDeletedAt,
      })

      await ctx.db.insert('imageMerges', {
        sessionId: expiredSessionId,
        userId: 'purge-owner',
        firstLayerId: 'layer-1',
        secondLayerId: 'layer-2',
        mergeMode: 'full',
        status: 'completed',
        resultImageUrl: 'https://example.com/merged.png',
        mergedImageStorageId: mergeBlob,
        createdAt: expiredDeletedAt,
      })

      await ctx.db.insert('backgroundRemovals', {
        sessionId: expiredSessionId,
        userId: 'purge-owner',
        status: 'completed',
        resultImageUrl: 'https://example.com/removed.png',
        resultStorageId: removalBlob,
        createdAt: expiredDeletedAt,
      })

      // Non-storage child tables for expired session
      await ctx.db.insert('paintLayers', {
        sessionId: expiredSessionId,
        name: 'Layer 1',
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdBy: userId,
        createdAt: expiredDeletedAt,
      })
      await ctx.db.insert('strokes', {
        sessionId: expiredSessionId,
        userId,
        userColor: '#000',
        points: [{ x: 1, y: 1 }],
        brushColor: '#000',
        brushSize: 4,
        opacity: 1,
        strokeOrder: 1,
      })
      await ctx.db.insert('deletedStrokes', {
        sessionId: expiredSessionId,
        userId,
        userColor: '#000',
        points: [{ x: 2, y: 2 }],
        brushColor: '#000',
        brushSize: 4,
        opacity: 1,
        strokeOrder: 2,
        deletedAt: expiredDeletedAt,
      })
      await ctx.db.insert('liveStrokes', {
        sessionId: expiredSessionId,
        userId,
        userColor: '#000',
        userName: 'User',
        points: [{ x: 3, y: 3 }],
        brushColor: '#000',
        brushSize: 4,
        opacity: 1,
        lastUpdated: expiredDeletedAt,
      })
      await ctx.db.insert('userPresence', {
        sessionId: expiredSessionId,
        userId,
        userColor: '#000',
        userName: 'User',
        cursorX: 0,
        cursorY: 0,
        isDrawing: false,
        currentTool: 'brush',
        lastSeen: expiredDeletedAt,
      })
      await ctx.db.insert('viewerStates', {
        sessionId: expiredSessionId,
        viewerId: 'viewer-1',
        lastAckedStrokeOrder: 1,
      })
      await ctx.db.insert('webrtcSignals', {
        sessionId: expiredSessionId,
        fromPeerId: 'a',
        toPeerId: 'b',
        type: 'offer',
        data: {},
        timestamp: expiredDeletedAt,
      })

      // Billing ledger row must NOT be deleted when session is purged
      const txId = await ctx.db.insert('tokenTransactions', {
        userId,
        type: 'usage',
        amount: -1,
        balance: 9,
        description: 'AI image generation',
        metadata: { aiGenerationId: genId, sessionId: expiredSessionId },
        createdAt: expiredDeletedAt,
      })

      // Grace + live session assets
      await ctx.db.insert('aiGeneratedImages', {
        sessionId: graceSessionId,
        imageUrl: 'https://example.com/grace.png',
        storageId: graceBlob,
        width: 64,
        height: 64,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
        createdAt: recentDeletedAt,
      })
      await ctx.db.insert('uploadedImages', {
        sessionId: liveSessionId,
        userId,
        storageId: liveBlob,
        filename: 'live.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
      })

      return {
        expiredSessionId,
        graceSessionId,
        liveSessionId,
        txId,
        expiredBlobs: [
          uploadedBlob,
          genSnapshotBlob,
          genSharedOutputBlob,
          standaloneAIBlob,
          mergeBlob,
          removalBlob,
          unattachedIntentBlob,
        ],
        survivingBlobs: [graceBlob, liveBlob],
      }
    })

    await t.mutation(internal.paintingSessions.purgeDeletedSessions, {})

    const after = await t.run(async (ctx) => ({
      expiredSession: await ctx.db.get(seeded.expiredSessionId),
      graceSession: await ctx.db.get(seeded.graceSessionId),
      liveSession: await ctx.db.get(seeded.liveSessionId),
      tx: await ctx.db.get(seeded.txId),
      expiredUploads: await ctx.db
        .query('uploadedImages')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredGenerations: await ctx.db
        .query('aiGenerations')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredAIImages: await ctx.db
        .query('aiGeneratedImages')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredMerges: await ctx.db
        .query('imageMerges')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredRemovals: await ctx.db
        .query('backgroundRemovals')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredIntents: await ctx.db
        .query('imageUploadIntents')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredStrokes: await ctx.db
        .query('strokes')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredDeletedStrokes: await ctx.db
        .query('deletedStrokes')
        .withIndex('by_session_deleted', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredLiveStrokes: await ctx.db
        .query('liveStrokes')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredPresence: await ctx.db
        .query('userPresence')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredViewerStates: await ctx.db
        .query('viewerStates')
        .withIndex('by_session_viewer', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredSignals: await ctx.db
        .query('webrtcSignals')
        .withIndex('by_session_to', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredLayers: await ctx.db
        .query('paintLayers')
        .withIndex('by_session', (q) => q.eq('sessionId', seeded.expiredSessionId))
        .collect(),
      expiredBlobsExist: await Promise.all(
        seeded.expiredBlobs.map(async (id) => (await ctx.storage.get(id)) !== null),
      ),
      survivingBlobsExist: await Promise.all(
        seeded.survivingBlobs.map(async (id) => (await ctx.storage.get(id)) !== null),
      ),
    }))

    expect(after.expiredSession).toBeNull()
    expect(after.graceSession).not.toBeNull()
    expect(after.liveSession).not.toBeNull()
    expect(after.tx).not.toBeNull()

    expect(after.expiredUploads).toHaveLength(0)
    expect(after.expiredGenerations).toHaveLength(0)
    expect(after.expiredAIImages).toHaveLength(0)
    expect(after.expiredMerges).toHaveLength(0)
    expect(after.expiredRemovals).toHaveLength(0)
    expect(after.expiredIntents).toHaveLength(0)
    expect(after.expiredStrokes).toHaveLength(0)
    expect(after.expiredDeletedStrokes).toHaveLength(0)
    expect(after.expiredLiveStrokes).toHaveLength(0)
    expect(after.expiredPresence).toHaveLength(0)
    expect(after.expiredViewerStates).toHaveLength(0)
    expect(after.expiredSignals).toHaveLength(0)
    expect(after.expiredLayers).toHaveLength(0)

    expect(after.expiredBlobsExist.every((exists) => !exists)).toBe(true)
    expect(after.survivingBlobsExist.every((exists) => exists)).toBe(true)
  })

  test('a huge session drains across self-rescheduled runs while other sessions still progress', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestBackend()
      const expiredDeletedAt = Date.now() - DELETED_SESSION_GRACE_MS - 60_000
      const aiImageCount = PURGE_DOCS_PER_SESSION_TURN + 12
      const strokeCount = PURGE_DOCS_PER_RUN * 3 + 15

      const seeded = await t.run(async (ctx) => {
        const newSession = (name: string, deletedAt: number) =>
          ctx.db.insert('paintingSessions', {
            name,
            isPublic: false,
            canvasWidth: 800,
            canvasHeight: 600,
            strokeCounter: 0,
            deletedAt,
          })
        // The huge session expired first, so it is queued (and served) first
        const hugeId = await newSession('Huge', expiredDeletedAt - 1_000)
        const smallIds = [
          await newSession('Small 1', expiredDeletedAt),
          await newSession('Small 2', expiredDeletedAt),
        ]

        const blobs: Id<'_storage'>[] = []
        for (let i = 0; i < aiImageCount; i++) {
          const storageId = await ctx.storage.store(new Blob([`img-${i}`]))
          blobs.push(storageId)
          await ctx.db.insert('aiGeneratedImages', {
            sessionId: hugeId,
            imageUrl: `https://example.com/ai-${i}.png`,
            storageId,
            width: 64,
            height: 64,
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            layerOrder: i,
            createdAt: expiredDeletedAt,
          })
        }
        // Pre-delete one blob: purge must tolerate blobs that are already gone
        await ctx.storage.delete(blobs[0])

        const stroke = (sessionId: Id<'paintingSessions'>, i: number) =>
          ctx.db.insert('strokes', {
            sessionId,
            userColor: '#000',
            points: [{ x: i, y: i }],
            brushColor: '#000',
            brushSize: 2,
            opacity: 1,
            strokeOrder: i + 1,
          })
        for (let i = 0; i < strokeCount; i++) await stroke(hugeId, i)
        for (const sessionId of smallIds) {
          for (let i = 0; i < 3; i++) await stroke(sessionId, i)
        }
        return { hugeId, smallIds, blobs }
      })

      // One run: bounded, the huge session is not done, but the small ones are
      const first = await t.mutation(internal.paintingSessions.purgeDeletedSessions, {})
      expect(first).toMatchObject({ queued: 3, purged: 2, rescheduled: true })
      expect(first.deletedDocs).toBeLessThanOrEqual(PURGE_DOCS_PER_RUN)
      const afterFirst = await t.run(async (ctx) => ({
        huge: await ctx.db.get(seeded.hugeId),
        small: await Promise.all(seeded.smallIds.map((id) => ctx.db.get(id))),
      }))
      expect(afterFirst.huge?.purgeStartedAt).toBeDefined()
      expect(afterFirst.small).toEqual([null, null])

      // Restoring is refused once the purge has started
      await t.run(async (ctx) => {
        await ctx.db.insert('users', { authId: 'huge-owner', email: 'h@example.com' })
      })
      const ownerId = await t.run(async (ctx) =>
        (await ctx.db.query('users').withIndex('by_auth_id', (q) => q.eq('authId', 'huge-owner')).first())!._id,
      )
      await t.run((ctx) => ctx.db.patch(seeded.hugeId, { createdBy: ownerId }))
      expect(
        await t
          .withIdentity({ subject: 'huge-owner' })
          .mutation(api.paintingSessions.restoreSession, { sessionId: seeded.hugeId }),
      ).toBe('expired')

      // The scheduled follow-up runs drain everything without waiting for the cron
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      const after = await t.run(async (ctx) => ({
        huge: await ctx.db.get(seeded.hugeId),
        aiImages: await ctx.db
          .query('aiGeneratedImages')
          .withIndex('by_session', (q) => q.eq('sessionId', seeded.hugeId))
          .collect(),
        strokes: await ctx.db
          .query('strokes')
          .withIndex('by_session', (q) => q.eq('sessionId', seeded.hugeId))
          .collect(),
        blobsLeft: (await Promise.all(seeded.blobs.map((id) => ctx.storage.get(id)))).filter(Boolean)
          .length,
      }))
      expect(after.huge).toBeNull()
      expect(after.aiImages).toHaveLength(0)
      expect(after.strokes).toHaveLength(0)
      expect(after.blobsLeft).toBe(0)

      // Idempotent no-op afterwards
      expect(await t.mutation(internal.paintingSessions.purgeDeletedSessions, {})).toEqual({
        queued: 0,
        purged: 0,
        deletedDocs: 0,
        rescheduled: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  test('a huge session yields its turn so sessions queued behind it are served', async () => {
    const t = createTestBackend()
    const expiredDeletedAt = Date.now() - DELETED_SESSION_GRACE_MS - 60_000
    const ids = await t.run(async (ctx) => {
      const make = async (name: string, strokes: number) => {
        const sessionId = await ctx.db.insert('paintingSessions', {
          name,
          isPublic: false,
          canvasWidth: 800,
          canvasHeight: 600,
          strokeCounter: 0,
          deletedAt: expiredDeletedAt,
        })
        for (let i = 0; i < strokes; i++) {
          await ctx.db.insert('strokes', {
            sessionId,
            userColor: '#000',
            points: [{ x: i, y: i }],
            brushColor: '#000',
            brushSize: 2,
            opacity: 1,
            strokeOrder: i + 1,
          })
        }
        return sessionId
      }
      // Two huge sessions ahead of a small one: the run budget only covers the
      // first two turns, so the small one waits exactly one run
      return {
        hugeA: await make('A', PURGE_DOCS_PER_SESSION_TURN * 4),
        hugeB: await make('B', PURGE_DOCS_PER_SESSION_TURN * 4),
        small: await make('C', 2),
      }
    })
    const turn = (id: Id<'paintingSessions'>) => t.run(async (ctx) => (await ctx.db.get(id))?.purgeTurn)

    await t.mutation(internal.paintingSessions.purgeDeletedSessions, {})
    expect(await t.run((ctx) => ctx.db.get(ids.small))).not.toBeNull()
    // Both huge sessions moved behind the small one
    expect((await turn(ids.hugeA))!).toBeGreaterThan((await turn(ids.small))!)
    expect((await turn(ids.hugeB))!).toBeGreaterThan((await turn(ids.small))!)

    await t.mutation(internal.paintingSessions.purgeDeletedSessions, {})
    expect(await t.run((ctx) => ctx.db.get(ids.small))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(ids.hugeA))).not.toBeNull()
  })
})

describe('restoreSession grace window', { timeout: 120_000 }, () => {
  test('restores within the window, refuses past it or once purge started', async () => {
    const t = createTestBackend()
    const now = Date.now()
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { authId: 'restorer', email: 'r@example.com' })
      const make = (deletedAt: number, purgeStartedAt?: number) =>
        ctx.db.insert('paintingSessions', {
          createdBy: userId,
          isPublic: false,
          canvasWidth: 800,
          canvasHeight: 600,
          strokeCounter: 0,
          deletedAt,
          purgeStartedAt,
        })
      return {
        recent: await make(now - 60_000),
        pastGrace: await make(now - DELETED_SESSION_GRACE_MS - 60_000),
        purging: await make(now - 60_000, now),
      }
    })
    const owner = t.withIdentity({ subject: 'restorer' })
    expect(await owner.mutation(api.paintingSessions.restoreSession, { sessionId: ids.recent })).toBe(
      'restored',
    )
    expect(
      await owner.mutation(api.paintingSessions.restoreSession, { sessionId: ids.pastGrace }),
    ).toBe('expired')
    expect(await owner.mutation(api.paintingSessions.restoreSession, { sessionId: ids.purging })).toBe(
      'expired',
    )
    const state = await t.run(async (ctx) => ({
      recent: await ctx.db.get(ids.recent),
      pastGrace: await ctx.db.get(ids.pastGrace),
    }))
    expect(state.recent?.deletedAt).toBeUndefined()
    expect(state.pastGrace?.deletedAt).toBeDefined()
  })
})

describe('AUD-010 addAIGeneratedImage storage ownership validation', { timeout: 120_000 }, () => {
  test('accepts session-owned AI/merge outputs and rejects foreign, uploaded, snapshot, or unattached storage IDs', async () => {
    const t = createTestBackend()

    const seeded = await t.run(async (ctx) => {
      const victimId = await ctx.db.insert('users', {
        authId: 'victim-auth',
        email: 'victim@example.com',
      })
      const attackerId = await ctx.db.insert('users', {
        authId: 'attacker-auth',
        email: 'attacker@example.com',
      })

      const victimSessionId = await ctx.db.insert('paintingSessions', {
        createdBy: victimId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      const attackerSessionId = await ctx.db.insert('paintingSessions', {
        createdBy: attackerId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })

      const victimGenBlob = await ctx.storage.store(new Blob(['victim-gen']))
      const victimMergeBlob = await ctx.storage.store(new Blob(['victim-merge']))
      const attackerGenBlob = await ctx.storage.store(new Blob(['attacker-gen']))
      const attackerMergeBlob = await ctx.storage.store(new Blob(['attacker-merge']))
      const attackerUploadBlob = await ctx.storage.store(new Blob(['attacker-upload']))
      const attackerIntentBlob = await ctx.storage.store(new Blob(['attacker-intent']))
      const attackerSnapshotBlob = await ctx.storage.store(new Blob(['attacker-snapshot']))
      const unattachedBlob = await ctx.storage.store(new Blob(['unattached']))
      const deletedBlob = await ctx.storage.store(new Blob(['deleted']))
      await ctx.storage.delete(deletedBlob)

      await ctx.db.insert('aiGenerations', {
        sessionId: victimSessionId,
        status: 'completed',
        provider: 'replicate',
        generatedImageId: victimGenBlob,
        resultImageUrl: 'https://example.com/victim-gen.png',
        createdAt: Date.now(),
      })
      await ctx.db.insert('imageMerges', {
        sessionId: victimSessionId,
        firstLayerId: 'l1',
        secondLayerId: 'l2',
        mergeMode: 'full',
        status: 'completed',
        mergedImageStorageId: victimMergeBlob,
        resultImageUrl: 'https://example.com/victim-merge.png',
        createdAt: Date.now(),
      })

      await ctx.db.insert('aiGenerations', {
        sessionId: attackerSessionId,
        status: 'completed',
        provider: 'gemini',
        generatedImageId: attackerGenBlob,
        resultImageUrl: 'https://example.com/attacker-gen.png',
        createdAt: Date.now(),
      })
      await ctx.db.insert('imageMerges', {
        sessionId: attackerSessionId,
        firstLayerId: 'l1',
        secondLayerId: 'l2',
        mergeMode: 'full',
        status: 'completed',
        mergedImageStorageId: attackerMergeBlob,
        resultImageUrl: 'https://example.com/attacker-merge.png',
        createdAt: Date.now(),
      })
      await ctx.db.insert('aiGenerations', {
        sessionId: attackerSessionId,
        status: 'processing',
        provider: 'replicate',
        canvasSnapshotId: attackerSnapshotBlob,
        createdAt: Date.now(),
      })
      await ctx.db.insert('uploadedImages', {
        sessionId: attackerSessionId,
        userId: attackerId,
        storageId: attackerUploadBlob,
        filename: 'up.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
      })
      await ctx.db.insert('imageUploadIntents', {
        sessionId: attackerSessionId,
        userId: attackerId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        storageId: attackerIntentBlob,
      })

      return {
        attackerSessionId,
        victimGenBlob,
        victimMergeBlob,
        attackerGenBlob,
        attackerMergeBlob,
        attackerUploadBlob,
        attackerIntentBlob,
        attackerSnapshotBlob,
        unattachedBlob,
        deletedBlob,
      }
    })

    const attacker = t.withIdentity({ subject: 'attacker-auth' })

    // Foreign / unauthorized / non-AI storage IDs MUST be rejected
    const forbiddenIds = [
      seeded.victimGenBlob,
      seeded.victimMergeBlob,
      seeded.attackerUploadBlob,
      seeded.attackerIntentBlob,
      seeded.attackerSnapshotBlob,
      seeded.unattachedBlob,
    ]
    for (const storageId of forbiddenIds) {
      await expect(
        attacker.mutation(api.images.addAIGeneratedImage, {
          sessionId: seeded.attackerSessionId,
          imageUrl: 'https://example.com/attempt.png',
          storageId,
          width: 100,
          height: 100,
        }),
      ).rejects.toThrow('Storage object does not belong to this session')
    }

    await expect(
      attacker.mutation(api.images.addAIGeneratedImage, {
        sessionId: seeded.attackerSessionId,
        imageUrl: 'https://example.com/deleted.png',
        storageId: seeded.deletedBlob,
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('Storage object not found')

    // Legitimate completed AI generation & merge outputs for the session succeed
    const genImgId = await attacker.mutation(api.images.addAIGeneratedImage, {
      sessionId: seeded.attackerSessionId,
      imageUrl: 'https://example.com/attacker-gen.png',
      storageId: seeded.attackerGenBlob,
      width: 200,
      height: 150,
    })
    const mergeImgId = await attacker.mutation(api.images.addAIGeneratedImage, {
      sessionId: seeded.attackerSessionId,
      imageUrl: 'https://example.com/attacker-merge.png',
      storageId: seeded.attackerMergeBlob,
      width: 200,
      height: 150,
    })

    const saved = await t.run(async (ctx) => ({
      genImg: await ctx.db.get(genImgId),
      mergeImg: await ctx.db.get(mergeImgId),
      victimGenStillExists: (await ctx.storage.get(seeded.victimGenBlob)) !== null,
      victimMergeStillExists: (await ctx.storage.get(seeded.victimMergeBlob)) !== null,
    }))

    expect(saved.genImg?.storageId).toBe(seeded.attackerGenBlob)
    expect(saved.mergeImg?.storageId).toBe(seeded.attackerMergeBlob)
    expect(saved.victimGenStillExists).toBe(true)
    expect(saved.victimMergeStillExists).toBe(true)
  })
})

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>
let downloadCounter = 0

/** Route mocked fetches: Replicate create / poll / cancel, Gemini and result downloads. */
function mockProviders(opts: {
  create?: FetchHandler
  poll?: (attempt: number) => Response | Promise<Response>
  gemini?: FetchHandler
}) {
  const calls = { create: 0, poll: 0, download: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/cancel')) return new Response('{}', { status: 200 })
      if (url.startsWith('https://generativelanguage.googleapis.com/')) {
        if (!opts.gemini) throw new Error('unexpected gemini call')
        return opts.gemini(url, init)
      }
      if (url === 'https://api.replicate.com/v1/predictions' && init?.method === 'POST') {
        calls.create += 1
        return opts.create
          ? opts.create(url, init)
          : new Response(JSON.stringify({ id: `pred-${calls.create}` }), { status: 201 })
      }
      if (url.startsWith('https://api.replicate.com/v1/predictions/')) {
        const attempt = calls.poll++
        if (!opts.poll) throw new Error('unexpected poll')
        return opts.poll(attempt)
      }
      calls.download += 1
      // Distinct bytes per download: convex-test derives storage URLs from the
      // content hash, so identical outputs would share a URL
      const bytes = makePngBytes()
      bytes[31] = downloadCounter++ & 0xff
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }),
  )
  return calls
}

const succeeded = (output: string) =>
  new Response(JSON.stringify({ status: 'succeeded', output }), { status: 200 })

async function blobExists(t: ReturnType<typeof createTestBackend>, id: Id<'_storage'>) {
  return await t.run(async (ctx) => (await ctx.storage.get(id)) !== null)
}

async function blobCount(t: ReturnType<typeof createTestBackend>) {
  return await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)
}

async function seedActionUser(tokens = 10) {
  const t = createTestBackend()
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      authId: 'action-user',
      email: 'action@example.com',
      tokens,
      lifetimeTokensUsed: 0,
    })
    const sessionId = await ctx.db.insert('paintingSessions', {
      createdBy: userId,
      isPublic: false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
    })
    const insertUpload = async (layerOrder: number) =>
      ctx.db.insert('uploadedImages', {
        sessionId,
        userId,
        storageId: await ctx.storage.store(new Blob([makePngBytes()], { type: 'image/png' })),
        filename: `l${layerOrder}.png`,
        mimeType: 'image/png',
        width: 64,
        height: 64,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder,
      })
    const layer1Id = await insertUpload(1)
    const layer2Id = await insertUpload(2)
    return { userId, sessionId, layer1Id, layer2Id }
  })
  return { t, ...ids, asUser: t.withIdentity({ subject: 'action-user' }) }
}

describe('AUD-010 AI action storage tracking and failure cleanup', { timeout: 120_000 }, () => {
  beforeEach(() => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')
  })

  test('Replicate generation always frees its canvas snapshot and records its output', async () => {
    const { t, userId, sessionId, asUser } = await seedActionUser()
    const initialBlobs = await blobCount(t)
    const imageData = `data:image/png;base64,${VALID_BASE64_PNG}`
    const generations = () =>
      t.run((ctx) =>
        ctx.db
          .query('aiGenerations')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .order('asc')
          .collect(),
      )

    // 1. Rejected before acceptance: refunded, snapshot freed
    mockProviders({ create: () => new Response('upstream failure', { status: 500 }) })
    const rejected = await asUser.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'fail on start',
      imageData,
    })
    expect(rejected.success).toBe(false)
    expect(await blobCount(t)).toBe(initialBlobs)
    expect((await generations())[0]).toMatchObject({ status: 'failed' })
    expect((await generations())[0].canvasSnapshotId).toBeUndefined()
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(10)

    // 2. Fails after acceptance: billed, snapshot still freed
    mockProviders({
      poll: () => new Response(JSON.stringify({ status: 'failed', error: 'NSFW' }), { status: 200 }),
    })
    const failedPoll = await asUser.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'fail on poll',
      imageData,
    })
    expect(failedPoll.success).toBe(false)
    expect(await blobCount(t)).toBe(initialBlobs)
    expect((await generations())[1]).toMatchObject({ status: 'failed_billed' })
    expect((await generations())[1].canvasSnapshotId).toBeUndefined()
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(9)

    // 3. Success: output recorded with the status, snapshot freed in the same mutation
    mockProviders({ poll: () => succeeded('https://replicate.delivery/out.png') })
    const ok = await asUser.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'watercolor forest',
      imageData,
    })
    expect(ok.success).toBe(true)
    if (!ok.success || !ok.imageUrl || !ok.storageId) throw new Error('Expected success')
    expect(await blobCount(t)).toBe(initialBlobs + 1)
    const completed = (await generations())[2]
    expect(completed.status).toBe('completed')
    expect(completed.generatedImageId).toBe(ok.storageId)
    expect(completed.canvasSnapshotId).toBeUndefined()

    const layerId = await asUser.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      imageUrl: ok.imageUrl,
      storageId: ok.storageId,
      width: 64,
      height: 64,
    })
    expect((await t.run((ctx) => ctx.db.get(layerId)))?.storageId).toBe(ok.storageId)
  })

  test('Gemini, background removal and merge record and return their output blobs', async () => {
    const { t, sessionId, layer1Id, layer2Id, asUser } = await seedActionUser()
    const imageData = `data:image/png;base64,${VALID_BASE64_PNG}`

    mockProviders({
      gemini: () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: 'image/png', data: btoa('PNGDATA12345') } }] } },
            ],
          }),
          { status: 200 },
        ),
    })
    const gem = await asUser.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'neon skyline',
      imageData,
    })
    if (!gem.success || !gem.imageUrl || !gem.storageId) throw new Error('Expected Gemini success')

    mockProviders({ poll: () => succeeded('https://replicate.delivery/bg.png') })
    const bg = await asUser.action(api.backgroundRemoval.removeBackground, { sessionId, imageData })
    expect(bg.storageId).toBeDefined()

    mockProviders({ poll: () => succeeded('https://replicate.delivery/merged.png') })
    const merge = await asUser.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: layer1Id,
      secondLayerId: layer2Id,
      mergeMode: 'full',
    })
    if (!merge.success || !merge.imageUrl || !merge.storageId) throw new Error('Expected merge success')

    const rows = await t.run(async (ctx) => ({
      generation: await ctx.db.query('aiGenerations').first(),
      removal: await ctx.db.query('backgroundRemovals').first(),
      merge: await ctx.db.query('imageMerges').first(),
    }))
    expect(rows.generation?.generatedImageId).toBe(gem.storageId)
    expect(rows.removal?.resultStorageId).toBe(bg.storageId)
    expect(rows.merge?.mergedImageStorageId).toBe(merge.storageId)

    // Background removals never show up in the prompt history strip
    const recent = await asUser.query(api.aiGeneration.getSessionGenerations, { sessionId })
    expect(recent.map((g) => g.generatedImageId)).toEqual([gem.storageId])

    for (const storageId of [gem.storageId, bg.storageId, merge.storageId]) {
      const layerId = await asUser.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        imageUrl: 'https://ignored.example.com/x.png',
        storageId,
        width: 64,
        height: 64,
      })
      expect((await t.run((ctx) => ctx.db.get(layerId)))?.storageId).toBe(storageId)
    }
  })

  test('a result that can no longer be written deletes its output blob', async () => {
    const { t, sessionId, asUser } = await seedActionUser()
    const initialBlobs = await blobCount(t)
    mockProviders({
      poll: async () => {
        await t.run(async (ctx) => ctx.db.patch(sessionId, { deletedAt: Date.now() }))
        return succeeded('https://replicate.delivery/out.png')
      },
    })
    const result = await asUser.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'too late',
      imageData: `data:image/png;base64,${VALID_BASE64_PNG}`,
    })
    expect(result.success).toBe(false)
    expect(await blobCount(t)).toBe(initialBlobs)
    const row = await t.run((ctx) => ctx.db.query('aiGenerations').first())
    expect(row).toMatchObject({ status: 'failed_billed' })
    expect(row?.generatedImageId).toBeUndefined()
    expect(row?.canvasSnapshotId).toBeUndefined()
  })
})

describe('AUD-010 stale operation sweep (cleanupStaleOperations)', { timeout: 120_000 }, () => {
  test('refunds stale pending rows, bills stale processing rows, frees snapshots, and blocks late completion', async () => {
    const { t, userId, sessionId, asUser } = await seedActionUser(10)
    const staleAt = Date.now() - STALE_OPERATION_TIMEOUT_MS - 60_000

    // Rows created through the real billing path (each debits 1 token)
    const begin = async (operation: Parameters<typeof asUser.mutation<typeof internal.aiOperations.beginOperation>>[1]['operation']) => {
      const res = await asUser.mutation(internal.aiOperations.beginOperation, { sessionId, operation })
      if (res.status !== 'ok') throw new Error(res.status)
      return res.operationId
    }
    const pendingGen = await begin({ type: 'ai-generation', prompt: 'a', provider: 'replicate' })
    const processingGen = await begin({ type: 'ai-generation', prompt: 'b', provider: 'replicate' })
    const pendingMerge = await begin({
      type: 'image-merge',
      firstLayerId: 'l1',
      secondLayerId: 'l2',
      mergeMode: 'full',
    })
    const processingRemoval = await begin({ type: 'background-removal' })
    const freshGen = await begin({ type: 'ai-generation', prompt: 'fresh', provider: 'gemini' })
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(5)

    const snapshot = await t.run((ctx) => ctx.storage.store(new Blob(['snap'])))
    await t.mutation(internal.aiOperations.recordCanvasSnapshot, {
      operationId: processingGen,
      storageId: snapshot,
    })
    await t.mutation(internal.aiOperations.markOperationProcessing, {
      operationType: 'ai-generation',
      operationId: processingGen,
      replicateId: 'pred-x',
    })
    await t.mutation(internal.aiOperations.markOperationProcessing, {
      operationType: 'background-removal',
      operationId: processingRemoval,
      replicateId: 'pred-y',
    })
    await t.run(async (ctx) => {
      for (const id of [pendingGen, processingGen]) {
        await ctx.db.patch(id as Id<'aiGenerations'>, { createdAt: staleAt })
      }
      await ctx.db.patch(pendingMerge as Id<'imageMerges'>, { createdAt: staleAt })
      await ctx.db.patch(processingRemoval as Id<'backgroundRemovals'>, { createdAt: staleAt })
    })

    expect(await t.mutation(internal.aiOperations.cleanupStaleOperations, {})).toEqual({
      refunded: 2,
      billed: 2,
    })

    const state = await t.run(async (ctx) => ({
      pendingGen: await ctx.db.get(pendingGen as Id<'aiGenerations'>),
      processingGen: await ctx.db.get(processingGen as Id<'aiGenerations'>),
      pendingMerge: await ctx.db.get(pendingMerge as Id<'imageMerges'>),
      processingRemoval: await ctx.db.get(processingRemoval as Id<'backgroundRemovals'>),
      freshGen: await ctx.db.get(freshGen as Id<'aiGenerations'>),
      snapshot: await ctx.storage.get(snapshot),
      user: await ctx.db.get(userId),
    }))
    expect(state.pendingGen).toMatchObject({ status: 'failed', error: 'Operation timed out' })
    expect(state.pendingMerge).toMatchObject({ status: 'failed', error: 'Operation timed out' })
    expect(state.processingGen).toMatchObject({ status: 'failed_billed' })
    expect(state.processingGen?.canvasSnapshotId).toBeUndefined()
    expect(state.processingRemoval).toMatchObject({ status: 'failed_billed' })
    expect(state.freshGen?.status).toBe('pending')
    expect(state.snapshot).toBeNull()
    // The two pending rows were refunded (idempotently keyed refund:<operationKey>)
    expect(state.user?.tokens).toBe(7)

    // Idempotent: a second sweep and a direct refund change nothing
    expect(await t.mutation(internal.aiOperations.cleanupStaleOperations, {})).toEqual({
      refunded: 0,
      billed: 0,
    })
    await t.mutation(internal.aiOperations.refundOperation, {
      operationType: 'ai-generation',
      operationId: pendingGen,
    })
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(7)

    // A late-finishing action can't overwrite the terminal row; its blob is freed
    const lateBlob = await t.run((ctx) => ctx.storage.store(new Blob(['late'])))
    const late = await asUser.mutation(internal.aiOperations.completeOperation, {
      operationType: 'ai-generation',
      operationId: processingGen,
      resultImageUrl: 'https://example.com/late.png',
      resultStorageId: lateBlob,
    })
    expect(late).toBe('already_terminal')
    const lateFail = await t.mutation(internal.aiOperations.failOperation, {
      operationType: 'ai-generation',
      operationId: pendingGen,
      outcome: 'billed',
      error: 'late failure',
    })
    expect(lateFail.status).toBe('already_terminal')
    const lateSnapshot = await t.run((ctx) => ctx.storage.store(new Blob(['late-snap'])))
    expect(
      await t.mutation(internal.aiOperations.recordCanvasSnapshot, {
        operationId: pendingGen,
        storageId: lateSnapshot,
      }),
    ).toBe(false)
    const after = await t.run(async (ctx) => ({
      processingGen: await ctx.db.get(processingGen as Id<'aiGenerations'>),
      pendingGen: await ctx.db.get(pendingGen as Id<'aiGenerations'>),
      lateBlob: await ctx.storage.get(lateBlob),
      lateSnapshot: await ctx.storage.get(lateSnapshot),
    }))
    expect(after.processingGen?.status).toBe('failed_billed')
    expect(after.processingGen?.generatedImageId).toBeUndefined()
    expect(after.pendingGen?.status).toBe('failed')
    expect(after.lateBlob).toBeNull()
    expect(after.lateSnapshot).toBeNull()
  })
})

describe('AUD-010 AI output ownership (real flow)', { timeout: 120_000 }, () => {
  beforeEach(() => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')
  })

  async function generate(
    asUser: Awaited<ReturnType<typeof seedActionUser>>['asUser'],
    sessionId: Id<'paintingSessions'>,
    prompt: string,
  ) {
    mockProviders({ poll: () => succeeded(`https://replicate.delivery/${prompt}.png`) })
    const res = await asUser.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt,
      imageData: `data:image/png;base64,${VALID_BASE64_PNG}`,
    })
    if (!res.success || !res.storageId) throw new Error('Expected success')
    return res.storageId
  }

  test('placing an output moves ownership to the layer; deleting the layer frees the blob', async () => {
    const { t, sessionId, asUser } = await seedActionUser()
    const storageId = await generate(asUser, sessionId, 'placed')

    const layerId = await asUser.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      imageUrl: 'https://ignored.example.com/x.png',
      storageId,
      width: 64,
      height: 64,
    })
    const row = await t.run((ctx) => ctx.db.query('aiGenerations').first())
    expect(row?.generatedImageId).toBeUndefined()
    expect(row?.outputExpiresAt).toBeUndefined()
    expect(row?.placedImageId).toBe(layerId)
    expect(row?.placedAt).toBeDefined()

    // The history strip still offers it, backed by the layer's blob
    const history = await asUser.query(api.aiGeneration.getSessionGenerations, { sessionId })
    expect(history.map((g) => g.generatedImageId)).toEqual([storageId])

    // Re-placing from history shares the blob with the first layer
    const secondLayerId = await asUser.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      storageId,
      imageUrl: 'https://ignored.example.com/x.png',
      width: 64,
      height: 64,
    })

    await asUser.mutation(api.images.deleteAIImage, { imageId: layerId })
    expect(await blobExists(t, storageId)).toBe(true)
    await asUser.mutation(api.images.deleteAIImage, { imageId: secondLayerId })
    expect(await blobExists(t, storageId)).toBe(false)

    // Freed: gone from history and can't be placed again
    expect(await asUser.query(api.aiGeneration.getSessionGenerations, { sessionId })).toEqual([])
    await expect(
      asUser.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        storageId,
        imageUrl: 'https://ignored.example.com/x.png',
        width: 64,
        height: 64,
      }),
    ).rejects.toThrow('Storage object not found')
  })

  test('a placed output can not be claimed by another session', async () => {
    const { t, userId, sessionId, asUser } = await seedActionUser()
    const otherSessionId = await t.run((ctx) =>
      ctx.db.insert('paintingSessions', {
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      }),
    )
    const storageId = await generate(asUser, sessionId, 'mine')
    await asUser.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      storageId,
      imageUrl: 'https://ignored.example.com/x.png',
      width: 64,
      height: 64,
    })
    await expect(
      asUser.mutation(api.images.addAIGeneratedImage, {
        sessionId: otherSessionId,
        storageId,
        imageUrl: 'https://ignored.example.com/x.png',
        width: 64,
        height: 64,
      }),
    ).rejects.toThrow('Storage object does not belong to this session')
  })

  test('outputs never placed are deleted once their TTL passes; placed ones are kept', async () => {
    const { t, sessionId, asUser } = await seedActionUser()
    const unplaced = await generate(asUser, sessionId, 'unplaced')
    const placed = await generate(asUser, sessionId, 'kept')
    await asUser.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      storageId: placed,
      imageUrl: 'https://ignored.example.com/x.png',
      width: 64,
      height: 64,
    })

    // Not yet due
    expect(await t.mutation(internal.storageLifecycle.expireUnplacedOutputs, {})).toEqual({
      expired: 0,
    })
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('aiGenerations').collect()) {
        if (row.outputExpiresAt) await ctx.db.patch(row._id, { outputExpiresAt: Date.now() - 1 })
      }
    })
    expect(await t.mutation(internal.storageLifecycle.expireUnplacedOutputs, {})).toEqual({
      expired: 1,
    })
    const state = await t.run(async (ctx) => ({
      unplaced: (await ctx.storage.get(unplaced)) !== null,
      placed: (await ctx.storage.get(placed)) !== null,
      rows: await ctx.db.query('aiGenerations').collect(),
    }))
    expect(state.unplaced).toBe(false)
    expect(state.placed).toBe(true)
    expect(state.rows.every((r) => r.generatedImageId === undefined)).toBe(true)
    await expect(
      asUser.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        storageId: unplaced,
        imageUrl: 'https://ignored.example.com/x.png',
        width: 64,
        height: 64,
      }),
    ).rejects.toThrow('Storage object not found')
  })

  test('merge and background-removal outputs transfer on placement too', async () => {
    const { t, sessionId, layer1Id, layer2Id, asUser } = await seedActionUser()
    const imageData = `data:image/png;base64,${VALID_BASE64_PNG}`
    mockProviders({ poll: () => succeeded('https://replicate.delivery/bg.png') })
    const bg = await asUser.action(api.backgroundRemoval.removeBackground, { sessionId, imageData })
    mockProviders({ poll: () => succeeded('https://replicate.delivery/merged.png') })
    const merge = await asUser.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: layer1Id,
      secondLayerId: layer2Id,
      mergeMode: 'full',
    })
    if (!merge.storageId) throw new Error('Expected merge output')
    for (const storageId of [bg.storageId, merge.storageId]) {
      const layerId = await asUser.mutation(api.images.addAIGeneratedImage, {
        sessionId,
        storageId,
        imageUrl: 'https://ignored.example.com/x.png',
        width: 64,
        height: 64,
      })
      await asUser.mutation(api.images.deleteAIImage, { imageId: layerId })
      expect(await blobExists(t, storageId)).toBe(false)
    }
    const rows = await t.run(async (ctx) => ({
      removal: await ctx.db.query('backgroundRemovals').first(),
      merge: await ctx.db.query('imageMerges').first(),
    }))
    expect(rows.removal?.resultStorageId).toBeUndefined()
    expect(rows.removal?.placedImageId).toBeDefined()
    expect(rows.merge?.mergedImageStorageId).toBeUndefined()
    expect(rows.merge?.placedImageId).toBeDefined()
  })
})

describe('AUD-010 orphaned storage sweep (sweepOrphanedStorage)', { timeout: 120_000 }, () => {
  test('deletes only old blobs nothing references, including uncommitted-upload leftovers', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestBackend()
      const old = await t.run(async (ctx) => {
        const store = (label: string) => ctx.storage.store(new Blob([label]))
        const sessionId = await ctx.db.insert('paintingSessions', {
          isPublic: false,
          canvasWidth: 800,
          canvasHeight: 600,
          strokeCounter: 0,
        })
        const orphan = await store('orphan')
        const abandonedIntentBlob = await store('abandoned-intent')
        const upload = await store('upload')
        const openIntent = await store('open-intent')
        const snapshot = await store('snapshot')
        const unplacedOutput = await store('unplaced-output')
        const trackedLayer = await store('tracked-layer')
        const legacyLayer = await store('legacy-layer')

        await ctx.db.insert('uploadedImages', {
          sessionId,
          storageId: upload,
          filename: 'u.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
          opacity: 1,
          layerOrder: 1,
        })
        // Uploaded but not yet committed: must survive
        await ctx.db.insert('imageUploadIntents', {
          sessionId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          storageId: openIntent,
        })
        // A consumed intent no longer owns its blob (its uploadedImages row
        // would); with that row gone the blob is an orphan
        await ctx.db.insert('imageUploadIntents', {
          sessionId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          consumedAt: Date.now(),
          storageId: abandonedIntentBlob,
        })
        await ctx.db.insert('aiGenerations', {
          sessionId,
          status: 'processing',
          provider: 'replicate',
          canvasSnapshotId: snapshot,
          createdAt: Date.now(),
        })
        await ctx.db.insert('aiGenerations', {
          sessionId,
          status: 'completed',
          provider: 'replicate',
          generatedImageId: unplacedOutput,
          createdAt: Date.now(),
        })
        const layer = (imageUrl: string, storageId?: Id<'_storage'>) =>
          ctx.db.insert('aiGeneratedImages', {
            sessionId,
            imageUrl,
            storageId,
            width: 1,
            height: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            layerOrder: 2,
            createdAt: Date.now(),
          })
        await layer('https://example.com/tracked.png', trackedLayer)
        // Pre-tracking layer: references its blob only by URL
        await layer((await ctx.storage.getUrl(legacyLayer))!)
        return {
          orphan,
          abandonedIntentBlob,
          kept: [upload, openIntent, snapshot, unplacedOutput, trackedLayer, legacyLayer],
        }
      })

      // Young blobs are never touched, even when unreferenced
      expect(await t.mutation(internal.storageLifecycle.sweepOrphanedStorage, {})).toEqual({
        scanned: 0,
        deleted: 0,
        done: true,
      })

      vi.setSystemTime(Date.now() + ORPHAN_BLOB_TTL_MS + 60_000)
      const young = await t.run((ctx) => ctx.storage.store(new Blob(['young orphan'])))

      expect(await t.mutation(internal.storageLifecycle.sweepOrphanedStorage, {})).toEqual({
        scanned: 8,
        deleted: 2,
        done: true,
      })
      expect(await blobExists(t, old.orphan)).toBe(false)
      expect(await blobExists(t, old.abandonedIntentBlob)).toBe(false)
      for (const id of old.kept) expect(await blobExists(t, id)).toBe(true)
      expect(await blobExists(t, young)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('works in bounded batches and reschedules itself until the whole table is swept', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestBackend()
      const total = ORPHAN_SWEEP_BATCH_SIZE + 25
      await t.run(async (ctx) => {
        for (let i = 0; i < total; i++) await ctx.storage.store(new Blob([`orphan-${i}`]))
      })
      vi.setSystemTime(Date.now() + ORPHAN_BLOB_TTL_MS + 60_000)

      expect(await t.mutation(internal.storageLifecycle.sweepOrphanedStorage, {})).toEqual({
        scanned: ORPHAN_SWEEP_BATCH_SIZE,
        deleted: ORPHAN_SWEEP_BATCH_SIZE,
        done: false,
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await blobCount(t)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
