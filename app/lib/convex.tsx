import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ReactNode, useEffect } from "react";
import { authClient, debugAuthState } from "./auth-client";

// Create Convex client - auth will be handled by ConvexBetterAuthProvider
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!, {
  verbose: true,
});


export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // Debug: Check auth state on mount
  useEffect(() => {
    console.log('[ConvexClientProvider] Mounted, checking auth state...')
    debugAuthState()
    
    // Immediately try to fetch and set the Convex token
    const initializeAuth = async () => {
      try {
        // Check if we have a session
        const sessionResponse = await fetch(`${authClient.options.baseURL}/api/auth/get-session`, {
          credentials: 'include',
        })
        
        if (sessionResponse.ok) {
          const sessionData = await sessionResponse.json()
          if (sessionData && sessionData.session) {
            console.log('[ConvexClientProvider] Session found, fetching Convex token...')
            
            // Fetch the Convex token
            const tokenResponse = await fetch(`${authClient.options.baseURL}/api/auth/convex/token`, {
              credentials: 'include',
            })
            
            if (tokenResponse.ok) {
              const tokenData = await tokenResponse.json()
              if (tokenData.token) {
                console.log('[ConvexClientProvider] Got Convex token, setting auth...')
                convex.setAuth(tokenData.token)
                
                // Store in localStorage
                const convexUrl = import.meta.env.VITE_CONVEX_URL!
                const urlKey = convexUrl.replace('https://', '').replace('/', '')
                const tokenKey = `__convexAuthJWT_${urlKey}`
                localStorage.setItem(tokenKey, tokenData.token)
                console.log('[ConvexClientProvider] Token set and stored!')
              }
            }
          }
        }
      } catch (error) {
        console.error('[ConvexClientProvider] Error initializing auth:', error)
      }
    }
    
    initializeAuth()
    
    // Monitor auth token changes
    const checkAuthState = async () => {
      const convexUrl = import.meta.env.VITE_CONVEX_URL!
      const urlKey = convexUrl.replace('https://', '').replace('/', '')
      
      // Check all possible token storage locations
      console.log('[ConvexClientProvider] Checking for auth tokens...')
      console.log('[ConvexClientProvider] Convex URL:', convexUrl)
      console.log('[ConvexClientProvider] URL Key:', urlKey)
      
      // List all localStorage keys that might contain auth tokens
      const allKeys = Object.keys(localStorage)
      const authKeys = allKeys.filter(k => k.includes('convex') || k.includes('auth') || k.includes('JWT'))
      console.log('[ConvexClientProvider] Auth-related localStorage keys:', authKeys)
      
      // Try different possible token keys
      const possibleKeys = [
        `__convexAuthJWT_${urlKey}`,
        `ConvexAuthJWT_${urlKey}`,
        `convexAuthToken_${urlKey}`,
        `better-auth.convex_jwt`,
      ]
      
      let token = null
      for (const key of possibleKeys) {
        const value = localStorage.getItem(key)
        if (value) {
          console.log(`[ConvexClientProvider] Found token at key: ${key}`)
          token = value
          break
        }
      }
      
      if (token) {
        console.log('[ConvexClientProvider] Auth token present, length:', token.length)
        
        // Set the auth token on the Convex client
        convex.setAuth(token)
        console.log('[ConvexClientProvider] Set auth token on Convex client')
        
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
              
              // Manually set the auth token if we got one
              if (data.token) {
                console.log('[ConvexClientProvider] Manually setting Convex auth token')
                convex.setAuth(data.token)
                
                // Also store in localStorage for persistence
                const tokenKey = `__convexAuthJWT_${urlKey}`
                localStorage.setItem(tokenKey, data.token)
                console.log('[ConvexClientProvider] Token stored in localStorage at key:', tokenKey)
              }
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
