import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'
import { modules } from './test.setup'

function createTestBackend() {
  return convexTest(schema, modules)
}

async function seedOwnedSession() {
  const t = createTestBackend()
  const authId = 'stroke-owner'
  const sessionId = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      authId,
      email: 'stroke-owner@example.com',
    })
    return await ctx.db.insert('paintingSessions', {
      createdBy: ownerId,
      isPublic: false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
    })
  })
  return { t, sessionId, asOwner: t.withIdentity({ subject: authId }) }
}

const strokePayload = (color: string) => ({
  userColor: '#000',
  points: [{ x: 10, y: 20 }],
  brushColor: color,
  brushSize: 5,
  opacity: 1,
})

describe('strokes undo/redo integrity', () => {
  test('redo does not crash when undo -> draw -> undo creates duplicate strokeOrder in deletedStrokes', async () => {
    const { asOwner, sessionId } = await seedOwnedSession()

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#111') })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#222') })
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)

    // Draw a new stroke with the reused strokeOrder=2, then undo it too
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#333') })
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)

    // Previously threw Convex .unique() error due to two deletedStrokes with strokeOrder=2
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)

    const strokes = await asOwner.query(api.strokes.getSessionStrokes, { sessionId })
    expect(strokes).toHaveLength(2)
  })

  test('undo beyond 10 cached strokes preserves the rebuilt recentStrokeIds cache', async () => {
    const { t, asOwner, sessionId } = await seedOwnedSession()

    for (let i = 0; i < 12; i++) {
      await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload(`#${i}`) })
    }

    // Undo 10 strokes to drain the initial 10-item cache, then undo #11 (triggers rebuild)
    for (let i = 0; i < 11; i++) {
      expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    }

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    expect(session?.recentStrokeIds).toHaveLength(1)
    expect(session?.recentStrokeOrders).toEqual([1])

    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(false)
  })

  test('clearing an empty canvas keeps canUndo false, and drawing after clear does not resurrect old clear batch', async () => {
    const { asOwner, sessionId } = await seedOwnedSession()

    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    const emptyAvail = await asOwner.query(api.strokes.getUndoRedoAvailability, { sessionId })
    expect(emptyAvail.canUndo).toBe(false)

    // Draw two strokes, clear, draw one new stroke, then undo twice -> must stay empty
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#aaa') })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#bbb') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#ccc') })

    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(false)
    expect(await asOwner.query(api.strokes.getSessionStrokes, { sessionId })).toEqual([])
  })

  test('restoring the last deleted stroke clears lastDeletedStrokeOrder', async () => {
    const { t, asOwner, sessionId } = await seedOwnedSession()

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#abc') })
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    expect(session?.lastDeletedStrokeOrder).toBeUndefined()
    expect(session?.deletedStrokeCount).toBe(0)
  })
})
