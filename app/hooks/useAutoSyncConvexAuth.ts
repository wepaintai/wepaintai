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
  const authDisabled = import.meta.env.VITE_AUTH_DISABLED === 'true'
  
  useEffect(() => {
    // Don't run on server or when auth is disabled
    if (typeof window === 'undefined' || authDisabled) return
    
    // Clean up interval on unmount
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current)
      }
    }
  }, [])
  
  useEffect(() => {
    // Don't run if auth is disabled
    if (authDisabled) {
      console.log('[useAutoSyncConvexAuth] Auth is disabled, skipping sync')
      return
    }
    
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
        console.log('[useAutoSyncConvexAuth] getSession result:', session)
        
        // Check for user in either session.user or session.data.user
        const user = session?.user || session?.data?.user
        
        if (!user) {
          console.log('[useAutoSyncConvexAuth] No Better Auth session found - session structure:', {
            hasSession: !!session,
            hasData: !!session?.data,
            hasUser: !!session?.user,
            hasDataUser: !!session?.data?.user,
            fullSession: session
          })
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
  }, [hasConvexAuth, convexLoading, authDisabled])
}