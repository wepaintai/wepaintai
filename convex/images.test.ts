import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
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
      new Blob(['original image'], { type: 'image/png' }),
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
  storageId: Id<'_storage'>,
) {
  return {
    sessionId,
    storageId,
    filename: 'new.png',
    mimeType: 'image/png',
    width: 200,
    height: 100,
    x: 400,
    y: 300,
  }
}

describe('image mutation authorization', () => {
  test('allows the signed-in owner and derives uploaded image attribution server-side', async () => {
    const ownerAuthId = 'image-owner'
    const { t, ownerId, sessionId, storageId } = await seedImages({ ownerAuthId })
    const owner = t.withIdentity({ subject: ownerAuthId })

    await expect(
      owner.mutation(api.images.generateUploadUrl, { sessionId }),
    ).resolves.toContain('/api/storage/upload')

    const uploadedImageId = await owner.mutation(
      api.images.uploadImage,
      uploadArgs(sessionId, storageId),
    )
    await owner.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      imageUrl: 'https://example.com/new-ai.png',
      width: 200,
      height: 100,
    })

    const uploadedImage = await t.run(async (ctx) => ctx.db.get(uploadedImageId))
    expect(uploadedImage?.userId).toBe(ownerId)
  })

  test('denies private direct-session mutations before creating records or upload URLs', async () => {
    const { t, sessionId, storageId } = await seedImages({ ownerAuthId: 'owner' })
    const outsider = t.withIdentity({ subject: 'outsider' })

    await expect(
      t.mutation(api.images.generateUploadUrl, { sessionId }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      outsider.mutation(api.images.uploadImage, uploadArgs(sessionId, storageId)),
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
      storedText: await (await ctx.storage.get(storageId))?.text(),
    }))
    expect(state.uploaded).toMatchObject({ x: 50, layerOrder: 1 })
    expect(state.ai).toMatchObject({ opacity: 1, layerOrder: 2 })
    expect(state.stroke).not.toBeNull()
    expect(state.storedText).toBe('original image')
  })

  test('requires the matching guest key and permits every image mutation with it', async () => {
    const guestKey = 'guest-image-key'
    const { t, sessionId, uploadedImageId, aiImageId } =
      await seedImages({ guestOwnerKey: guestKey })
    const newStorageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['guest image'], { type: 'image/png' })),
    )

    await expect(
      t.mutation(api.images.updateImageTransform, {
        imageId: uploadedImageId,
        x: 75,
        guestKey: 'wrong-key',
      }),
    ).rejects.toThrow('Unauthorized')
    await expect(
      t.mutation(api.images.generateUploadUrl, { sessionId, guestKey }),
    ).resolves.toContain('/api/storage/upload')
    await t.mutation(api.images.uploadImage, {
      ...uploadArgs(sessionId, newStorageId),
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

    await expect(
      t.mutation(api.images.generateUploadUrl, { sessionId }),
    ).resolves.toContain('/api/storage/upload')
    await t.mutation(api.images.updateImageTransform, {
      imageId: uploadedImageId,
      rotation: 45,
    })

    const image = await t.run(async (ctx) => ctx.db.get(uploadedImageId))
    expect(image?.rotation).toBe(45)
  })
})
