import React from 'react'
import { Loader2 } from 'lucide-react'
import { authClient } from '../lib/auth-client'

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.46a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.28a7.21 7.21 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77z"
      />
    </svg>
  )
}

// If the browser hasn't navigated to Google within this window (popup/redirect
// blocked, network stall), give up on the spinner and let the user retry.
const REDIRECT_TIMEOUT_MS = 15_000

/**
 * The only way to sign in / sign up: Google OAuth.
 * After the OAuth round-trip, Better Auth redirects back to `callbackURL`
 * (or back here with an `error` query param if the round-trip failed).
 */
export function GoogleSignInButton({ callbackURL }: { callbackURL?: string }) {
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const redirectTimeoutRef = React.useRef<number | undefined>(undefined)

  // Surface OAuth round-trip failures: Better Auth sends the user back with
  // an `error` query param, e.g. `access_denied` when they cancel at Google.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get('error')
    if (!oauthError) return
    setError(
      oauthError === 'access_denied'
        ? 'Sign-in was cancelled.'
        : 'Sign-in failed. Please try again.'
    )
    // Drop the param so a refresh doesn't re-show a stale error
    params.delete('error')
    const query = params.toString()
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? `?${query}` : '') + window.location.hash
    )
  }, [])

  React.useEffect(() => {
    return () => window.clearTimeout(redirectTimeoutRef.current)
  }, [])

  const handleClick = async () => {
    setError(null)
    setSubmitting(true)
    window.clearTimeout(redirectTimeoutRef.current)
    redirectTimeoutRef.current = window.setTimeout(() => {
      setSubmitting(false)
      setError(
        "Couldn't reach Google. Check your connection and pop-up blocker, then try again."
      )
    }, REDIRECT_TIMEOUT_MS)
    try {
      // An absolute URL preserves the frontend host through the deployment's
      // fixed Google callback (app.wepaint.ai or a preview-auth slot).
      const redirectTo = new URL(
        callbackURL ?? '/',
        window.location.origin,
      ).toString()
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: redirectTo,
        errorCallbackURL: redirectTo,
      })
      if (result.error) {
        window.clearTimeout(redirectTimeoutRef.current)
        setError(result.error.message || 'Sign-in failed. Please try again.')
        setSubmitting(false)
      }
      // On success the browser navigates to Google; the spinner keeps running
      // until then, with the timeout above as the safety net.
    } catch (err) {
      window.clearTimeout(redirectTimeoutRef.current)
      console.error('[GoogleSignInButton] Error:', err)
      setError('Sign-in failed. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-800 font-medium py-2.5 px-4 rounded border border-gray-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <GoogleLogo />}
        Continue with Google
      </button>
      {error && <p className="text-sm text-red-400 text-center">{error}</p>}
    </div>
  )
}
