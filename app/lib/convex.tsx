import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ReactNode, useEffect } from "react";
import { authClient, debugAuthState } from "./auth-client";

// Create Convex client - auth will be handled by ConvexBetterAuthProvider
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // Debug: Check auth state on mount
  useEffect(() => {
    console.log('[ConvexClientProvider] Mounted, checking auth state...')
    debugAuthState()
    
    // Monitor auth token changes
    const checkAuthState = async () => {
      const convexUrl = import.meta.env.VITE_CONVEX_URL!
      const urlKey = convexUrl.replace('https://', '').replace('/', '')
      const tokenKey = `__convexAuthJWT_${urlKey}`
      const token = localStorage.getItem(tokenKey)
      
      if (token) {
        console.log('[ConvexClientProvider] Auth token present, length:', token.length)
        // Decode JWT to check expiry (without verification, just for debugging)
        try {
          const payload = JSON.parse(atob(token.split('.')[1]))
          console.log('[ConvexClientProvider] Token expires at:', new Date(payload.exp * 1000))
        } catch (e) {
          console.log('[ConvexClientProvider] Could not decode token')
        }
      } else {
        console.log('[ConvexClientProvider] No auth token found')
        
        // Check if we have a better-auth session
        const sessionData = localStorage.getItem('better-auth_session_data')
        if (sessionData) {
          console.log('[ConvexClientProvider] Better-auth session exists, but no Convex token')
          
          // Try to manually fetch the Convex token
          try {
            const response = await fetch(`${authClient.options.baseURL}/api/auth/convex/token`, {
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
              },
            })
            console.log('[ConvexClientProvider] Manual token fetch response:', response.status)
            if (response.ok) {
              const data = await response.json()
              console.log('[ConvexClientProvider] Token data:', data)
            }
          } catch (error) {
            console.error('[ConvexClientProvider] Error fetching token:', error)
          }
        }
      }
    }
    
    // Check immediately and then periodically
    checkAuthState()
    const interval = setInterval(checkAuthState, 5000)
    
    return () => clearInterval(interval)
  }, [])

  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      {children}
    </ConvexBetterAuthProvider>
  );
}

export { convex };
