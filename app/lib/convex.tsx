import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ReactNode, useEffect } from "react";
import { authClient, debugAuthState } from "./auth-client";

// Ensure VITE_CONVEX_URL is a string
const convexUrl = String(import.meta.env.VITE_CONVEX_URL || '');

if (!convexUrl) {
  throw new Error('VITE_CONVEX_URL environment variable is not set');
}

// Create Convex client - auth will be handled by ConvexBetterAuthProvider
const convex = new ConvexReactClient(convexUrl, {
  verbose: true,
});

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // Debug: Check auth state on mount
  useEffect(() => {
    console.log('[ConvexClientProvider] Mounted, checking auth state...')
    console.log('[ConvexClientProvider] Convex URL:', convexUrl)
    console.log('[ConvexClientProvider] Auth disabled:', import.meta.env.VITE_AUTH_DISABLED)
    debugAuthState()
    
    // Additional debug: Check if ConvexReactClient has auth
    console.log('[ConvexClientProvider] Convex client auth state:', convex.auth)
  }, [])

  return (
    <ConvexProvider client={convex}>
      <ConvexBetterAuthProvider 
        client={convex} 
        authClient={authClient}
        verbose={true}
      >
        {children}
      </ConvexBetterAuthProvider>
    </ConvexProvider>
  );
}

export { convex };