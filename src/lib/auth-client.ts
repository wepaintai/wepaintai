import { createAuthClient } from 'better-auth/react'
import type { BetterAuthClientPlugin } from 'better-auth'
import { convexClient } from '@convex-dev/better-auth/client/plugins'

// ConvexBetterAuthProvider completes the server plugin's one-time-token
// handoff when an OAuth callback returns to a preview. Keep ordinary browser
// cookies (rather than the cross-domain client's localStorage transport) and
// expose only the local action it uses to refresh session state afterward.
const previewSessionHandoffClient = {
  id: 'preview-session-handoff',
  getActions: (_fetch, store) => ({
    updateSession: () => store.notify('$sessionSignal'),
  }),
} satisfies BetterAuthClientPlugin

export const authClient = createAuthClient({
  plugins: [convexClient(), previewSessionHandoffClient],
})

/**
 * Auth state hook shaped like the Clerk hooks it replaced:
 * `isLoaded` is true once the session request settles, `isSignedIn`/`user`
 * reflect the Better Auth session.
 */
export function useAuthState() {
  const { data: session, isPending } = authClient.useSession()
  return {
    isLoaded: !isPending,
    isSignedIn: !!session?.user,
    user: session?.user ?? null,
    userId: session?.user?.id ?? null,
  }
}
