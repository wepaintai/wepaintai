import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { hasValidEditKey } from './sessionAuth'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

function makePngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(32))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

async function addSecondLayer(fixture: { t: ReturnType<typeof createTestBackend>; sessionId: Id<'paintingSessions'> }) {
  return await fixture.t.run((ctx) =>
    ctx.db.insert('paintLayers', {
      sessionId: fixture.sessionId,
      name: 'Layer 2',
      layerOrder: 3,
      visible: true,
      opacity: 1,
      createdAt: Date.now(),
    }),
  )
}

async function seedSharingFixture(options: {
  isPublic?: boolean
  editKey?: string
  guestOwnerKey?: string
  orphan?: boolean
} = {}) {
  const t = createTestBackend()
  const seeded = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      authId: 'share-owner',
      email: 'owner@example.com',
      tokens: 10,
      lifetimeTokensUsed: 0,
    })
    const viewerId = await ctx.db.insert('users', {
      authId: 'share-viewer',
      email: 'viewer@example.com',
      tokens: 10,
      lifetimeTokensUsed: 0,
    })

    const sessionId = await ctx.db.insert('paintingSessions', {
      name: 'Shared Canvas',
      createdBy: options.orphan || options.guestOwnerKey ? undefined : ownerId,
      guestOwnerKey: options.guestOwnerKey,
      editKey: options.editKey,
      isPublic: options.isPublic ?? true,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 1,
      paintLayerOrder: 0,
      paintLayerVisible: true,
      aiPrompts: ['existing prompt'],
    })

    const layerId = await ctx.db.insert('paintLayers', {
      sessionId,
      name: 'Layer 1',
      layerOrder: 0,
      visible: true,
      opacity: 1,
      createdBy: options.orphan || options.guestOwnerKey ? undefined : ownerId,
      createdAt: Date.now(),
    })

    const strokeId = await ctx.db.insert('strokes', {
      sessionId,
      layerId,
      userId: options.orphan || options.guestOwnerKey ? undefined : ownerId,
      userColor: '#112233',
      points: [{ x: 10, y: 20 }],
      brushColor: '#112233',
      brushSize: 8,
      opacity: 1,
      strokeOrder: 1,
    })

    const storageId = await ctx.storage.store(
      new Blob([makePngBytes(120, 90)], { type: 'image/png' }),
    )
    const uploadedImageId = await ctx.db.insert('uploadedImages', {
      sessionId,
      storageId,
      filename: 'seed.png',
      mimeType: 'image/png',
      width: 120,
      height: 90,
      x: 100,
      y: 100,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 1,
    })

    const aiImageId = await ctx.db.insert('aiGeneratedImages', {
      sessionId,
      imageUrl: 'https://example.com/seeded-ai.png',
      width: 200,
      height: 200,
      x: 200,
      y: 200,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 2,
      createdAt: Date.now(),
    })

    return { ownerId, viewerId, sessionId, layerId, strokeId, uploadedImageId, aiImageId }
  })

  return {
    t,
    ...seeded,
    asOwner: t.withIdentity({ subject: 'share-owner' }),
    asViewer: t.withIdentity({ subject: 'share-viewer' }),
  }
}

type Fixture = Awaited<ReturnType<typeof seedSharingFixture>>
type Caller = Fixture['t'] | Fixture['asViewer']
type KeyArgs = { editKey?: string; guestKey?: string }

/**
 * Every session-scoped write a non-editor must be denied: strokes, live
 * strokes, uploads, images, paint layers (both modules), unified reorder,
 * thumbnails/prompts, viewer state and WebRTC signaling.
 */
async function expectEveryWriteDenied(
  caller: Caller,
  ids: {
    sessionId: Id<'paintingSessions'>
    layerId: Id<'paintLayers'>
    otherLayerId: Id<'paintLayers'>
    strokeId: Id<'strokes'>
    uploadedImageId: Id<'uploadedImages'>
    aiImageId: Id<'aiGeneratedImages'>
  },
  keys: KeyArgs,
) {
  const { sessionId, layerId, otherLayerId, strokeId, uploadedImageId, aiImageId } = ids
  // Owner-only mutations take no editKey argument at all
  const ownerKeys = keys.guestKey !== undefined ? { guestKey: keys.guestKey } : {}
  const denied: Array<[string, () => Promise<unknown>]> = [
    ['strokes.addStroke', () => caller.mutation(api.strokes.addStroke, {
      sessionId, layerId, userColor: '#f00', points: [{ x: 1, y: 2 }],
      brushColor: '#f00', brushSize: 5, opacity: 1, ...keys,
    })],
    ['strokes.removeLastStroke', () => caller.mutation(api.strokes.removeLastStroke, { sessionId, ...keys })],
    ['strokes.restoreLastDeletedStroke', () => caller.mutation(api.strokes.restoreLastDeletedStroke, { sessionId, ...keys })],
    ['strokes.deleteStroke', () => caller.mutation(api.strokes.deleteStroke, { strokeId, ...ownerKeys })],
    ['strokes.clearSession', () => caller.mutation(api.strokes.clearSession, { sessionId, ...ownerKeys })],
    ['liveStrokes.updateLiveStroke', () => caller.mutation(api.liveStrokes.updateLiveStroke, {
      sessionId, userColor: '#f00', userName: 'Vandal', points: [{ x: 1, y: 2 }],
      brushColor: '#f00', brushSize: 5, opacity: 1, ...keys,
    })],
    ['liveStrokes.clearLiveStroke', () => caller.mutation(api.liveStrokes.clearLiveStroke, { sessionId, guestId: 'g', ...keys })],
    ['liveStrokes.clearSessionLiveStrokes', () => caller.mutation(api.liveStrokes.clearSessionLiveStrokes, { sessionId, ...ownerKeys })],
    ['images.createUploadIntent', () => caller.mutation(api.images.createUploadIntent, { sessionId, ...keys })],
    ['images.addAIGeneratedImage', () => caller.mutation(api.images.addAIGeneratedImage, {
      sessionId, imageUrl: 'https://example.com/vandal.png', width: 100, height: 100, ...keys,
    })],
    ['images.updateImageTransform', () => caller.mutation(api.images.updateImageTransform, { imageId: uploadedImageId, x: 999, ...keys })],
    ['images.updateAIImageTransform', () => caller.mutation(api.images.updateAIImageTransform, { imageId: aiImageId, x: 999, ...keys })],
    ['images.updateImageLayerOrder', () => caller.mutation(api.images.updateImageLayerOrder, { imageId: uploadedImageId, newLayerOrder: 0, ...keys })],
    ['images.updateAIImageLayerOrder', () => caller.mutation(api.images.updateAIImageLayerOrder, { imageId: aiImageId, newLayerOrder: 0, ...keys })],
    ['images.deleteImage', () => caller.mutation(api.images.deleteImage, { imageId: uploadedImageId, ...keys })],
    ['images.deleteAIImage', () => caller.mutation(api.images.deleteAIImage, { imageId: aiImageId, ...keys })],
    ['paintLayers.createPaintLayer', () => caller.mutation(api.paintLayers.createPaintLayer, { sessionId, name: 'Vandal', ...keys })],
    ['paintLayers.updatePaintLayer', () => caller.mutation(api.paintLayers.updatePaintLayer, { layerId, visible: false, ...keys })],
    ['paintLayers.updatePaintLayerTransform', () => caller.mutation(api.paintLayers.updatePaintLayerTransform, { layerId, x: 5, ...keys })],
    ['paintLayers.deletePaintLayer', () => caller.mutation(api.paintLayers.deletePaintLayer, { layerId, ...keys })],
    ['paintLayers.reorderPaintLayer', () => caller.mutation(api.paintLayers.reorderPaintLayer, { layerId, newOrder: 3, ...keys })],
    ['paintLayers.mergePaintLayers', () => caller.mutation(api.paintLayers.mergePaintLayers, {
      sourceLayerId: otherLayerId, targetLayerId: layerId, ...keys,
    })],
    ['paintLayers.ensureDefaultPaintLayer', () => caller.mutation(api.paintLayers.ensureDefaultPaintLayer, { sessionId, ...keys })],
    ['paintLayer.updatePaintLayerOrder', () => caller.mutation(api.paintLayer.updatePaintLayerOrder, { sessionId, newLayerOrder: 1, ...keys })],
    ['paintLayer.updatePaintLayerVisibility', () => caller.mutation(api.paintLayer.updatePaintLayerVisibility, { sessionId, visible: false, ...keys })],
    ['paintLayer.normalizeLayerOrders', () => caller.mutation(api.paintLayer.normalizeLayerOrders, { sessionId, ...keys })],
    ['layers.reorderLayer', () => caller.mutation(api.layers.reorderLayer, { sessionId, layerId, newOrder: 2, ...keys })],
    ['paintingSessions.updateSessionThumbnail', () => caller.mutation(api.paintingSessions.updateSessionThumbnail, {
      sessionId, thumbnailUrl: 'https://cdn.example.com/vandal.png', ...keys,
    })],
    ['paintingSessions.addAIPrompt', () => caller.mutation(api.paintingSessions.addAIPrompt, { sessionId, prompt: 'vandal', ...keys })],
    ['viewerAcks.upsertViewerState', () => caller.mutation(api.viewerAcks.upsertViewerState, {
      sessionId, viewerId: 'vandal-viewer', lastAckedStrokeOrder: 99, ...keys,
    })],
    ['viewerAcks.removeViewerState', () => caller.mutation(api.viewerAcks.removeViewerState, { sessionId, viewerId: 'vandal-viewer', ...keys })],
    ['webrtc.joinP2PSession', () => caller.mutation(api.webrtc.joinP2PSession, { sessionId, peerId: 'vandal-peer', ...keys })],
    ['webrtc.sendSignal', () => caller.mutation(api.webrtc.sendSignal, {
      sessionId, fromPeerId: 'vandal-peer', toPeerId: 'owner-peer', type: 'offer', data: { sdp: 'x' }, ...keys,
    })],
    ['webrtc.getSignals', () => caller.query(api.webrtc.getSignals, { sessionId, peerId: 'owner-peer', ...keys })],
    ['webrtc.deleteSignals', () => caller.mutation(api.webrtc.deleteSignals, { sessionId, peerId: 'owner-peer', signalIds: [], ...keys })],
    ['webrtc.leaveP2PSession', () => caller.mutation(api.webrtc.leaveP2PSession, { sessionId, peerId: 'owner-peer', ...keys })],
  ]
  for (const [name, run] of denied) {
    await expect(run(), name).rejects.toThrow('Unauthorized')
  }
  // Presence is best-effort: a non-editor's update is ignored, never written
  expect(
    await caller.mutation(api.presence.updatePresence, {
      sessionId, guestId: 'vandal-guest', userColor: '#f00', userName: 'Vandal',
      cursorX: 1, cursorY: 2, isDrawing: false, currentTool: 'brush', ...keys,
    }),
  ).toBeNull()
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AUD-005 public read-only viewing and secret edit links', () => {
  test('public (isPublic: true) viewers can read everything but cannot mutate any session resource', async () => {
    const {
      t,
      sessionId,
      layerId,
      strokeId,
      uploadedImageId,
      aiImageId,
      asViewer,
    } = await seedSharingFixture({ isPublic: true })

    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate')
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // Both anonymous and signed-in non-owner viewers CAN read
    for (const caller of [t, asViewer]) {
      const sessionRes = await caller.query(api.paintingSessions.getSession, { sessionId })
      expect(sessionRes.status).toBe('ok')
      if (sessionRes.status === 'ok') {
        expect(sessionRes.canEdit).toBe(false)
        expect(sessionRes.isOwner).toBe(false)
        expect(sessionRes.session.isPublic).toBe(true)
        expect(sessionRes.session.hasEditLink).toBe(false)
      }
      expect(await caller.query(api.strokes.getSessionStrokes, { sessionId })).toHaveLength(1)
      expect(await caller.query(api.images.getSessionImages, { sessionId })).toHaveLength(2)
      expect(await caller.query(api.images.getAIGeneratedImages, { sessionId })).toHaveLength(1)
      expect(await caller.query(api.paintLayers.getPaintLayers, { sessionId })).toHaveLength(1)
      expect(await caller.query(api.paintingSessions.getAIPrompts, { sessionId })).toEqual([
        'existing prompt',
      ])
    }

    // Both anonymous and signed-in non-owner viewers CANNOT mutate strokes, images, layers, presence, or upload URLs
    for (const caller of [t, asViewer]) {
      await expect(
        caller.mutation(api.strokes.addStroke, {
          sessionId,
          layerId,
          userColor: '#f00',
          points: [{ x: 1, y: 2 }],
          brushColor: '#f00',
          brushSize: 5,
          opacity: 1,
        }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.strokes.removeLastStroke, { sessionId }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.strokes.restoreLastDeletedStroke, { sessionId }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.strokes.deleteStroke, { strokeId }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.strokes.clearSession, { sessionId }),
      ).rejects.toThrow('Unauthorized')

      await expect(
        caller.mutation(api.liveStrokes.updateLiveStroke, {
          sessionId,
          userColor: '#f00',
          userName: 'Vandal',
          points: [{ x: 1, y: 2 }],
          brushColor: '#f00',
          brushSize: 5,
          opacity: 1,
        }),
      ).rejects.toThrow('Unauthorized')

      await expect(
        caller.mutation(api.images.createUploadIntent, { sessionId }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.images.addAIGeneratedImage, {
          sessionId,
          imageUrl: 'https://example.com/vandal.png',
          width: 100,
          height: 100,
        }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.images.updateImageTransform, {
          imageId: uploadedImageId,
          x: 999,
        }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.images.deleteImage, { imageId: uploadedImageId }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.images.deleteAIImage, { imageId: aiImageId }),
      ).rejects.toThrow('Unauthorized')

      await expect(
        caller.mutation(api.paintLayers.createPaintLayer, {
          sessionId,
          name: 'Vandal Layer',
        }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.paintLayers.updatePaintLayer, {
          layerId,
          visible: false,
        }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.layers.reorderLayer, {
          sessionId,
          layerId,
          newOrder: 2,
        }),
      ).rejects.toThrow('Unauthorized')

      await expect(
        caller.mutation(api.paintingSessions.updateSessionThumbnail, {
          sessionId,
          thumbnailUrl: 'data:image/jpeg;base64,vandal',
        }),
      ).rejects.toThrow('Unauthorized')
      await expect(
        caller.mutation(api.paintingSessions.addAIPrompt, {
          sessionId,
          prompt: 'vandal prompt',
        }),
      ).rejects.toThrow('Unauthorized')
      // Presence is best-effort: unauthorized callers are ignored (null), not rejected
      expect(
        await caller.mutation(api.presence.updatePresence, {
          sessionId,
          guestId: 'viewer-guest',
          userColor: '#f00',
          userName: 'Viewer',
          cursorX: 1,
          cursorY: 2,
          isDrawing: false,
          currentTool: 'brush',
        }),
      ).toBeNull()
      await expect(
        caller.mutation(api.webrtc.joinP2PSession, {
          sessionId,
          peerId: 'vandal-peer',
        }),
      ).rejects.toThrow('Unauthorized')
    }

    // Signed-in non-owner viewer on public session CANNOT run AI actions without editKey
    const aiRes = await asViewer.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'vandalize canvas',
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
    })
    expect(aiRes).toEqual({ success: false, error: 'Unauthorized' })

    const geminiRes = await asViewer.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'vandalize canvas',
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
    })
    expect(geminiRes).toEqual({ success: false, error: 'Unauthorized' })

    await expect(
      asViewer.action(api.backgroundRemoval.removeBackground, {
        sessionId,
        imageData: 'data:image/png;base64,' + 'A'.repeat(200),
      }),
    ).rejects.toThrow("You don't have permission")

    const mergeRes = await asViewer.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: uploadedImageId,
      secondLayerId: aiImageId,
      mergeMode: 'full',
    })
    expect(mergeRes).toEqual({ success: false, error: 'Unauthorized' })

    // No external provider calls were made
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('collaborator with valid editKey can read private session and edit, but cannot perform owner-only actions', async () => {
    const {
      t,
      sessionId,
      layerId,
      strokeId,
      uploadedImageId,
      aiImageId,
      asOwner,
      asViewer,
    } = await seedSharingFixture({ isPublic: false })

    // Private session without editKey is completely inaccessible
    expect(await t.query(api.paintingSessions.getSession, { sessionId })).toEqual({
      status: 'unauthorized',
    })
    expect(await asViewer.query(api.paintingSessions.getSession, { sessionId })).toEqual({
      status: 'unauthorized',
    })

    // Owner creates edit link
    const editKey = await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })
    expect(editKey.length).toBeGreaterThanOrEqual(32)
    // Calling enableEditLink again is idempotent
    expect(await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })).toBe(editKey)

    // Collaborator with editKey CAN read even while isPublic is false
    const collabSession = await asViewer.query(api.paintingSessions.getSession, {
      sessionId,
      editKey,
    })
    expect(collabSession.status).toBe('ok')
    if (collabSession.status === 'ok') {
      expect(collabSession.canEdit).toBe(true)
      expect(collabSession.isOwner).toBe(false)
      expect(collabSession.session.hasEditLink).toBe(true)
    }

    // Anonymous collaborator with editKey can read strokes, draw, create layers, and upload images
    expect(await t.query(api.strokes.getSessionStrokes, { sessionId, editKey })).toHaveLength(1)
    const newStrokeId = await t.mutation(api.strokes.addStroke, {
      sessionId,
      layerId,
      userColor: '#00ff00',
      points: [{ x: 5, y: 6 }],
      brushColor: '#00ff00',
      brushSize: 10,
      opacity: 1,
      editKey,
    })
    expect(newStrokeId).toBeTruthy()

    const newLayerId = await t.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Collaborator Layer',
      editKey,
    })
    expect(newLayerId).toBeTruthy()

    const intent = await t.mutation(api.images.createUploadIntent, { sessionId, editKey })
    const uploadResponse = await t.fetch('/uploads/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-Upload-Intent': intent.intentId,
        'X-Upload-Token': intent.uploadToken,
      },
      body: makePngBytes(64, 64),
    })
    expect(uploadResponse.status).toBe(200)
    const uploadedId = await t.mutation(api.images.commitImageUpload, {
      sessionId,
      intentId: intent.intentId,
      uploadToken: intent.uploadToken,
      filename: 'collab.png',
      x: 50,
      y: 50,
      editKey,
    })
    expect(uploadedId).toBeTruthy()

    // The edit key is only accepted in the editKey slot: the guest owner key
    // and the edit key are separate secrets
    await expect(
      t.mutation(api.images.updateImageTransform, {
        imageId: uploadedImageId,
        rotation: 15,
        guestKey: editKey,
      }),
    ).rejects.toThrow('Unauthorized')
    await t.mutation(api.images.updateImageTransform, {
      imageId: uploadedImageId,
      rotation: 15,
      editKey,
    })

    // Hard-destructive operations are owner-only: an edit-link holder can't
    // permanently destroy the owner's work, whichever slot carries the key
    for (const keys of [{ editKey }, { guestKey: editKey }, { editKey, guestKey: editKey }]) {
      for (const caller of [t, asViewer]) {
        await expect(
          caller.mutation(api.paintLayers.deletePaintLayer, { layerId, ...keys }),
        ).rejects.toThrow('Unauthorized')
        await expect(
          caller.mutation(api.paintLayers.mergePaintLayers, {
            sourceLayerId: newLayerId,
            targetLayerId: layerId,
            ...keys,
          }),
        ).rejects.toThrow('Unauthorized')
        await expect(
          caller.mutation(api.images.deleteImage, { imageId: uploadedImageId, ...keys }),
        ).rejects.toThrow('Unauthorized')
        await expect(
          caller.mutation(api.images.deleteAIImage, { imageId: aiImageId, ...keys }),
        ).rejects.toThrow('Unauthorized')
      }
    }
    const survivors = await t.run(async (ctx) => ({
      layer: await ctx.db.get(layerId),
      newLayer: await ctx.db.get(newLayerId),
      image: await ctx.db.get(uploadedImageId),
      ai: await ctx.db.get(aiImageId),
      stroke: await ctx.db.get(strokeId),
    }))
    expect(survivors.layer).not.toBeNull()
    expect(survivors.newLayer).not.toBeNull()
    expect(survivors.image).not.toBeNull()
    expect(survivors.ai).not.toBeNull()
    expect(survivors.stroke).not.toBeNull()

    // The owner can still perform them
    await asOwner.mutation(api.paintLayers.mergePaintLayers, {
      sourceLayerId: newLayerId,
      targetLayerId: layerId,
    })
    await asOwner.mutation(api.images.deleteAIImage, { imageId: aiImageId })
    expect(await t.run((ctx) => ctx.db.get(aiImageId))).toBeNull()

    // Collaborator with editKey CANNOT perform ANY owner-only action (even if passed as guestKey!)
    await expect(
      asViewer.mutation(api.paintingSessions.setSessionVisibility, {
        sessionId,
        isPublic: true,
        guestKey: editKey,
      }),
    ).rejects.toThrow('Only the owner can change visibility')
    await expect(
      asViewer.mutation(api.paintingSessions.enableEditLink, {
        sessionId,
        guestKey: editKey,
      }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      asViewer.mutation(api.paintingSessions.rotateEditLink, {
        sessionId,
        guestKey: editKey,
      }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      asViewer.mutation(api.paintingSessions.revokeEditLink, {
        sessionId,
        guestKey: editKey,
      }),
    ).rejects.toThrow('Unauthorized')
    expect(
      await asViewer.query(api.paintingSessions.getSessionEditKey, {
        sessionId,
        guestKey: editKey,
      }),
    ).toBeNull()
    await expect(
      asViewer.mutation(api.paintingSessions.updateSessionName, {
        sessionId,
        name: 'Hijacked Name',
      }),
    ).rejects.toThrow('You can only rename your own sessions')
    await expect(
      asViewer.mutation(api.paintingSessions.deleteSession, { sessionId }),
    ).rejects.toThrow('You can only delete your own sessions')
    expect(
      await asViewer.mutation(api.paintingSessions.restoreSession, { sessionId }),
    ).toBe('not_found')
    await expect(
      asViewer.mutation(api.strokes.clearSession, { sessionId, guestKey: editKey }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      asViewer.mutation(api.strokes.deleteStroke, { strokeId, guestKey: editKey }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      asViewer.mutation(api.liveStrokes.clearSessionLiveStrokes, {
        sessionId,
        guestKey: editKey,
      }),
    ).rejects.toThrow('Unauthorized')
  })

  test('rotating and revoking editKey immediately invalidates previous edit links', async () => {
    const { t, sessionId, layerId, asOwner } = await seedSharingFixture({ isPublic: false })

    const firstKey = await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })
    expect(
      await asOwner.query(api.paintingSessions.getSessionEditKey, { sessionId }),
    ).toBe(firstKey)

    // First key works
    await t.mutation(api.strokes.addStroke, {
      sessionId,
      layerId,
      userColor: '#000',
      points: [{ x: 1, y: 1 }],
      brushColor: '#000',
      brushSize: 4,
      opacity: 1,
      editKey: firstKey,
    })

    // Rotate edit link -> new key differs and firstKey is immediately rejected
    const secondKey = await asOwner.mutation(api.paintingSessions.rotateEditLink, { sessionId })
    expect(secondKey).not.toBe(firstKey)
    expect(
      await t.query(api.paintingSessions.getSession, { sessionId, editKey: firstKey }),
    ).toEqual({ status: 'unauthorized' })
    await expect(
      t.mutation(api.strokes.addStroke, {
        sessionId,
        layerId,
        userColor: '#000',
        points: [{ x: 2, y: 2 }],
        brushColor: '#000',
        brushSize: 4,
        opacity: 1,
        editKey: firstKey,
      }),
    ).rejects.toThrow('Unauthorized')

    // Second key works immediately
    await t.mutation(api.strokes.addStroke, {
      sessionId,
      layerId,
      userColor: '#000',
      points: [{ x: 3, y: 3 }],
      brushColor: '#000',
      brushSize: 4,
      opacity: 1,
      editKey: secondKey,
    })

    // Make session public, then revoke edit link -> secondKey drops to view-only (canEdit: false)
    await asOwner.mutation(api.paintingSessions.setSessionVisibility, {
      sessionId,
      isPublic: true,
    })
    await asOwner.mutation(api.paintingSessions.revokeEditLink, { sessionId })

    expect(await asOwner.query(api.paintingSessions.getSessionEditKey, { sessionId })).toBeNull()
    const afterRevoke = await t.query(api.paintingSessions.getSession, {
      sessionId,
      editKey: secondKey,
    })
    expect(afterRevoke.status).toBe('ok')
    if (afterRevoke.status === 'ok') {
      expect(afterRevoke.canEdit).toBe(false)
      expect(afterRevoke.session.hasEditLink).toBe(false)
    }
    await expect(
      t.mutation(api.strokes.addStroke, {
        sessionId,
        layerId,
        userColor: '#000',
        points: [{ x: 4, y: 4 }],
        brushColor: '#000',
        brushSize: 4,
        opacity: 1,
        editKey: secondKey,
      }),
    ).rejects.toThrow('Unauthorized')
  })

  test('guest owners can manage edit links and collaborators cannot claim guest ownership with editKey', async () => {
    const guestOwnerKey = 'guest-owner-secret-key'
    const { t, sessionId, asViewer } = await seedSharingFixture({
      isPublic: false,
      guestOwnerKey,
    })

    const editKey = await t.mutation(api.paintingSessions.enableEditLink, {
      sessionId,
      guestKey: guestOwnerKey,
    })
    expect(editKey).not.toBe(guestOwnerKey)
    expect(
      await t.query(api.paintingSessions.getSessionEditKey, {
        sessionId,
        guestKey: guestOwnerKey,
      }),
    ).toBe(editKey)

    // Collaborator holding editKey cannot claim ownership via claimGuestSession or claimSessionOwnership
    expect(
      await asViewer.mutation(api.paintingSessions.claimGuestSession, {
        sessionId,
        guestKey: editKey,
      }),
    ).toBe('invalid')
    await asViewer.mutation(api.paintingSessions.claimSessionOwnership, {
      sessionId,
      guestKey: editKey,
    })
    const afterAttempt = await t.run((ctx) => ctx.db.get(sessionId))
    expect(afterAttempt?.createdBy).toBeUndefined()
    expect(afterAttempt?.guestOwnerKey).toBe(guestOwnerKey)
  })

  test('editKey and guestOwnerKey are never leaked by getSession, listRecentSessions, or getUserSessions', async () => {
    const { t, sessionId, asOwner, asViewer } = await seedSharingFixture({
      isPublic: true,
      editKey: 'super-secret-edit-key',
    })

    // Also insert a guest-owned public session with both keys
    const guestSessionId = await t.run(async (ctx) =>
      ctx.db.insert('paintingSessions', {
        name: 'Guest Public Canvas',
        guestOwnerKey: 'super-secret-guest-key',
        editKey: 'another-secret-edit-key',
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      }),
    )

    const ownerView = await asOwner.query(api.paintingSessions.getSession, { sessionId })
    expect(ownerView.status).toBe('ok')
    if (ownerView.status === 'ok') {
      expect('editKey' in ownerView.session).toBe(false)
      expect('guestOwnerKey' in ownerView.session).toBe(false)
      expect(ownerView.session.hasEditLink).toBe(true)
    }

    const viewerView = await asViewer.query(api.paintingSessions.getSession, {
      sessionId: guestSessionId,
    })
    expect(viewerView.status).toBe('ok')
    if (viewerView.status === 'ok') {
      expect('editKey' in viewerView.session).toBe(false)
      expect('guestOwnerKey' in viewerView.session).toBe(false)
      expect(viewerView.session.hasGuestOwner).toBe(true)
      expect(viewerView.session.hasEditLink).toBe(true)
    }

    const recent = await t.query(api.paintingSessions.listRecentSessions, {})
    expect(recent.length).toBeGreaterThanOrEqual(2)
    for (const s of recent) {
      expect('editKey' in s).toBe(false)
      expect('guestOwnerKey' in s).toBe(false)
      expect(JSON.stringify(s)).not.toContain('super-secret')
      expect(JSON.stringify(s)).not.toContain('another-secret')
    }

    const owned = await asOwner.query(api.paintingSessions.getUserSessions, {})
    expect(owned).toHaveLength(1)
    expect('editKey' in owned[0]).toBe(false)
    expect('guestOwnerKey' in owned[0]).toBe(false)
    expect(JSON.stringify(owned[0])).not.toContain('super-secret')
  })

  test('legacy/orphaned isPublic: true sessions without editKey default safely to read-only and resist ownership hijacking', async () => {
    const { t, sessionId, layerId, asViewer } = await seedSharingFixture({
      isPublic: true,
      orphan: true,
    })

    // Viewable as read-only
    const res = await asViewer.query(api.paintingSessions.getSession, { sessionId })
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.canEdit).toBe(false)
      expect(res.isOwner).toBe(false)
      expect(res.session.hasEditLink).toBe(false)
    }

    // Cannot be hijacked via claimSessionOwnership
    await asViewer.mutation(api.paintingSessions.claimSessionOwnership, { sessionId })
    const afterClaim = await t.run((ctx) => ctx.db.get(sessionId))
    expect(afterClaim?.createdBy).toBeUndefined()

    // Cannot be mutated by anonymous or signed-in viewers
    await expect(
      asViewer.mutation(api.strokes.addStroke, {
        sessionId,
        layerId,
        userColor: '#000',
        points: [{ x: 1, y: 1 }],
        brushColor: '#000',
        brushSize: 5,
        opacity: 1,
      }),
    ).rejects.toThrow('Unauthorized')
  })

  test('viewer denial covers WebRTC signaling, viewer state and every layer/image mutation, with no side effects', async () => {
    const seeded = await seedSharingFixture({ isPublic: true, editKey: 'the-real-edit-key' })
    const fixture = { ...seeded, otherLayerId: await addSecondLayer(seeded) }
    await fixture.t.run(async (ctx) => {
      await ctx.db.insert('webrtcSignals', {
        sessionId: fixture.sessionId,
        fromPeerId: 'owner-peer',
        toPeerId: 'collab-peer',
        type: 'offer',
        data: { sdp: 'secret-sdp' },
        timestamp: Date.now(),
      })
    })
    const snapshot = () =>
      fixture.t.run(async (ctx) => ({
        session: await ctx.db.get(fixture.sessionId),
        strokes: await ctx.db.query('strokes').collect(),
        layers: await ctx.db.query('paintLayers').collect(),
        images: await ctx.db.query('uploadedImages').collect(),
        ai: await ctx.db.query('aiGeneratedImages').collect(),
        presence: await ctx.db.query('userPresence').collect(),
        viewerStates: await ctx.db.query('viewerStates').collect(),
        signals: await ctx.db.query('webrtcSignals').collect(),
        intents: await ctx.db.query('imageUploadIntents').collect(),
      }))
    const before = await snapshot()

    // No key, wrong key, empty key and the edit key in the wrong slot
    const keyVariants: KeyArgs[] = [
      {},
      { editKey: '' },
      { editKey: 'not-the-edit-key' },
      { guestKey: '' },
      { guestKey: 'the-real-edit-key' },
    ]
    for (const caller of [fixture.t, fixture.asViewer]) {
      for (const keys of keyVariants) {
        await expectEveryWriteDenied(caller, fixture, keys)
      }
    }
    expect(await snapshot()).toEqual(before)
  })

  test('an empty-string editKey never grants access, even against a legacy empty stored key', async () => {
    // Stored key is empty (legacy/corrupt row) and the session is private
    const seededLegacy = await seedSharingFixture({ isPublic: false, editKey: '' })
    const legacy = { ...seededLegacy, otherLayerId: await addSecondLayer(seededLegacy) }
    expect(
      await legacy.t.query(api.paintingSessions.getSession, { sessionId: legacy.sessionId, editKey: '' }),
    ).toEqual({ status: 'unauthorized' })
    expect(
      await legacy.t.query(api.strokes.getSessionStrokes, { sessionId: legacy.sessionId, editKey: '' }),
    ).toEqual([])
    await expectEveryWriteDenied(legacy.t, legacy, { editKey: '' })
    await expectEveryWriteDenied(legacy.asViewer, legacy, { editKey: '', guestKey: '' })

    // Unit level: no combination of empty/missing keys matches
    const doc = (editKey?: string) => ({ editKey }) as unknown as Parameters<typeof hasValidEditKey>[0]
    expect(hasValidEditKey(doc(''), '')).toBe(false)
    expect(hasValidEditKey(doc(undefined), '')).toBe(false)
    expect(hasValidEditKey(doc(undefined), undefined)).toBe(false)
    expect(hasValidEditKey(doc('real-key'), '')).toBe(false)
    expect(hasValidEditKey(doc('real-key'), undefined)).toBe(false)
    expect(hasValidEditKey(doc('real-key'), 'real-key')).toBe(true)
  })

  test('restoring a deleted session clears its edit link', async () => {
    const { t, sessionId, layerId, asOwner } = await seedSharingFixture({ isPublic: false })
    const editKey = await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })
    await asOwner.mutation(api.paintingSessions.deleteSession, { sessionId })
    expect(await asOwner.mutation(api.paintingSessions.restoreSession, { sessionId })).toBe('restored')

    expect(await asOwner.query(api.paintingSessions.getSessionEditKey, { sessionId })).toBeNull()
    expect(await t.query(api.paintingSessions.getSession, { sessionId, editKey })).toEqual({
      status: 'unauthorized',
    })
    await expect(
      t.mutation(api.strokes.addStroke, {
        sessionId, layerId, userColor: '#000', points: [{ x: 1, y: 1 }],
        brushColor: '#000', brushSize: 4, opacity: 1, editKey,
      }),
    ).rejects.toThrow('Unauthorized')
    // A fresh link can be issued and differs from the old one
    const fresh = await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })
    expect(fresh).not.toBe(editKey)
  })

  test('rotating or revoking the edit link evicts collaborator presence, live strokes and signals at once', async () => {
    const { t, ownerId, sessionId, asOwner, asViewer } = await seedSharingFixture({ isPublic: true })
    const presenceArgs = {
      userColor: '#123', userName: 'x', cursorX: 1, cursorY: 1, isDrawing: false, currentTool: 'brush',
    }
    const liveArgs = {
      userColor: '#123', userName: 'x', points: [{ x: 1, y: 1 }], brushColor: '#000', brushSize: 3, opacity: 1,
    }
    for (const action of ['rotate', 'revoke'] as const) {
      const editKey = await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })
      await asOwner.mutation(api.presence.updatePresence, { sessionId, ...presenceArgs })
      await asOwner.mutation(api.liveStrokes.updateLiveStroke, { sessionId, ...liveArgs })
      await asViewer.mutation(api.presence.updatePresence, { sessionId, editKey, ...presenceArgs })
      await asViewer.mutation(api.liveStrokes.updateLiveStroke, { sessionId, editKey, ...liveArgs })
      await t.mutation(api.presence.updatePresence, { sessionId, guestId: 'anon-collab', editKey, ...presenceArgs })
      await t.mutation(api.webrtc.sendSignal, {
        sessionId, fromPeerId: 'collab', toPeerId: 'owner', type: 'offer', data: {}, editKey,
      })
      const editorsBefore = await asOwner.query(api.presence.getSessionPresence, { sessionId })
      expect(editorsBefore).toHaveLength(3)

      if (action === 'rotate') {
        await asOwner.mutation(api.paintingSessions.rotateEditLink, { sessionId })
      } else {
        await asOwner.mutation(api.paintingSessions.revokeEditLink, { sessionId })
      }

      const rows = await t.run(async (ctx) => ({
        presence: await ctx.db.query('userPresence').collect(),
        live: await ctx.db.query('liveStrokes').collect(),
        signals: await ctx.db.query('webrtcSignals').collect(),
      }))
      expect(rows.presence.map((p) => p.userId)).toEqual([ownerId])
      expect(rows.live.map((l) => l.userId)).toEqual([ownerId])
      expect(rows.signals).toHaveLength(0)

      // The revoked collaborator can't re-enter the editor set
      expect(
        await asViewer.mutation(api.presence.updatePresence, { sessionId, editKey, ...presenceArgs }),
      ).toBeNull()
      expect(await asOwner.query(api.presence.getSessionPresence, { sessionId })).toHaveLength(1)
    }
  })

  test('admin path resolves legacy ownerless sessions and leaves owned sessions alone', async () => {
    const orphan = await seedSharingFixture({ isPublic: true, orphan: true })
    await expect(
      orphan.t.mutation(internal.paintingSessions.resolveOwnerlessSession, {
        sessionId: orphan.sessionId,
        action: 'assign',
      }),
    ).rejects.toThrow('ownerUserId')
    expect(
      await orphan.t.mutation(internal.paintingSessions.resolveOwnerlessSession, {
        sessionId: orphan.sessionId,
        action: 'assign',
        ownerUserId: orphan.viewerId,
      }),
    ).toBe('assigned')
    const claimed = await orphan.asViewer.query(api.paintingSessions.getSession, {
      sessionId: orphan.sessionId,
    })
    expect(claimed.status === 'ok' && claimed.isOwner && claimed.canEdit).toBe(true)
    // Now owned: a second admin call is a no-op
    expect(
      await orphan.t.mutation(internal.paintingSessions.resolveOwnerlessSession, {
        sessionId: orphan.sessionId,
        action: 'delete',
      }),
    ).toBe('has_owner')

    const orphan2 = await seedSharingFixture({ isPublic: true, orphan: true })
    expect(
      await orphan2.t.mutation(internal.paintingSessions.resolveOwnerlessSession, {
        sessionId: orphan2.sessionId,
        action: 'delete',
      }),
    ).toBe('deleted')
    expect(
      await orphan2.t.query(api.paintingSessions.getSession, { sessionId: orphan2.sessionId }),
    ).toEqual({ status: 'not_found' })

    const guestOwned = await seedSharingFixture({ guestOwnerKey: 'guest-owner' })
    expect(
      await guestOwned.t.mutation(internal.paintingSessions.resolveOwnerlessSession, {
        sessionId: guestOwned.sessionId,
        action: 'delete',
      }),
    ).toBe('has_owner')
  })

  test('signed-in collaborator with valid editKey can invoke AI actions using their own tokens', async () => {
    const { t, ownerId, viewerId, sessionId, asOwner, asViewer } = await seedSharingFixture({ isPublic: false })
    const balances = () =>
      t.run(async (ctx) => ({
        owner: (await ctx.db.get(ownerId))?.tokens,
        collaborator: (await ctx.db.get(viewerId))?.tokens,
      }))
    expect(await balances()).toEqual({ owner: 10, collaborator: 10 })
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')

    const editKey = await asOwner.mutation(api.paintingSessions.enableEditLink, { sessionId })

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'pred-collab-1' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ status: 'succeeded', output: 'https://replicate.delivery/collab.png' }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
        ),
    )

    const result = await asViewer.action(api.backgroundRemoval.removeBackground, {
      sessionId,
      imageData: 'data:image/png;base64,' + 'A'.repeat(200),
      editKey,
    })
    expect(result.success).toBe(true)

    // Billed to the collaborator who ran it, never to the session owner
    expect(await balances()).toEqual({ owner: 10, collaborator: 9 })
    const ledger = await t.run((ctx) => ctx.db.query('tokenTransactions').collect())
    expect(ledger.filter((tx) => tx.userId === ownerId)).toHaveLength(0)
    expect(ledger.filter((tx) => tx.userId === viewerId).length).toBeGreaterThan(0)
  })
})
