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

// Secret collaboration edit capability tokens, stored per-tab in sessionStorage
// (keyed by sessionId) after being extracted and scrubbed from the URL fragment.
export const EDIT_KEYS_STORAGE = 'wepaint_edit_keys_v1'
const inMemoryEditKeys = new Map<string, string>()
const editKeyListeners = new Set<() => void>()

function notifyEditKeyChange() {
  editKeyListeners.forEach((listener) => listener())
}

export function subscribeEditKeys(listener: () => void): () => void {
  editKeyListeners.add(listener)
  return () => {
    editKeyListeners.delete(listener)
  }
}

export function setEditKey(sessionId: string, key: string) {
  const trimmed = key.trim()
  if (!sessionId || !trimmed) return
  inMemoryEditKeys.set(sessionId, trimmed)
  if (typeof window !== 'undefined') {
    try {
      const raw = window.sessionStorage.getItem(EDIT_KEYS_STORAGE)
      const map = raw ? JSON.parse(raw) : {}
      map[sessionId] = trimmed
      window.sessionStorage.setItem(EDIT_KEYS_STORAGE, JSON.stringify(map))
    } catch {
      // sessionStorage unavailable (e.g. private browsing); in-memory map still works
    }
  }
  notifyEditKeyChange()
}

export function getEditKey(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  const cached = inMemoryEditKeys.get(sessionId)
  if (cached) return cached
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(EDIT_KEYS_STORAGE)
    const map = raw ? JSON.parse(raw) : {}
    const stored = typeof map[sessionId] === 'string' && map[sessionId].length > 0 ? map[sessionId] : null
    if (stored) inMemoryEditKeys.set(sessionId, stored)
    return stored
  } catch {
    return null
  }
}

export function removeEditKey(sessionId: string) {
  if (!sessionId) return
  const hadInMemory = inMemoryEditKeys.delete(sessionId)
  let hadInStorage = false
  if (typeof window !== 'undefined') {
    try {
      const raw = window.sessionStorage.getItem(EDIT_KEYS_STORAGE)
      const map = raw ? JSON.parse(raw) : {}
      if (map[sessionId]) {
        hadInStorage = true
        delete map[sessionId]
        window.sessionStorage.setItem(EDIT_KEYS_STORAGE, JSON.stringify(map))
      }
    } catch {
      // sessionStorage unavailable
    }
  }
  if (hadInMemory || hadInStorage) {
    notifyEditKeyChange()
  }
}

/**
 * Returns the strongest local capability key for a session:
 * - Guest owner key (localStorage) if this browser created the guest session
 * - Otherwise the collaborator edit key (sessionStorage) if opened via edit link
 */
export function getSessionAccessKey(sessionId: string | null | undefined): string | null {
  return getGuestKey(sessionId) || getEditKey(sessionId) || null
}

/**
 * Pure parser for collaboration edit links.
 * Prefers URL hash fragment `#edit=<token>` (never sent over HTTP or Referer),
 * and gracefully accepts `?edit=<token>` if pasted as a query parameter.
 * Strips any `edit` parameter from both hash and search so callers can scrub
 * the address bar via `history.replaceState`.
 */
export function parseEditKeyFromUrl(
  search: string,
  hash: string,
): {
  editKey: string | null
  cleanedSearch: string
  cleanedHash: string
  hadEditParam: boolean
} {
  let editKey: string | null = null
  let hadEditParam = false

  // 1. Check hash fragment first (#edit=<token> or #foo=1&edit=<token>)
  let cleanedHash = hash
  if (hash && hash.length > 1) {
    const rawHash = hash.startsWith('#') ? hash.slice(1) : hash
    if (/(^|&)edit(=|$)/.test(rawHash)) {
      const hashParams = new URLSearchParams(rawHash)
      if (hashParams.has('edit')) {
        hadEditParam = true
        const val = hashParams.get('edit')?.trim()
        if (val) editKey = val
        hashParams.delete('edit')
        const remainingHash = hashParams.toString()
        cleanedHash = remainingHash ? `#${remainingHash}` : ''
      }
    }
  }

  // 2. Also inspect query string (?edit=<token>) and always scrub it if present
  let cleanedSearch = search
  if (search) {
    const searchParams = new URLSearchParams(search)
    if (searchParams.has('edit')) {
      hadEditParam = true
      const val = searchParams.get('edit')?.trim()
      if (!editKey && val) editKey = val
      searchParams.delete('edit')
      const remainingSearch = searchParams.toString()
      cleanedSearch = remainingSearch ? `?${remainingSearch}` : ''
    }
  }

  return { editKey, cleanedSearch, cleanedHash, hadEditParam }
}

/**
 * Extract `#edit=<token>` or `?edit=<token>` from the current browser URL,
 * persist it in `sessionStorage` keyed by `sessionId`, and scrub the secret
 * from the address bar via `history.replaceState`.
 */
export function consumeEditKeyFromWindowUrl(sessionId: string | null | undefined): string | null {
  if (!sessionId || typeof window === 'undefined') return null
  try {
    const { editKey, cleanedSearch, cleanedHash, hadEditParam } = parseEditKeyFromUrl(
      window.location.search,
      window.location.hash,
    )
    if (editKey) {
      setEditKey(sessionId, editKey)
    }
    if (hadEditParam) {
      const cleanUrl = `${window.location.pathname}${cleanedSearch}${cleanedHash}`
      window.history.replaceState(window.history.state, '', cleanUrl)
    }
    return editKey
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
  // Never cache a module-level singleton during SSR: a shared Node process
  // would leak one client ID across all SSR users and mismatch hydration.
  if (typeof window === 'undefined') {
    return generateGuestKey()
  }
  if (inMemoryClientId) return inMemoryClientId
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
