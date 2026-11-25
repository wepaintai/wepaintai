import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import * as imageMergerModule from './imageMerger'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

async function seedAuthFixture(options: {
  ownerTokens?: number
  outsiderTokens?: number
  isPublic?: boolean
  guestOwnerKey?: string
  editKey?: string
  deletedAt?: number
} = {}) {
  const t = createTestBackend()
  const seeded = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      authId: 'owner-auth',
      email: 'owner@example.com',
      tokens: options.ownerTokens ?? 5,
      lifetimeTokensUsed: 0,
    })
    const outsiderId = await ctx.db.insert('users', {
      authId: 'outsider-auth',
      email: 'outsider@example.com',
      tokens: options.outsiderTokens ?? 5,
      lifetimeTokensUsed: 0,
    })

    const sessionId = await ctx.db.insert('paintingSessions', {
      createdBy: options.guestOwnerKey ? undefined : ownerId,
      guestOwnerKey: options.guestOwnerKey,
      editKey: options.editKey,
      isPublic: options.isPublic ?? false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
      deletedAt: options.deletedAt,
      aiPrompts: ['secret prompt'],
    })

    const otherSessionId = await ctx.db.insert('paintingSessions', {
      createdBy: outsiderId,
      isPublic: false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
    })

    const ownerLayerId = await ctx.db.insert('paintLayers', {
      sessionId,
      name: 'Owner Layer',
      layerOrder: 0,
      visible: true,
      opacity: 1,
      createdBy: ownerId,
      createdAt: Date.now(),
    })

    const otherLayerId = await ctx.db.insert('paintLayers', {
      sessionId: otherSessionId,
      name: 'Other Session Layer',
      layerOrder: 0,
      visible: true,
      opacity: 1,
      createdBy: outsiderId,
      createdAt: Date.now(),
    })

    return { ownerId, outsiderId, sessionId, otherSessionId, ownerLayerId, otherLayerId }
  })

  return {
    t,
    ...seeded,
    asOwner: t.withIdentity({ subject: 'owner-auth' }),
    asOutsider: t.withIdentity({ subject: 'outsider-auth' }),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AUD-004 & AUD-007 centralized session authorization', () => {
  test('backgroundRemoval allows legitimate owner and blocks outsiders (AUD-007)', async () => {
    const { t, sessionId, asOwner, asOutsider } = await seedAuthFixture()
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')

    // Unauthenticated rejected
    await expect(
      t.action(api.backgroundRemoval.removeBackground, {
        sessionId,
        imageData: 'data:image/png;base64,' + 'A'.repeat(200),
      })
    ).rejects.toThrow('Authentication required')

    // Outsider on private session rejected before Replicate call
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      asOutsider.action(api.backgroundRemoval.removeBackground, {
        sessionId,
        imageData: 'data:image/png;base64,' + 'A'.repeat(200),
      })
    ).rejects.toThrow("You don't have permission")
    expect(fetchMock).not.toHaveBeenCalled()

    // Legitimate owner passes authorization (previously broken by createdBy vs identity.subject)
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const ownerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'pred-bg-1' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'succeeded', output: 'https://replicate.delivery/bg.png' }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
      )
    vi.stubGlobal('fetch', ownerFetch)

    const result = await asOwner.action(api.backgroundRemoval.removeBackground, {
      sessionId,
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
    })
    expect(result.success).toBe(true)
    expect(ownerFetch).toHaveBeenCalledTimes(3)
  })

  test('backgroundRemoval supports guest-owned session with matching guestKey and rejects wrong key', async () => {
    const guestKey = 'bg-guest-secret'
    const { asOutsider, sessionId } = await seedAuthFixture({ guestOwnerKey: guestKey })
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')

    await expect(
      asOutsider.action(api.backgroundRemoval.removeBackground, {
        sessionId,
        imageData: 'data:image/png;base64,' + 'A'.repeat(200),
        guestKey: 'wrong-key',
      })
    ).rejects.toThrow("You don't have permission")

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'pred-bg-2' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ status: 'succeeded', output: 'https://replicate.delivery/bg2.png' }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
        )
    )

    const result = await asOutsider.action(api.backgroundRemoval.removeBackground, {
      sessionId,
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
      guestKey,
    })
    expect(result.success).toBe(true)
  })

  test('imageMerger hides getLayerImageUrl publicly and authorizes mergeImages and getSessionMerges', async () => {
    const { t, sessionId, asOwner, asOutsider } = await seedAuthFixture()

    const { imgId } = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['secret']))
      const imgId = await ctx.db.insert('uploadedImages', {
        sessionId,
        storageId,
        filename: 'private.png',
        mimeType: 'image/png',
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
      })
      await ctx.db.insert('imageMerges', {
        sessionId,
        firstLayerId: imgId,
        secondLayerId: imgId,
        mergeMode: 'full',
        status: 'completed',
        resultImageUrl: 'https://example.com/private-merge.png',
        createdAt: Date.now(),
      })
      return { imgId }
    })

    // getLayerImageUrl must be internal-only AND enforce session read authz
    expect((imageMergerModule.getLayerImageUrl as { isInternal?: boolean }).isInternal).toBe(true)
    expect((imageMergerModule.getLayerImageUrl as { isPublic?: boolean }).isPublic).toBeUndefined()
    expect(
      await asOutsider.query(internal.imageMerger.getLayerImageUrl, { sessionId, layerId: imgId })
    ).toBeNull()
    expect(
      await asOwner.query(internal.imageMerger.getLayerImageUrl, { sessionId, layerId: imgId })
    ).toMatchObject({ type: 'uploaded' })

    // getSessionMerges must not leak private merges to outsiders
    expect(await t.query(api.imageMerger.getSessionMerges, { sessionId })).toEqual([])
    expect(await asOutsider.query(api.imageMerger.getSessionMerges, { sessionId })).toEqual([])
    expect(await asOwner.query(api.imageMerger.getSessionMerges, { sessionId })).toHaveLength(1)

    // mergeImages must reject private-session outsiders before provider work
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mergeResult = await asOutsider.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: imgId,
      secondLayerId: imgId,
      mergeMode: 'full',
    })
    expect(mergeResult).toEqual({ success: false, error: 'Unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('AI generation actions reject outsiders on private sessions before provider calls', async () => {
    const { t, sessionId, asOutsider } = await seedAuthFixture()
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate')
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const repRes = await asOutsider.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'injected prompt',
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
    })
    expect(repRes).toEqual({ success: false, error: 'Unauthorized' })

    const gemRes = await asOutsider.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'injected prompt',
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
    })
    expect(gemRes).toEqual({ success: false, error: 'Unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()

    const generations = await t.run(async (ctx) =>
      ctx.db
        .query('aiGenerations')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect()
    )
    expect(generations).toHaveLength(0)
  })

  test('presence enforces session authorization and ignores userId spoofing/eviction', async () => {
    const { t, ownerId, outsiderId, sessionId, asOwner, asOutsider } = await seedAuthFixture()

    // Outsider cannot write presence to private session (silently ignored)
    expect(
      await asOutsider.mutation(api.presence.updatePresence, {
        sessionId,
        userId: outsiderId,
        userColor: '#f00',
        userName: 'Outsider',
        cursorX: 1,
        cursorY: 2,
        isDrawing: false,
        currentTool: 'brush',
      })
    ).toBeNull()

    // Owner writes presence cleanly and receives its own presence id + leave token
    const ownerPresence = await asOwner.mutation(api.presence.updatePresence, {
      sessionId,
      userColor: '#0f0',
      userName: 'Owner',
      cursorX: 10,
      cursorY: 20,
      isDrawing: false,
      currentTool: 'brush',
    })
    expect(ownerPresence?.presenceId).toBeTruthy()
    expect(ownerPresence?.leaveToken).toMatch(/^[0-9a-f]{48}$/)

    // Even with a valid editKey, an authorized collaborator cannot spoof or
    // evict the owner's userId. The claimed userId is ignored (no throw, so
    // stale clients stay quiet) and the write lands on the collaborator's own row.
    const editKey = 'presence-collab-key'
    await t.run(async (ctx) => {
      await ctx.db.patch(sessionId, { isPublic: true, editKey })
    })

    const spoof = await asOutsider.mutation(api.presence.updatePresence, {
      sessionId,
      userId: ownerId,
      userColor: '#000',
      userName: 'Spoofed Owner',
      cursorX: 99,
      cursorY: 99,
      isDrawing: true,
      currentTool: 'brush',
      editKey,
    })
    expect(spoof?.presenceId).toBeTruthy()
    expect(spoof?.presenceId).not.toBe(ownerPresence?.presenceId)

    // An unauthenticated caller claiming the owner's userId (an old tab) is a no-op
    expect(
      await t.mutation(api.presence.updatePresence, {
        sessionId,
        userId: ownerId,
        userColor: '#000',
        userName: 'Old tab',
        cursorX: 5,
        cursorY: 5,
        isDrawing: false,
        currentTool: 'brush',
        editKey,
      })
    ).toBeNull()

    await asOutsider.mutation(api.presence.leaveSession, {
      sessionId,
      userId: ownerId,
      editKey,
    })

    const active = await asOwner.query(api.presence.getSessionPresence, { sessionId })
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ userId: ownerId, userName: 'Owner', cursorX: 10 })
  })

  test('strokes and liveStrokes prevent userId spoofing and cross-session layer injection', async () => {
    const editKey = 'stroke-spoof-collab-key'
    const { t, ownerId, sessionId, otherLayerId, asOwner, asOutsider } = await seedAuthFixture({
      isPublic: true,
      editKey,
    })

    // Spoofing another user's userId on addStroke fails even with a valid editKey
    await expect(
      asOutsider.mutation(api.strokes.addStroke, {
        sessionId,
        userId: ownerId,
        userColor: '#000',
        points: [{ x: 1, y: 2 }],
        brushColor: '#000',
        brushSize: 5,
        opacity: 1,
        editKey,
      })
    ).rejects.toThrow('Unauthorized')

    // Cross-session layerId injection fails
    await expect(
      asOwner.mutation(api.strokes.addStroke, {
        sessionId,
        layerId: otherLayerId,
        userColor: '#000',
        points: [{ x: 1, y: 2 }],
        brushColor: '#000',
        brushSize: 5,
        opacity: 1,
      })
    ).rejects.toThrow('Layer does not belong to this session')

    // Spoofing another user's userId on updateLiveStroke fails even with a valid editKey
    await expect(
      asOutsider.mutation(api.liveStrokes.updateLiveStroke, {
        sessionId,
        userId: ownerId,
        userColor: '#000',
        userName: 'Spoof',
        points: [{ x: 1, y: 2 }],
        brushColor: '#000',
        brushSize: 5,
        opacity: 1,
        editKey,
      })
    ).rejects.toThrow('Unauthorized')

    // Legitimate stroke derives userId from ctx.auth even when omitted by caller
    const strokeId = await asOwner.mutation(api.strokes.addStroke, {
      sessionId,
      userColor: '#000',
      points: [{ x: 1, y: 2 }],
      brushColor: '#000',
      brushSize: 5,
      opacity: 1,
    })
    const saved = await t.run(async (ctx) => await ctx.db.get(strokeId))
    expect(saved?.userId).toBe(ownerId)
  })

  test('viewerAcks read queries enforce session access and soft-deleted sessions stay hidden', async () => {
    const { t, ownerId, sessionId, asOwner, asOutsider } = await seedAuthFixture()

    await asOwner.mutation(api.viewerAcks.upsertViewerState, {
      sessionId,
      viewerId: ownerId,
      lastAckedStrokeOrder: 7,
    })

    expect(
      await asOutsider.query(api.viewerAcks.getViewerState, { sessionId, viewerId: ownerId })
    ).toBeNull()
    expect(
      await asOutsider.query(api.viewerAcks.getAllViewerStatesForSession, { sessionId })
    ).toEqual([])
    expect(
      await asOwner.query(api.viewerAcks.getViewerState, { sessionId, viewerId: ownerId })
    ).toMatchObject({ lastAckedStrokeOrder: 7 })

    // Soft-delete session: reads across all session tables must return empty/null
    await t.run(async (ctx) => {
      await ctx.db.patch(sessionId, { deletedAt: Date.now() })
    })
    expect(
      await asOwner.query(api.viewerAcks.getViewerState, { sessionId, viewerId: ownerId })
    ).toBeNull()
    expect(await asOwner.query(api.paintingSessions.getAIPrompts, { sessionId })).toEqual([])
    expect(await asOwner.query(api.paintLayers.getPaintLayers, { sessionId })).toEqual([])
    expect(await asOwner.query(api.presence.getSessionPresence, { sessionId })).toEqual([])
  })

  test('claimSessionOwnership refuses private orphaned sessions', async () => {
    const t = createTestBackend()
    const { privateOrphanId, asClaimer } = await t.run(async (ctx) => {
      await ctx.db.insert('users', { authId: 'claimer', email: 'claimer@example.com' })
      const privateOrphanId = await ctx.db.insert('paintingSessions', {
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      return { privateOrphanId, asClaimer: null as unknown as Id<'users'> }
    })
    void asClaimer

    await t
      .withIdentity({ subject: 'claimer' })
      .mutation(api.paintingSessions.claimSessionOwnership, { sessionId: privateOrphanId })

    const after = await t.run(async (ctx) => await ctx.db.get(privateOrphanId))
    expect(after?.createdBy).toBeUndefined()
  })
})
