import { useSyncExternalStore } from 'react'
import type { P2PMetrics, RemoteStroke } from './types'

/**
 * High-frequency P2P state (remote cursors, remote live strokes, metrics)
 * lives in small external stores instead of React state on the editor host.
 * Incoming packets then only re-render the components that draw that state
 * (they subscribe with useSyncExternalStore), never the whole PaintingView
 * tree. Each channel has its own listeners so a metrics tick doesn't
 * re-render the cursor layer and vice versa.
 */

export interface RemoteCursor {
  x: number
  y: number
  drawing: boolean
}

export type RemoteCursorMap = ReadonlyMap<string, RemoteCursor>
export type RemoteStrokeMap = ReadonlyMap<string, RemoteStroke>

export interface ExternalValue<T> {
  get: () => T
  /** Replace the value; listeners are only notified when the reference changes. */
  set: (next: T | ((prev: T) => T)) => void
  subscribe: (listener: () => void) => () => void
}

export function createExternalValue<T>(initial: T): ExternalValue<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(value) : next
      if (Object.is(resolved, value)) return
      value = resolved
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export interface P2PLiveStore {
  cursors: ExternalValue<RemoteCursorMap>
  strokes: ExternalValue<RemoteStrokeMap>
  metrics: ExternalValue<P2PMetrics | null>
}

export const EMPTY_REMOTE_CURSORS: RemoteCursorMap = new Map()
export const EMPTY_REMOTE_STROKES: RemoteStrokeMap = new Map()

export function createP2PLiveStore(): P2PLiveStore {
  return {
    cursors: createExternalValue<RemoteCursorMap>(EMPTY_REMOTE_CURSORS),
    strokes: createExternalValue<RemoteStrokeMap>(EMPTY_REMOTE_STROKES),
    metrics: createExternalValue<P2PMetrics | null>(null),
  }
}

/** Reset every channel to its empty value (P2P teardown). */
export function resetP2PLiveStore(store: P2PLiveStore): void {
  store.cursors.set(EMPTY_REMOTE_CURSORS)
  store.strokes.set(EMPTY_REMOTE_STROKES)
  store.metrics.set(null)
}

function useExternalValue<T>(value: ExternalValue<T>, serverSnapshot: T): T {
  return useSyncExternalStore(value.subscribe, value.get, () => serverSnapshot)
}

export function useRemoteCursors(store: P2PLiveStore): RemoteCursorMap {
  return useExternalValue(store.cursors, EMPTY_REMOTE_CURSORS)
}

export function useRemoteStrokes(store: P2PLiveStore): RemoteStrokeMap {
  return useExternalValue(store.strokes, EMPTY_REMOTE_STROKES)
}

export function useP2PMetrics(store: P2PLiveStore): P2PMetrics | null {
  return useExternalValue(store.metrics, null)
}
