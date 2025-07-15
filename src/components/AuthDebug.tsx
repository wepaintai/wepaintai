import { useUser, useAuth as useClerkAuth } from '@clerk/tanstack-start'
import { useConvexAuth, useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useState } from 'react'

export function AuthDebug() {
  // Clerk auth state
  const { isSignedIn, user } = useUser()
  const { userId: clerkUserId } = useClerkAuth()
  
  // Convex auth state
  const { isAuthenticated, isLoading } = useConvexAuth()
  const currentUser = useQuery(api.auth.getCurrentUser)
  const storeUser = useMutation(api.auth.storeUser)
  
  const [storeUserResult, setStoreUserResult] = useState<string>('')
  
  // Only show in development and when auth is not disabled
  if (import.meta.env.PROD || import.meta.env.VITE_AUTH_DISABLED === 'true') return null
  
  const handleStoreUser = async () => {
    try {
      const userId = await storeUser()
      setStoreUserResult(`✅ User stored with ID: ${userId}`)
    } catch (error) {
      setStoreUserResult(`❌ Error: ${error}`)
    }
  }
  
  return (
    <div className="fixed bottom-4 left-4 bg-black/90 text-white p-4 rounded-lg text-xs font-mono max-w-sm z-50">
      <h3 className="font-bold mb-2">🔐 Auth Debug</h3>
      
      <div className="space-y-2">
        <div>
          <strong>Clerk Status:</strong>
          <div className="ml-2">
            - Signed In: {isSignedIn ? '✅' : '❌'}
            - User ID: {clerkUserId || 'none'}
            - Email: {user?.primaryEmailAddress?.emailAddress || 'none'}
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
              <span className="text-red-400">❌ Clerk signed in but Convex not authenticated</span>
            ) : (
              <span className="text-gray-400">👤 Not signed in</span>
            )}
          </div>
        </div>
        
        {isAuthenticated && (
          <div className="mt-2 space-y-1">
            <button
              onClick={handleStoreUser}
              className="bg-blue-500 hover:bg-blue-600 px-2 py-1 rounded text-xs"
            >
              Store User in DB
            </button>
            {storeUserResult && (
              <div className="text-xs">{storeUserResult}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}