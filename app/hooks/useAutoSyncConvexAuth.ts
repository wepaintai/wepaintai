import { useEffect, useRef } from 'react'
import { authClient } from '../lib/auth-client'
import { useConvexAuth } from 'convex/react'

/**
 * Hook that automatically syncs Better Auth session with Convex authentication.
 * This ensures that when a user signs in with Better Auth, their Convex token
 * is automatically fetched and stored.
 */
export function useAutoSyncConvexAuth() {
  const { isAuthenticated: hasConvexAuth, isLoading: convexLoading } = useConvexAuth()
  const hasTriggeredRef = useRef(false)
  
  useEffect(() => {
    // Don't run on server
    if (typeof window === 'undefined') return
    
    // Don't run if Convex is still loading
    if (convexLoading) return
    
    // Reset trigger when user logs out
    if (!hasConvexAuth) {
      hasTriggeredRef.current = false
    }
    
    async function checkAndSyncAuth() {
      try {
        // Get Better Auth session
        const session = await authClient.getSession()
        console.log('[useAutoSyncConvexAuth] Better Auth session:', session?.user?.email)
        console.log('[useAutoSyncConvexAuth] Convex authenticated:', hasConvexAuth)
        console.log('[useAutoSyncConvexAuth] Has triggered:', hasTriggeredRef.current)
        
        // If we have a Better Auth session but no Convex auth, and haven't tried yet
        if (session?.user && !hasConvexAuth && !hasTriggeredRef.current) {
          console.log('[useAutoSyncConvexAuth] Fetching Convex token...')
          hasTriggeredRef.current = true
          
          // Fetch the Convex token
          const tokenResult = await authClient.convex.token()
          console.log('[useAutoSyncConvexAuth] Token result:', tokenResult)
          
          if (tokenResult.data?.token) {
            // Store the token in localStorage with the expected key format
            // ConvexReactClient looks for tokens with keys like:
            // convex-auth:<convex-url>
            const convexUrl = import.meta.env.VITE_CONVEX_URL
            const storageKey = `convex-auth:${convexUrl}`
            
            localStorage.setItem(storageKey, JSON.stringify({
              token: tokenResult.data.token,
              fetchedAt: Date.now()
            }))
            
            console.log('[useAutoSyncConvexAuth] Token stored in localStorage with key:', storageKey)
            
            // Force a re-render by updating a dummy state or reloading the page
            // The Convex client should pick up the new token from localStorage
            window.location.reload()
          }
        }
      } catch (error) {
        console.error('[useAutoSyncConvexAuth] Error syncing auth:', error)
        hasTriggeredRef.current = false // Allow retry on error
      }
    }
    
    checkAndSyncAuth()
  }, [hasConvexAuth, convexLoading])
}