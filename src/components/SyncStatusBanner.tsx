import { useEffect, useRef, useState } from 'react'
import { useConvexAuth } from 'convex/react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useAuthState, authClient } from '../lib/auth-client'
import { useSyncStatus, retrySync } from '../lib/syncStatus'
import { suppressUnloadGuard, resumeUnloadGuard } from '../lib/unsavedChanges'

/**
 * Grace period before flagging the "Better Auth signed in but Convex not
 * authenticated" desync — token refresh after page load can legitimately take
 * a few seconds.
 */
const DESYNC_GRACE_MS = 8000

/**
 * Persistent, non-intrusive banner shown when changes stop saving: either a
 * mutation failed (reported via the syncStatus store) or the session JWT
 * expired, leaving Better Auth signed in while Convex is unauthenticated —
 * the state previously only visible in the dev-only AuthDebug box.
 */
export function SyncStatusBanner() {
  const sync = useSyncStatus()
  const { isLoaded, isSignedIn } = useAuthState()
  const { isAuthenticated, isLoading } = useConvexAuth()
  const [signingIn, setSigningIn] = useState(false)

  // Detect the auth desync only after it has persisted past the grace period.
  const desyncCandidate = isLoaded && isSignedIn && !isLoading && !isAuthenticated
  const [desynced, setDesynced] = useState(false)
  useEffect(() => {
    if (!desyncCandidate) {
      setDesynced(false)
      return
    }
    const timer = setTimeout(() => setDesynced(true), DESYNC_GRACE_MS)
    return () => clearTimeout(timer)
  }, [desyncCandidate])

  // When Convex auth comes back (e.g. after re-sign-in), replay queued
  // strokes. Also retry when the error state appears while already
  // authenticated — the rehydrated queue flips status asynchronously, so the
  // auth edge alone can be consumed before the queue is visible.
  const wasAuthenticatedRef = useRef(isAuthenticated)
  useEffect(() => {
    const cameOnline = isAuthenticated && !wasAuthenticatedRef.current
    wasAuthenticatedRef.current = isAuthenticated
    if (isAuthenticated && sync.status === 'error' && (cameOnline || sync.pendingStrokeCount > 0)) {
      void retrySync()
    }
  }, [isAuthenticated, sync.status])

  if (import.meta.env.VITE_AUTH_DISABLED === 'true') return null

  const visible = sync.status === 'error' || desynced
  if (!visible) return null

  const isAuthIssue = desynced || sync.kind === 'auth'
  const detail = isAuthIssue
    ? 'Your session expired — sign in again to keep saving.'
    : sync.kind === 'network'
      ? 'Connection lost — your changes will retry once you reconnect.'
      : 'Something went wrong while saving.'

  const handleSignInAgain = async () => {
    setSigningIn(true)
    // Queued strokes are persisted to localStorage (write-through in
    // syncStatus) and replayed after the round-trip, so this intentional
    // full-page redirect loses nothing — don't show the "Leave site?" prompt.
    suppressUnloadGuard()
    try {
      // Round-trip through Google to mint a fresh Convex JWT, then land back
      // on this painting so no work is lost.
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.pathname + window.location.search,
      })
      if (result.error) {
        setSigningIn(false)
        resumeUnloadGuard()
      }
      // On success the browser navigates away; leave the spinner running.
    } catch {
      setSigningIn(false)
      resumeUnloadGuard()
    }
  }

  return (
    <div
      role="alert"
      className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 text-amber-900 shadow-lg backdrop-blur-sm max-w-[calc(100%-1rem)]"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
      <div className="text-xs leading-snug">
        <span className="font-semibold">Changes aren&apos;t saving.</span>{' '}
        <span className="hidden sm:inline">{detail}</span>
        {sync.pendingStrokeCount > 0 && (
          <span>
            {' '}
            {sync.pendingStrokeCount} stroke{sync.pendingStrokeCount === 1 ? '' : 's'} waiting to sync.
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isAuthIssue && (
          <button
            type="button"
            onClick={handleSignInAgain}
            disabled={signingIn}
            className="flex items-center gap-1 rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {signingIn && <Loader2 className="h-3 w-3 animate-spin" />}
            {/* Also offered when the session is fully expired (isSignedIn
                false) — that state previously had no actionable CTA. */}
            {isSignedIn ? 'Sign in again' : 'Sign in'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void retrySync()}
          disabled={sync.retrying}
          className="flex items-center gap-1 rounded border border-amber-400 px-2 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-60"
        >
          {sync.retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Retry
        </button>
      </div>
    </div>
  )
}
