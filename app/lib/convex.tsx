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
    debugAuthState()
  }, [])

  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      {children}
    </ConvexBetterAuthProvider>
  );
}

export { convex };