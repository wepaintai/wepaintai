import { useEffect, useRef } from 'react'
import { authClient } from '../lib/auth-client'
import { useConvexAuth } from 'convex/react'

/**
 * Hook that automatically syncs Better Auth session with Convex authentication.
 * When a Better Auth session exists but Convex is not authenticated, it fetches
 * and stores the Convex token.
 */
export function useAutoSyncConvexAuth() {
  const { isAuthenticated: hasConvexAuth, isLoading: convexLoading } = useConvexAuth()
  const hasTriggeredRef = useRef(false)
  const checkIntervalRef = useRef<number>()
  
  useEffect(() => {
    // Don't run on server
    if (typeof window === 'undefined') return
    
    // Clean up interval on unmount
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current)
      }
    }
  }, [])
  
  useEffect(() => {
    // Don't run if Convex is still loading
    if (convexLoading) return
    
    // If Convex is authenticated, we're done
    if (hasConvexAuth) {
      hasTriggeredRef.current = false
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current)
        checkIntervalRef.current = undefined
      }
      console.log('[useAutoSyncConvexAuth] Convex is authenticated, no action needed')
      return
    }
    
    // Check for Better Auth session and sync if needed
    async function checkAndSync() {
      try {
        const session = await authClient.getSession()
        
        if (!session?.user) {
          console.log('[useAutoSyncConvexAuth] No Better Auth session found')
          hasTriggeredRef.current = false
          return
        }
        
        // We have a Better Auth session but no Convex auth
        if (!hasTriggeredRef.current) {
          console.log('[useAutoSyncConvexAuth] Better Auth session found, fetching Convex token...')
          hasTriggeredRef.current = true
          
          const tokenResult = await authClient.convex.token()
          
          if (tokenResult.data?.token) {
            console.log('[useAutoSyncConvexAuth] Token fetched successfully, storing...')
            
            // Get the Convex URL and construct the storage key
            const convexUrl = import.meta.env.VITE_CONVEX_URL
            const storageKey = `convex-auth:${convexUrl}`
            
            // Store the token in the format Convex expects
            localStorage.setItem(storageKey, JSON.stringify({
              token: tokenResult.data.token,
              fetchedAt: Date.now()
            }))
            
            console.log('[useAutoSyncConvexAuth] Token stored, reloading to apply...')
            
            // Reload to make Convex pick up the new token
            window.location.reload()
          } else {
            console.error('[useAutoSyncConvexAuth] No token in response:', tokenResult)
            hasTriggeredRef.current = false
          }
        }
      } catch (error) {
        console.error('[useAutoSyncConvexAuth] Error during sync:', error)
        hasTriggeredRef.current = false
      }
    }
    
    // Check immediately
    checkAndSync()
    
    // Also check periodically in case the session appears later
    if (!checkIntervalRef.current) {
      checkIntervalRef.current = window.setInterval(checkAndSync, 2000)
    }
  }, [hasConvexAuth, convexLoading])
}