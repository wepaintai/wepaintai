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
