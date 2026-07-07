import { createAuthClient } from 'better-auth/react'
import { convexClient } from '@convex-dev/better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [convexClient()],
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
