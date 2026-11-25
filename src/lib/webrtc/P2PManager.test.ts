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

// Minimal fake data channel / peer wiring for exercising P2PManager's
// per-channel handlers without WebRTC.
interface FakeChannel {
  readyState: 'open' | 'closed'
  send: ReturnType<typeof vi.fn>
  close: () => void
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: unknown }) => void
  onerror?: (error: unknown) => void
}

function makeManager(overrides: Partial<ConstructorParameters<typeof P2PManager>[0]> = {}) {
  const mutation = vi.fn(async () => ({ peers: [], mode: 'mesh' as const }))
  const query = vi.fn(async () => [])
  const convexClient = { mutation, query } as unknown as ConvexReactClient
  const manager = new P2PManager({
    sessionId: 'session_3' as Id<'paintingSessions'>,
    peerId: 'me',
    convexClient,
    ...overrides,
  })
  return manager
}

/** Attach a fake open channel for `peerId` through the manager's own setup. */
function attachPeer(manager: P2PManager, peerId: string): FakeChannel {
  const channel: FakeChannel = {
    readyState: 'open',
    send: vi.fn(),
    close: () => {
      channel.readyState = 'closed'
    },
  }
  const peerConn = {
    peerId,
    connection: { close: vi.fn() },
    isConnected: false,
  }
  const internals = manager as unknown as {
    peers: Map<string, unknown>
    setupDataChannel: (channel: FakeChannel, peerConn: unknown) => void
  }
  internals.peers.set(peerId, peerConn)
  internals.setupDataChannel(channel, peerConn)
  channel.onopen?.()
  return channel
}

describe('P2PManager cursor throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('sends at most ~30 Hz and always delivers the latest cursor on the trailing edge', async () => {
    const manager = makeManager()
    const channel = attachPeer(manager, 'peer_a')

    // Leading send goes out immediately
    manager.sendCursorPacket({ t: 'cu', x: 0.1, y: 0.1, drawing: false })
    expect(channel.send).toHaveBeenCalledTimes(1)

    // A burst inside the 33 ms window is coalesced
    for (let i = 2; i <= 10; i++) {
      vi.setSystemTime(1_000_000 + i)
      manager.sendCursorPacket({ t: 'cu', x: i / 100, y: i / 100, drawing: i === 10 })
    }
    expect(channel.send).toHaveBeenCalledTimes(1)

    // Trailing send carries the last position and drawing flag
    await vi.advanceTimersByTimeAsync(40)
    expect(channel.send).toHaveBeenCalledTimes(2)
    const sentBytes = channel.send.mock.calls[1][0] as ArrayBuffer
    const { decodeP2PPacket } = await import('./encoding')
    expect(decodeP2PPacket(sentBytes)).toMatchObject({ t: 'cu', drawing: true })

    // 1 s of 120 Hz pointer moves -> roughly 30 sends, never 120
    channel.send.mockClear()
    for (let ms = 0; ms < 1000; ms += 8) {
      manager.sendCursorPacket({ t: 'cu', x: 0.5, y: ms / 1000, drawing: false })
      await vi.advanceTimersByTimeAsync(8)
    }
    expect(channel.send.mock.calls.length).toBeGreaterThan(20)
    expect(channel.send.mock.calls.length).toBeLessThanOrEqual(32)

    await manager.destroy()
  })

  test('destroy cancels a pending trailing cursor send', async () => {
    const manager = makeManager()
    const channel = attachPeer(manager, 'peer_a')
    manager.sendCursorPacket({ t: 'cu', x: 0.1, y: 0.1, drawing: false })
    manager.sendCursorPacket({ t: 'cu', x: 0.2, y: 0.2, drawing: true })
    expect(channel.send).toHaveBeenCalledTimes(1)

    await manager.destroy()
    await vi.advanceTimersByTimeAsync(100)
    expect(channel.send).toHaveBeenCalledTimes(1)
  })
})

describe('P2PManager after destroy', () => {
  test('a late data-channel onclose/onmessage never reaches the callbacks', async () => {
    const onPeerConnected = vi.fn()
    const onPeerDisconnected = vi.fn()
    const onPacketReceived = vi.fn()
    const manager = makeManager({ onPeerConnected, onPeerDisconnected, onPacketReceived })
    const channel = attachPeer(manager, 'peer_a')
    expect(onPeerConnected).toHaveBeenCalledWith('peer_a')

    await manager.destroy()
    // Browsers fire onclose asynchronously after close(); simulate it late.
    channel.onclose?.()
    channel.onmessage?.({ data: new ArrayBuffer(8) })
    channel.onopen?.()

    expect(onPeerDisconnected).not.toHaveBeenCalled()
    expect(onPacketReceived).not.toHaveBeenCalled()
    expect(onPeerConnected).toHaveBeenCalledTimes(1)
  })
})
