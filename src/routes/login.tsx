import React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { GoogleSignInButton } from '../components/GoogleSignInButton'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginComponent,
})

function LoginComponent() {
  const { redirect } = Route.useSearch()
  // Only same-origin paths, so the param can't redirect off-site. Resolve the
  // value against our origin and compare origins rather than string-matching
  // prefixes (e.g. `/\evil.com` resolves to https://evil.com/).
  const callbackURL = React.useMemo(() => {
    if (!redirect || typeof window === 'undefined') return '/'
    try {
      const url = new URL(redirect, window.location.origin)
      return url.origin === window.location.origin
        ? url.pathname + url.search + url.hash
        : '/'
    } catch {
      return '/'
    }
  }, [redirect])
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl p-8">
        <h1 className="text-2xl font-bold text-white mb-2 text-center">
          Sign in to wePaintAI
        </h1>
        <p className="text-white/60 text-sm text-center mb-2">
          Sign in with your Google account to save your work and use AI
          features.
        </p>
        <p className="text-white/70 text-xs text-center mb-6">
          New here? Signing in with Google creates your account automatically.
        </p>
        <GoogleSignInButton callbackURL={callbackURL} />
      </div>
    </div>
  )
}
