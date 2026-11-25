import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mutation = vi.fn()
const query = vi.fn()

vi.mock('./convex', () => ({
  convexHigh: {
    mutation: (...args: unknown[]) => mutation(...args),
    query: (...args: unknown[]) => query(...args),
    connectionState: () => ({ isWebSocketConnected: true }),
  },
}))

const STORAGE_KEY = 'wepaintai:pendingStrokes:v1'
const SESSION = 'session-1'
const EDIT_KEY = 'e'.repeat(48)

function strokeArgs(extra: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    userColor: '#000',
    points: [{ x: 1, y: 1 }],
    brushColor: '#000',
    brushSize: 4,
    opacity: 1,
    ...extra,
  } as never
}

let local: Map<string, string>
let sessionStore: Map<string, string>

function storage(map: Map<string, string>) {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

/** Fresh syncStatus + guestKey module instances over the stubbed storage. */
async function load() {
  vi.resetModules()
  const sync = await import('./syncStatus')
  const keys = await import('../utils/guestKey')
  return { sync, keys }
}

beforeEach(() => {
  local = new Map()
  sessionStore = new Map()
  vi.stubGlobal('window', { localStorage: storage(local), sessionStorage: storage(sessionStore) })
  mutation.mockReset()
  query.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stroke replay queue and edit links', () => {
  test('never persists the edit key; replays with the current key from sessionStorage', async () => {
    const { sync, keys } = await load()
    keys.setEditKey(SESSION, EDIT_KEY)

    const pending = sync.reportSyncFailure(new Error('Connection lost'), strokeArgs({ editKey: EDIT_KEY }))
    const persisted = local.get(STORAGE_KEY) ?? ''
    expect(persisted).not.toContain(EDIT_KEY)
    expect(persisted).not.toContain('editKey')
    expect(JSON.parse(persisted).strokes[0].usesEditLink).toBe(true)

    // The owner rotated the link and the collaborator opened the new one
    const rotated = 'r'.repeat(48)
    keys.setEditKey(SESSION, rotated)
    mutation.mockResolvedValueOnce('stroke-id')
    expect(await sync.retrySync()).toBe(true)
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(mutation.mock.calls[0][1]).toMatchObject({ sessionId: SESSION, editKey: rotated })
    expect(await pending).toBe('stroke-id')
    expect(local.has(STORAGE_KEY)).toBe(false)
  })

  test('a stroke whose edit link is gone is dropped with a notice and does not block later strokes', async () => {
    const { sync, keys } = await load()
    keys.setEditKey(SESSION, EDIT_KEY)
    const revoked = sync.reportSyncFailure(new Error('Unauthorized'), strokeArgs({ editKey: EDIT_KEY }))
    // An owner stroke for another session queued behind it
    const later = sync.enqueueStroke(strokeArgs({ sessionId: 'session-2' }))

    // Backend confirmed the link no longer grants edit access
    keys.removeEditKey(SESSION)
    mutation.mockResolvedValueOnce('later-id')
    query.mockResolvedValue({ _id: 'user' })
    expect(await sync.retrySync()).toBe(true)

    expect(await revoked).toBeUndefined()
    expect(await later).toBe('later-id')
    expect(mutation).toHaveBeenCalledTimes(1) // the revoked stroke was never sent
    expect(sync.getSyncStatus()).toMatchObject({ status: 'ok', droppedForAccessCount: 1 })
    expect(sync.hasPendingStrokes()).toBe(false)
  })

  test('dropEditLinkStrokes drops only edit-link strokes for that session and counts them', async () => {
    const { sync } = await load()
    const a = sync.enqueueStroke(strokeArgs({ editKey: EDIT_KEY }))
    const b = sync.enqueueStroke(strokeArgs()) // owner access: kept across auth outages
    const c = sync.enqueueStroke(strokeArgs({ sessionId: 'other', editKey: 'x'.repeat(48) }))

    expect(sync.dropEditLinkStrokes(SESSION)).toBe(1)
    expect(await a).toBeUndefined()
    expect(sync.getSyncStatus().droppedForAccessCount).toBe(1)
    const stored = JSON.parse(local.get(STORAGE_KEY) ?? '{}')
    expect(stored.strokes).toHaveLength(2)
    expect(JSON.stringify(stored)).not.toContain('x'.repeat(48))

    sync.dismissDroppedNotice()
    expect(sync.getSyncStatus().droppedForAccessCount).toBe(0)
    sync.discardAllPendingChanges()
    expect(sync.getSyncStatus()).toMatchObject({ status: 'ok', pendingStrokeCount: 0 })
    expect(await b).toBeUndefined()
    expect(await c).toBeUndefined()
    expect(sync.hasPendingStrokes()).toBe(false)
    expect(local.has(STORAGE_KEY)).toBe(false)
  })

  test('owner strokes are retained across an auth outage (expired JWT) rather than dropped', async () => {
    const { sync } = await load()
    const pending = sync.reportSyncFailure(new Error('Unauthorized'), strokeArgs())
    mutation.mockRejectedValueOnce(new Error('Unauthorized'))
    expect(await sync.retrySync()).toBe(false)
    expect(sync.hasPendingStrokes()).toBe(true)

    mutation.mockResolvedValueOnce('after-reauth')
    expect(await sync.retrySync()).toBe(true)
    expect(await pending).toBe('after-reauth')
  })

  test('rehydration strips edit keys from a legacy persisted queue', async () => {
    local.set(
      STORAGE_KEY,
      JSON.stringify({ savedAt: Date.now(), kind: 'auth', strokes: [strokeArgs({ editKey: EDIT_KEY })] }),
    )
    const { sync } = await load()
    expect(sync.hasPendingStrokes()).toBe(true)
    const rewritten = local.get(STORAGE_KEY) ?? ''
    expect(rewritten).not.toContain(EDIT_KEY)
    expect(JSON.parse(rewritten).strokes[0]).toMatchObject({ usesEditLink: true })
  })
})
