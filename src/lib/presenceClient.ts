import { ConvexClient } from 'convex/browser'
import { useEffect, useSyncExternalStore } from 'react'
import { authClient } from './auth-client'

/**
 * Presence (cursor) traffic runs on its own Convex connection so frequent,
 * low-priority cursor updates can never queue ahead of stroke saves on the
 * main client. It is authenticated from the same Better Auth token source as
 * the main client (see ConvexBetterAuthProvider).
 */
let presenceClient: ConvexClient | null = null

export function getPresenceClient(): ConvexClient | null {
  if (typeof window === 'undefined') return null
  if (!presenceClient) {
    presenceClient = new ConvexClient(import.meta.env.VITE_CONVEX_URL as string)
  }
  return presenceClient
}

// --- auth readiness -------------------------------------------------------
// Presence for a signed-in user must not go out before the presence client's
// auth settles, or the server would see an anonymous caller.
type PresenceAuthState = { ready: boolean; authenticated: boolean }
let authState: PresenceAuthState = { ready: false, authenticated: false }

export function getPresenceAuthState(): PresenceAuthState {
  return authState
}

async function fetchPresenceToken(): Promise<string | null> {
  try {
    const result = await (
      authClient as unknown as {
        convex: {
          token: (opts: {
            fetchOptions: { throw: false }
          }) => Promise<{ data?: { token?: string | null } | null }>
        }
      }
    ).convex.token({ fetchOptions: { throw: false } })
    return result?.data?.token ?? null
  } catch {
    return null
  }
}

/**
 * Keep the presence client's auth in sync with the Better Auth session. Must
 * be rendered once inside the app (next to the main Convex provider).
 */
export function PresenceAuthSync() {
  const { data: session, isPending } = authClient.useSession()
  const sessionId = session?.session?.id ?? null

  useEffect(() => {
    if (isPending) return
    const client = getPresenceClient()
    if (!client) return
    if (!sessionId) {
      client.client.clearAuth()
      authState = { ready: true, authenticated: false }
      return
    }
    authState = { ready: false, authenticated: false }
    client.setAuth(fetchPresenceToken, (isAuthenticated) => {
      authState = { ready: true, authenticated: isAuthenticated }
    })
  }, [isPending, sessionId])

  return null
}

// --- own presence row -------------------------------------------------------
// updatePresence returns the caller's presence id and a leave token. Several
// hook instances share a session, so keep them in a module-level store.
export type SelfPresence = { presenceId: string; leaveToken: string }
const selfPresence = new Map<string, SelfPresence>()
const listeners = new Set<() => void>()

export function setSelfPresence(sessionId: string, value: SelfPresence | null) {
  const current = selfPresence.get(sessionId)
  if (value === null) {
    if (!current) return
    selfPresence.delete(sessionId)
  } else {
    if (current && current.presenceId === value.presenceId && current.leaveToken === value.leaveToken) return
    selfPresence.set(sessionId, value)
  }
  listeners.forEach((listener) => listener())
}

export function getSelfPresence(sessionId: string | null | undefined): SelfPresence | null {
  return sessionId ? selfPresence.get(sessionId) ?? null : null
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The opaque presence `_id` of this browser's own row in the session. */
export function useSelfPresenceId(sessionId: string | null | undefined): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getSelfPresence(sessionId)?.presenceId,
    () => undefined
  )
}
