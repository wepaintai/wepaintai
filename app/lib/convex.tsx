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
    const checkAuthState = () => {
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
