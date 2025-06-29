import { useEffect, useRef } from 'react'
import { authClient } from '../lib/auth-client'
import { useAuth } from '@convex-dev/better-auth/react'

/**
 * Hook that automatically syncs Better Auth session with Convex authentication.
 * This works by triggering the built-in token fetch mechanism when a session exists.
 */
export function useAutoSyncConvexAuth() {
  const { isAuthenticated, isLoading, fetchAccessToken } = useAuth()
  const hasTriggeredRef = useRef(false)
  
  useEffect(() => {
    // Don't run on server or while loading
    if (typeof window === 'undefined' || isLoading) return
    
    // Reset trigger when user logs out
    if (!isAuthenticated) {
      hasTriggeredRef.current = false
      return
    }
    
    // If we're authenticated but haven't triggered token fetch yet
    if (isAuthenticated && !hasTriggeredRef.current) {
      console.log('[useAutoSyncConvexAuth] User is authenticated, triggering Convex token fetch...')
      hasTriggeredRef.current = true
      
      // Force refresh the access token
      // This should trigger the ConvexBetterAuthProvider to fetch and store the token
      fetchAccessToken({ forceRefreshToken: true })
        .then((token) => {
          console.log('[useAutoSyncConvexAuth] Token fetch result:', token ? 'Success' : 'Failed')
        })
        .catch((error) => {
          console.error('[useAutoSyncConvexAuth] Error fetching token:', error)
          hasTriggeredRef.current = false // Allow retry on error
        })
    }
  }, [isAuthenticated, isLoading, fetchAccessToken])
}