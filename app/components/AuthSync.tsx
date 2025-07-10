import { useEffect, useRef } from 'react'
import { useUser } from '@clerk/tanstack-start'
import { useConvexAuth, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'

export function AuthSync() {
  const { isSignedIn, user } = useUser()
  const { isAuthenticated } = useConvexAuth()
  const storeUser = useMutation(api.auth.storeUser)
  const hasStoredUser = useRef(false)
  
  useEffect(() => {
    // Only store user once per session when both Clerk and Convex are ready
    if (isSignedIn && isAuthenticated && user && !hasStoredUser.current) {
      hasStoredUser.current = true
      
      storeUser()
        .then((userId) => {
          console.log('[AuthSync] User stored successfully:', userId)
        })
        .catch((error) => {
          console.error('[AuthSync] Failed to store user:', error)
          hasStoredUser.current = false // Allow retry
        })
    }
    
    // Reset flag when user signs out
    if (!isSignedIn) {
      hasStoredUser.current = false
    }
  }, [isSignedIn, isAuthenticated, user, storeUser])
  
  return null // This component doesn't render anything
}