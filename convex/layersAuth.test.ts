import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

async function seedLayerSession(options: {
  ownerAuthId?: string
  guestOwnerKey?: string
  isPublic?: boolean
  layerCount?: number
}) {
  const t = createTestBackend()
  const result = await t.run(async (ctx) => {
    let ownerId: Id<'users'> | undefined
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
      strokeCounter: 0,
    })
    const layerIds: Id<'paintLayers'>[] = []
    for (let index = 0; index < (options.layerCount ?? 2); index += 1) {
      layerIds.push(await ctx.db.insert('paintLayers', {
        sessionId,
        name: `Layer ${index + 1}`,
        layerOrder: index,
        visible: true,
        opacity: 1,
        createdAt: Date.now() + index,
      }))
    }
    return { sessionId, layerIds }
  })

  return { t, ...result }
}

describe('paint layer authorization policy', () => {
  test('allows a signed-in owner on direct-session and record-derived mutations', async () => {
    const ownerAuthId = 'layer-owner'
    const { t, sessionId, layerIds } = await seedLayerSession({ ownerAuthId })
    const asOwner = t.withIdentity({ subject: ownerAuthId })

    await asOwner.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Owner layer',
    })
    await asOwner.mutation(api.paintLayers.updatePaintLayer, {
      layerId: layerIds[0],
      opacity: 0.5,
    })

    const state = await t.run(async (ctx) => ({
      layers: await ctx.db
        .query('paintLayers')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
      updatedLayer: await ctx.db.get(layerIds[0]),
    }))
    expect(state.layers).toHaveLength(3)
    expect(state.updatedLayer?.opacity).toBe(0.5)
  })

  test('allows a guest owner only with the matching key', async () => {
    const guestKey = 'matching-layer-key'
    const { t, sessionId, layerIds } = await seedLayerSession({ guestOwnerKey: guestKey })

    await expect(t.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Wrong key layer',
      guestKey: 'wrong-key',
    })).rejects.toThrow('Unauthorized')
    await expect(t.mutation(api.paintLayers.updatePaintLayer, {
      layerId: layerIds[0],
      opacity: 0.25,
      guestKey: 'wrong-key',
    })).rejects.toThrow('Unauthorized')

    await t.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Guest layer',
      guestKey,
    })
    await t.mutation(api.paintLayers.updatePaintLayer, {
      layerId: layerIds[0],
      opacity: 0.75,
      guestKey,
    })

    const layer = await t.run(async (ctx) => await ctx.db.get(layerIds[0]))
    expect(layer?.opacity).toBe(0.75)
  })

  test('keeps public sessions collaboratively editable', async () => {
    const { t, sessionId, layerIds } = await seedLayerSession({ isPublic: true })

    await t.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Public layer',
    })
    await t.mutation(api.paintLayers.updatePaintLayer, {
      layerId: layerIds[0],
      visible: false,
    })

    const layer = await t.run(async (ctx) => await ctx.db.get(layerIds[0]))
    expect(layer?.visible).toBe(false)
  })

  test('rejects private-session outsiders on every layer mutation', async () => {
    const { t, sessionId, layerIds } = await seedLayerSession({
      ownerAuthId: 'private-layer-owner',
      layerCount: 3,
    })
    const outsider = t.withIdentity({ subject: 'layer-outsider' })
    const expectUnauthorized = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toThrow('Unauthorized')
    }

    await expectUnauthorized(outsider.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Injected layer',
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayers.updatePaintLayer, {
      layerId: layerIds[0],
      name: 'Hijacked',
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayers.updatePaintLayerTransform, {
      layerId: layerIds[0],
      x: 999,
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayers.deletePaintLayer, {
      layerId: layerIds[0],
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayers.reorderPaintLayer, {
      layerId: layerIds[0],
      newOrder: 2,
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayers.mergePaintLayers, {
      sourceLayerId: layerIds[0],
      targetLayerId: layerIds[1],
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayers.ensureDefaultPaintLayer, {
      sessionId,
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayer.updatePaintLayerOrder, {
      sessionId,
      newLayerOrder: 2,
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayer.updatePaintLayerVisibility, {
      sessionId,
      visible: false,
    }))
    await expectUnauthorized(outsider.mutation(api.paintLayer.normalizeLayerOrders, {
      sessionId,
    }))
    await expectUnauthorized(outsider.mutation(api.layers.reorderLayer, {
      sessionId,
      layerId: layerIds[0],
      newOrder: 2,
    }))

    const state = await t.run(async (ctx) => ({
      session: await ctx.db.get(sessionId),
      layers: await ctx.db
        .query('paintLayers')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
    }))
    expect(state.session?.paintLayerOrder).toBeUndefined()
    expect(state.session?.paintLayerVisible).toBeUndefined()
    expect(state.layers.map((layer) => ({
      id: layer._id,
      name: layer.name,
      order: layer.layerOrder,
      x: layer.x,
    }))).toEqual(layerIds.map((id, index) => ({
      id,
      name: `Layer ${index + 1}`,
      order: index,
      x: undefined,
    })))
  })
})

describe('layer mutation session boundaries', () => {
  test('cross-session merge and unified reorder fail without changing either session', async () => {
    const t = createTestBackend()
    const seeded = await t.run(async (ctx) => {
      const sessionA = await ctx.db.insert('paintingSessions', {
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      const sessionB = await ctx.db.insert('paintingSessions', {
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      const layerA = await ctx.db.insert('paintLayers', {
        sessionId: sessionA,
        name: 'A',
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdAt: 1,
      })
      const layerB = await ctx.db.insert('paintLayers', {
        sessionId: sessionB,
        name: 'B',
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdAt: 2,
      })
      const strokeB = await ctx.db.insert('strokes', {
        sessionId: sessionB,
        layerId: layerB,
        userColor: '#000000',
        points: [{ x: 1, y: 1 }],
        brushColor: '#000000',
        brushSize: 2,
        opacity: 1,
        strokeOrder: 0,
      })
      return { sessionA, sessionB, layerA, layerB, strokeB }
    })

    await expect(t.mutation(api.paintLayers.mergePaintLayers, {
      sourceLayerId: seeded.layerB,
      targetLayerId: seeded.layerA,
    })).rejects.toThrow('Layers must belong to the same session')
    await expect(t.mutation(api.layers.reorderLayer, {
      sessionId: seeded.sessionA,
      layerId: seeded.layerB,
      newOrder: 0,
    })).rejects.toThrow('Layer not found')

    const state = await t.run(async (ctx) => ({
      layerA: await ctx.db.get(seeded.layerA),
      layerB: await ctx.db.get(seeded.layerB),
      strokeB: await ctx.db.get(seeded.strokeB),
    }))
    expect(state.layerA?.layerOrder).toBe(0)
    expect(state.layerB?.layerOrder).toBe(0)
    expect(state.strokeB?.layerId).toBe(seeded.layerB)
  })

  test('ensureDefaultPaintLayer cannot create a layer for a missing session', async () => {
    const t = createTestBackend()
    const missingSessionId = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert('paintingSessions', {
        isPublic: true,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
      await ctx.db.delete(sessionId)
      return sessionId
    })

    await expect(t.mutation(api.paintLayers.ensureDefaultPaintLayer, {
      sessionId: missingSessionId,
    })).rejects.toThrow('Session not found')

    const layers = await t.run(async (ctx) => await ctx.db
      .query('paintLayers')
      .withIndex('by_session', (q) => q.eq('sessionId', missingSessionId))
      .collect())
    expect(layers).toEqual([])
  })

  test('soft-deleted public sessions cannot be modified', async () => {
    const { t, sessionId, layerIds } = await seedLayerSession({ isPublic: true })
    await t.run(async (ctx) => {
      await ctx.db.patch(sessionId, { deletedAt: Date.now() })
    })

    await expect(t.mutation(api.paintLayers.createPaintLayer, {
      sessionId,
      name: 'Injected after deletion',
    })).rejects.toThrow('Session not found')
    await expect(t.mutation(api.paintLayers.updatePaintLayer, {
      layerId: layerIds[0],
      opacity: 0,
    })).rejects.toThrow('Session not found')
    await expect(t.mutation(api.layers.reorderLayer, {
      sessionId,
      layerId: layerIds[0],
      newOrder: 1,
    })).rejects.toThrow('Session not found')

    const state = await t.run(async (ctx) => ({
      layers: await ctx.db
        .query('paintLayers')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
    }))
    expect(state.layers.map((layer) => ({
      name: layer.name,
      opacity: layer.opacity,
      order: layer.layerOrder,
    }))).toEqual([
      { name: 'Layer 1', opacity: 1, order: 0 },
      { name: 'Layer 2', opacity: 1, order: 1 },
    ])
  })
})
