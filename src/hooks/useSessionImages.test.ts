import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'
import { modules } from '../../convex/test.setup'
import { partitionSessionImages, type RawSessionImageRecord } from './useSessionImages'

describe('partitionSessionImages', () => {
  test('returns stable empty arrays for undefined or empty payloads', () => {
    const emptyFromUndefined = partitionSessionImages(undefined)
    const emptyFromArray = partitionSessionImages([])

    expect(emptyFromUndefined.images).toEqual([])
    expect(emptyFromUndefined.uploadedImages).toEqual([])
    expect(emptyFromUndefined.aiImages).toEqual([])

    expect(emptyFromArray.images).toBe(emptyFromUndefined.images)
    expect(emptyFromArray.uploadedImages).toBe(emptyFromUndefined.uploadedImages)
    expect(emptyFromArray.aiImages).toBe(emptyFromUndefined.aiImages)
  })

  test('partitions mixed uploaded and AI images while preserving layerOrder and all fields', () => {
    const sessionId = 'session_1' as Id<'paintingSessions'>
    const raw: RawSessionImageRecord[] = [
      {
        _id: 'upload_1',
        _creationTime: 100,
        sessionId,
        storageId: 'storage_1' as Id<'_storage'>,
        filename: 'photo.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        x: 400,
        y: 300,
        scale: 1,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
        url: 'https://cdn.example/photo.png',
        type: 'uploaded',
      },
      {
        _id: 'ai_1',
        _creationTime: 200,
        sessionId,
        storageId: null,
        filename: 'ai-generated.png',
        mimeType: 'image/png',
        imageUrl: 'https://cdn.example/ai-1.png',
        url: 'https://cdn.example/ai-1.png',
        width: 1024,
        height: 768,
        x: 500,
        y: 350,
        scale: 0.75,
        scaleX: 0.8,
        scaleY: 0.7,
        rotation: 15,
        opacity: 0.9,
        layerOrder: 2,
        createdAt: 201,
        type: 'ai-generated',
      },
      {
        _id: 'ai_2',
        _creationTime: 300,
        sessionId,
        storageId: null,
        filename: 'ai-generated.png',
        mimeType: 'image/png',
        imageUrl: 'https://cdn.example/ai-2.png',
        url: 'https://cdn.example/ai-2.png',
        width: 512,
        height: 512,
        x: 256,
        y: 256,
        scale: 1,
        rotation: 0,
        opacity: 1,
        layerOrder: 4,
        createdAt: 301,
        type: 'ai-generated',
      },
    ]

    const result = partitionSessionImages(raw)

    expect(result.images.map((i) => i._id)).toEqual(['upload_1', 'ai_1', 'ai_2'])
    expect(result.uploadedImages).toHaveLength(1)
    expect(result.uploadedImages[0]).toMatchObject({
      _id: 'upload_1',
      filename: 'photo.png',
      url: 'https://cdn.example/photo.png',
      layerOrder: 1,
      type: 'uploaded',
    })

    expect(result.aiImages).toHaveLength(2)
    expect(result.aiImages[0]).toEqual({
      _id: 'ai_1',
      _creationTime: 200,
      sessionId,
      imageUrl: 'https://cdn.example/ai-1.png',
      url: 'https://cdn.example/ai-1.png',
      width: 1024,
      height: 768,
      x: 500,
      y: 350,
      scale: 0.75,
      scaleX: 0.8,
      scaleY: 0.7,
      rotation: 15,
      opacity: 0.9,
      layerOrder: 2,
      createdAt: 201,
      type: 'ai-generated',
    })
    expect(result.aiImages[1].layerOrder).toBe(4)
  })

  test('maintains exact AI-image field parity with api.images.getAIGeneratedImages', async () => {
    const t = convexTest(schema, modules)
    const guestKey = 'guest-parity-secret'

    const sessionId = await t.mutation(api.paintingSessions.createSession, {
      name: 'Parity Session',
      canvasWidth: 800,
      canvasHeight: 600,
      isPublic: false,
      guestKey,
    })

    // Unplaced outputs of completed AI generations (as completeOperation
    // writes them): the only blobs addAIGeneratedImage accepts.
    const seedOutput = (prompt: string) =>
      t.run(async (ctx) => {
        const storageId = await ctx.storage.store(
          new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
        )
        await ctx.db.insert('aiGenerations', {
          sessionId,
          prompt,
          status: 'completed',
          provider: 'gemini',
          generatedImageId: storageId,
          createdAt: Date.now(),
          completedAt: Date.now(),
          outputExpiresAt: Date.now() + 60_000,
        })
        return storageId
      })
    const [output1, output2] = [await seedOutput('first'), await seedOutput('second')]

    const aiImageId1 = await t.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      guestKey,
      storageId: output1,
      width: 1024,
      height: 768,
      canvasWidth: 800,
      canvasHeight: 600,
    })

    const aiImageId2 = await t.mutation(api.images.addAIGeneratedImage, {
      sessionId,
      guestKey,
      storageId: output2,
      width: 512,
      height: 512,
      canvasWidth: 800,
      canvasHeight: 600,
    })

    await t.mutation(api.images.updateAIImageTransform, {
      imageId: aiImageId1,
      guestKey,
      x: 120,
      y: 240,
      scaleX: 0.6,
      scaleY: 0.5,
      rotation: 30,
      opacity: 0.85,
    })

    const [combinedImages, directAIImages] = await Promise.all([
      t.query(api.images.getSessionImages, { sessionId, guestKey }),
      t.query(api.images.getAIGeneratedImages, { sessionId, guestKey }),
    ])

    const { aiImages } = partitionSessionImages(combinedImages as RawSessionImageRecord[])

    expect(aiImages.map((img) => img._id)).toEqual([aiImageId1, aiImageId2])
    expect(aiImages).toHaveLength(directAIImages.length)

    directAIImages.forEach((directDoc, idx) => {
      const derived = aiImages[idx]
      expect(derived._id).toBe(directDoc._id)
      expect(derived._creationTime).toBe(directDoc._creationTime)
      expect(derived.sessionId).toBe(directDoc.sessionId)
      expect(derived.imageUrl).toBe(directDoc.imageUrl)
      expect(derived.url).toBe(directDoc.imageUrl)
      expect(derived.width).toBe(directDoc.width)
      expect(derived.height).toBe(directDoc.height)
      expect(derived.x).toBe(directDoc.x)
      expect(derived.y).toBe(directDoc.y)
      expect(derived.scale).toBe(directDoc.scale)
      expect(derived.scaleX).toBe(directDoc.scaleX)
      expect(derived.scaleY).toBe(directDoc.scaleY)
      expect(derived.rotation).toBe(directDoc.rotation)
      expect(derived.opacity).toBe(directDoc.opacity)
      expect(derived.layerOrder).toBe(directDoc.layerOrder)
      expect(derived.createdAt).toBe(directDoc.createdAt)
    })
  })
})
