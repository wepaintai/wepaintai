import { useConvexAuth, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useAuthState } from '../lib/auth-client'

export function AuthDebug() {
  // Better Auth session state
  const { isSignedIn, isLoaded, user, userId } = useAuthState()

  // Convex auth state
  const { isAuthenticated, isLoading } = useConvexAuth()
  const currentUser = useQuery(api.auth.getCurrentUser)

  // Only show in development and when auth is not disabled
  if (import.meta.env.PROD || import.meta.env.VITE_AUTH_DISABLED === 'true') return null

  return (
    <div className="fixed bottom-4 left-4 bg-black/90 text-white p-4 rounded-lg text-xs font-mono max-w-sm z-50">
      <h3 className="font-bold mb-2">🔐 Auth Debug</h3>

      <div className="space-y-2">
        <div>
          <strong>Better Auth Status:</strong>
          <div className="ml-2">
            - Loaded: {isLoaded ? '✅' : '⏳'}
            - Signed In: {isSignedIn ? '✅' : '❌'}
            - User ID: {userId || 'none'}
            - Email: {user?.email || 'none'}
          </div>
        </div>

        <div>
          <strong>Convex Status:</strong>
          <div className="ml-2">
            - Authenticated: {isAuthenticated ? '✅' : '❌'}
            - Loading: {isLoading ? '⏳' : '✅'}
            - User Query: {currentUser ? '✅ Has user data' : '❌ No user data'}
            - User ID: {currentUser?._id || 'none'}
          </div>
        </div>

        <div>
          <strong>Integration Status:</strong>
          <div className="ml-2">
            {isSignedIn && isAuthenticated ? (
              <span className="text-green-400">✅ Fully integrated</span>
            ) : isSignedIn && !isAuthenticated && isLoading ? (
              <span className="text-yellow-400">⏳ Syncing...</span>
            ) : isSignedIn && !isAuthenticated ? (
              <span className="text-red-400">❌ Better Auth signed in but Convex not authenticated</span>
            ) : (
              <span className="text-gray-400">👤 Not signed in</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
