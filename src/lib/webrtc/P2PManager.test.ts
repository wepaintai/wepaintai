import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ConvexReactClient } from 'convex/react'
import type { Id } from '../../../convex/_generated/dataModel'
import { P2PManager } from './P2PManager'

describe('P2PManager lifecycle safety', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('does not start signal polling when destroyed while joinP2PSession is in flight', async () => {
    let resolveJoin!: (value: { peers: string[]; mode: 'mesh' }) => void
    const joinPromise = new Promise<{ peers: string[]; mode: 'mesh' }>((resolve) => {
      resolveJoin = resolve
    })

    const mutation = vi.fn((_fn: unknown, args: Record<string, unknown>) => {
      if ('peerId' in args && mutation.mock.calls.length === 1) {
        return joinPromise
      }
      return Promise.resolve(undefined)
    })
    const query = vi.fn(async () => [])

    const convexClient = { mutation, query } as unknown as ConvexReactClient
    const onModeChanged = vi.fn()

    const manager = new P2PManager({
      sessionId: 'session_1' as Id<'paintingSessions'>,
      peerId: 'user_1',
      convexClient,
      onModeChanged,
    })

    const initPromise = manager.init()
    await manager.destroy()

    resolveJoin({ peers: [], mode: 'mesh' })
    await initPromise

    await vi.advanceTimersByTimeAsync(5000)

    expect(onModeChanged).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  test('destroy is idempotent and clears signal polling interval', async () => {
    const mutation = vi.fn(async () => ({ peers: [], mode: 'mesh' as const }))
    const query = vi.fn(async () => [])
    const convexClient = { mutation, query } as unknown as ConvexReactClient

    const manager = new P2PManager({
      sessionId: 'session_2' as Id<'paintingSessions'>,
      peerId: 'user_2',
      convexClient,
    })

    await manager.init()
    await vi.advanceTimersByTimeAsync(1000)
    expect(query).toHaveBeenCalledTimes(1)

    await manager.destroy()
    await manager.destroy() // idempotent second call should not call leaveP2PSession twice

    await vi.advanceTimersByTimeAsync(5000)
    expect(query).toHaveBeenCalledTimes(1)
    // 1 joinP2PSession + 1 leaveP2PSession
    expect(mutation).toHaveBeenCalledTimes(2)
  })
})
