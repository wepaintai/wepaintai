export const GUEST_KEYS_STORAGE = 'wepaint_guest_keys_v1'

export function generateGuestKey(): string {
  if (typeof window !== 'undefined' && 'crypto' in window && (window.crypto as any).getRandomValues) {
    const arr = new Uint8Array(16)
    window.crypto.getRandomValues(arr)
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

export function setGuestKey(sessionId: string, key: string) {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(GUEST_KEYS_STORAGE)
    const map = raw ? JSON.parse(raw) : {}
    map[sessionId] = key
    window.localStorage.setItem(GUEST_KEYS_STORAGE, JSON.stringify(map))
  } catch {}
}

export function getGuestKey(sessionId: string | null | undefined): string | null {
  if (!sessionId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(GUEST_KEYS_STORAGE)
    const map = raw ? JSON.parse(raw) : {}
    return map[sessionId] || null
  } catch {
    return null
  }
}

export function removeGuestKey(sessionId: string) {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(GUEST_KEYS_STORAGE)
    const map = raw ? JSON.parse(raw) : {}
    if (map[sessionId]) {
      delete map[sessionId]
      window.localStorage.setItem(GUEST_KEYS_STORAGE, JSON.stringify(map))
    }
  } catch {}
}

// Track current guest session ID locally so we can mask it from the URL
export const CURRENT_GUEST_SESSION_KEY = 'wepaint_current_session_v1'

export function getCurrentGuestSession(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(CURRENT_GUEST_SESSION_KEY)
  } catch {
    return null
  }
}

export function setCurrentGuestSession(sessionId: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CURRENT_GUEST_SESSION_KEY, sessionId)
  } catch {}
}

export function clearCurrentGuestSession() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CURRENT_GUEST_SESSION_KEY)
  } catch {}
}

// Recent sessions this browser has opened as a guest, newest first. Gives
// guests (who have no Library) a way back to past paintings after starting
// a new canvas or losing the URL.
export const RECENT_GUEST_SESSIONS_STORAGE = 'wepaint_recent_sessions_v1'
const RECENT_GUEST_SESSIONS_MAX = 15

export interface RecentGuestSession {
  sessionId: string
  name?: string
  lastOpened: number
}

export function getRecentGuestSessions(): RecentGuestSession[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_GUEST_SESSIONS_STORAGE)
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    return list.filter(
      (e): e is RecentGuestSession => !!e && typeof e.sessionId === 'string' && typeof e.lastOpened === 'number'
    )
  } catch {
    return []
  }
}

export function touchRecentGuestSession(sessionId: string, name?: string) {
  if (typeof window === 'undefined') return
  try {
    const list = getRecentGuestSessions()
    const prev = list.find(e => e.sessionId === sessionId)
    const existing = list.filter(e => e.sessionId !== sessionId)
    const entry: RecentGuestSession = {
      sessionId,
      name: name ?? prev?.name,
      lastOpened: Date.now(),
    }
    const next = [entry, ...existing].slice(0, RECENT_GUEST_SESSIONS_MAX)
    window.localStorage.setItem(RECENT_GUEST_SESSIONS_STORAGE, JSON.stringify(next))
  } catch {}
}

export function removeRecentGuestSession(sessionId: string) {
  if (typeof window === 'undefined') return
  try {
    const next = getRecentGuestSessions().filter(e => e.sessionId !== sessionId)
    window.localStorage.setItem(RECENT_GUEST_SESSIONS_STORAGE, JSON.stringify(next))
  } catch {}
}

// Stable per-browser client id, used to identify guests in presence records
// (guests have no userId, so without this they'd all collide on one record).
export const CLIENT_ID_STORAGE = 'wepaint_client_id_v1'

let inMemoryClientId: string | null = null

export function getClientId(): string {
  if (inMemoryClientId) return inMemoryClientId
  if (typeof window === 'undefined') {
    inMemoryClientId = generateGuestKey()
    return inMemoryClientId
  }
  try {
    let id = window.localStorage.getItem(CLIENT_ID_STORAGE)
    if (!id) {
      id = generateGuestKey()
      window.localStorage.setItem(CLIENT_ID_STORAGE, id)
    }
    inMemoryClientId = id
    return id
  } catch {
    inMemoryClientId = generateGuestKey()
    return inMemoryClientId
  }
}
