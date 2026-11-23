import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
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

    // Collaborator passing editKey via guestKey (capability compatibility) also works for editing
    await t.mutation(api.images.updateImageTransform, {
      imageId: uploadedImageId,
      rotation: 15,
      guestKey: editKey,
    })

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

  test('signed-in collaborator with valid editKey can invoke AI actions using their own tokens', async () => {
    const { sessionId, asOwner, asViewer } = await seedSharingFixture({ isPublic: false })
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
  })
})
