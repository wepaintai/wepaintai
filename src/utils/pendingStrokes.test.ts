import { describe, expect, test } from 'vitest'
import { reconcilePendingStrokes } from './pendingStrokes'

describe('reconcilePendingStrokes', () => {
  test('clears an optimistic stroke that was undone while its save was in flight', () => {
    // Backend now has stroke_b; the user already undid it optimistically, so
    // the undo-filtered list omits it while the raw list still contains it.
    const rawIds = new Set(['stroke_a', 'stroke_b'])
    const undoFilteredIds = new Set(['stroke_a'])
    const pending = new Map([['temp_b', { points: 3 }]])

    // With the undo-filtered set the optimistic copy would get stuck
    const stuck = reconcilePendingStrokes(pending, new Map([['temp_b', 'stroke_b']]), undoFilteredIds)
    expect(stuck.has('temp_b')).toBe(true)

    // With the raw backend set it is cleared
    const ids = new Map<string, string | null>([['temp_b', 'stroke_b']])
    const reconciled = reconcilePendingStrokes(pending, ids, rawIds)
    expect(reconciled.has('temp_b')).toBe(false)
    expect(ids.has('temp_b')).toBe(false)
  })

  test('returns the same map when nothing was confirmed', () => {
    const pending = new Map([['temp_x', 1]])
    const ids = new Map<string, string | null>([['temp_x', null]])
    expect(reconcilePendingStrokes(pending, ids, new Set(['stroke_1']))).toBe(pending)
  })
})
