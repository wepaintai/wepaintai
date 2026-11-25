import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
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

type Backend = Awaited<ReturnType<typeof seedOwnedSession>>

async function liveColors({ asOwner, sessionId }: Pick<Backend, 'asOwner' | 'sessionId'>) {
  const strokes = await asOwner.query(api.strokes.getSessionStrokes, { sessionId })
  return strokes.map((s) => s.brushColor)
}

/** Orders must be unique across live and soft-deleted strokes. */
async function expectUniqueOrders({ t, sessionId }: Pick<Backend, 't' | 'sessionId'>) {
  const { live, deleted } = await t.run(async (ctx) => ({
    live: await ctx.db
      .query('strokes')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect(),
    deleted: await ctx.db
      .query('deletedStrokes')
      .withIndex('by_session_deleted', (q) => q.eq('sessionId', sessionId))
      .collect(),
  }))
  const orders = [...live, ...deleted].map((s) => s.strokeOrder)
  expect(new Set(orders).size).toBe(orders.length)
  return { live, deleted }
}

async function availability({ asOwner, sessionId }: Pick<Backend, 'asOwner' | 'sessionId'>) {
  return await asOwner.query(api.strokes.getUndoRedoAvailability, { sessionId })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('strokes undo/redo integrity', () => {
  test('regression: draw A,B, clear, draw C -> redo unavailable and cleared B never lands on top of C', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('A') })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('B') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('C') })

    const avail = await availability(backend)
    expect(avail.canRedo).toBe(false)
    expect(avail.canUndo).toBe(true)

    // Redo is a no-op: it must not bring back cleared strokes
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(false)
    expect(await liveColors(backend)).toEqual(['C'])

    // C took an order above the cleared A,B (no collision with cleared A)
    const { live, deleted } = await expectUniqueOrders(backend)
    expect(deleted).toHaveLength(2)
    expect(live[0].strokeOrder).toBeGreaterThan(Math.max(...deleted.map((s) => s.strokeOrder)))
  })

  test('Clear stays undoable after later strokes: Undo removes C, then Undo restores A,B', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('A') })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('B') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('C') })

    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    expect(await liveColors(backend)).toEqual([])
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    expect(await liveColors(backend)).toEqual(['A', 'B'])
    await expectUniqueOrders(backend)

    // Linear redo: first re-applies the Clear, then restores C
    expect((await availability(backend)).canRedo).toBe(true)
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)
    expect(await liveColors(backend)).toEqual([])
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)
    expect(await liveColors(backend)).toEqual(['C'])
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(false)
    expect((await availability(backend)).canRedo).toBe(false)
    await expectUniqueOrders(backend)
  })

  test('after undoing a Clear, a new stroke discards redo so C is never redone onto A,B', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('A') })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('B') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('C') })
    await asOwner.mutation(api.strokes.removeLastStroke, { sessionId }) // undo C
    await asOwner.mutation(api.strokes.removeLastStroke, { sessionId }) // undo Clear

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('D') })
    expect((await availability(backend)).canRedo).toBe(false)
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(false)
    expect(await liveColors(backend)).toEqual(['A', 'B', 'D'])

    // D sorts above everything ever drawn, including the undone C
    const { live, deleted } = await expectUniqueOrders(backend)
    const d = live.find((s) => s.brushColor === 'D')!
    expect(d.strokeOrder).toBeGreaterThan(Math.max(...deleted.map((s) => s.strokeOrder), 0))
  })

  test('multiple clears unwind in order', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('A') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('B') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('C') })

    const expected = [[], ['B'], [], ['A'], []]
    for (const colors of expected) {
      expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
      expect(await liveColors(backend)).toEqual(colors)
    }
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(false)
    expect((await availability(backend)).canUndo).toBe(false)

    // Full redo replays history back to the final state
    for (let i = 0; i < 5; i++) {
      expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)
    }
    expect(await liveColors(backend)).toEqual(['C'])
    await expectUniqueOrders(backend)
  })

  test('undo -> draw -> undo -> redo restores the most recent undone stroke only', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#111') })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#222') })
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)

    // New stroke gets a fresh order (no reuse of #222's order) and drops redo
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('#333') })
    await expectUniqueOrders(backend)
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)

    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)
    expect(await liveColors(backend)).toEqual(['#111', '#333'])
    expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(false)
  })

  test('undo works through more than 10 strokes and stops when history is empty', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    for (let i = 0; i < 12; i++) {
      await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload(`#${i}`) })
    }
    for (let i = 0; i < 12; i++) {
      expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(true)
    }
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(false)
    expect((await availability(backend)).deletedCount).toBe(12)
  })

  test('clearing an empty canvas is not an undoable action', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    const emptyAvail = await availability(backend)
    expect(emptyAvail.canUndo).toBe(false)
    expect(emptyAvail.canRedo).toBe(false)
    expect(await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })).toBe(false)
  })

  test('availability always agrees with what undo/redo actually do (seeded random walk)', async () => {
    const backend = await seedOwnedSession()
    const { t, asOwner, sessionId } = backend

    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    let lastCounter = 0
    let colorIndex = 0

    for (let step = 0; step < 80; step++) {
      const before = await availability(backend)
      const r = rand()
      if (r < 0.4) {
        const strokeId = await asOwner.mutation(api.strokes.addStroke, {
          sessionId,
          ...strokePayload(`c${colorIndex++}`),
        })
        const { live, deleted } = await expectUniqueOrders(backend)
        const added = live.find((s) => s._id === (strokeId as Id<'strokes'>))!
        const otherOrders = [...live.filter((s) => s._id !== added._id), ...deleted].map(
          (s) => s.strokeOrder
        )
        expect(added.strokeOrder).toBeGreaterThan(Math.max(0, ...otherOrders))
        expect((await availability(backend)).canRedo).toBe(false)
      } else if (r < 0.5) {
        await asOwner.mutation(api.strokes.clearSession, { sessionId })
        expect(await liveColors(backend)).toEqual([])
      } else if (r < 0.8) {
        const colorsBefore = await liveColors(backend)
        const undone = await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })
        expect(undone).toBe(before.canUndo)
        if (undone) {
          // Undo followed by redo is the identity
          expect(await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })).toBe(true)
          expect(await liveColors(backend)).toEqual(colorsBefore)
          await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })
        }
      } else {
        const redone = await asOwner.mutation(api.strokes.restoreLastDeletedStroke, { sessionId })
        expect(redone).toBe(before.canRedo)
      }

      await expectUniqueOrders(backend)
      const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
      expect(session!.strokeCounter).toBeGreaterThanOrEqual(lastCounter)
      lastCounter = session!.strokeCounter
    }
  })

  test('a new stroke permanently discards the soft-deleted rows of the dropped redo branch', async () => {
    vi.useFakeTimers()
    const backend = await seedOwnedSession()
    const { t, asOwner, sessionId } = backend

    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('A') })
    await asOwner.mutation(api.strokes.removeLastStroke, { sessionId })
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('B') })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const deleted = await t.run(async (ctx) =>
      ctx.db
        .query('deletedStrokes')
        .withIndex('by_session_deleted', (q) => q.eq('sessionId', sessionId))
        .collect()
    )
    expect(deleted).toEqual([])
    expect(await liveColors(backend)).toEqual(['B'])
  })

  test('session reads do not expose undo bookkeeping', async () => {
    const backend = await seedOwnedSession()
    const { asOwner, sessionId } = backend
    await asOwner.mutation(api.strokes.addStroke, { sessionId, ...strokePayload('A') })
    await asOwner.mutation(api.strokes.clearSession, { sessionId })
    const result = await asOwner.query(api.paintingSessions.getSession, { sessionId })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.session).not.toHaveProperty('clearHistory')
      expect(result.session).not.toHaveProperty('redoStack')
    }
  })
})
