import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

// Debug auth client configuration
const baseURL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
console.log('[Auth Client] Using baseURL:', baseURL);

export const authClient = createAuthClient({
  baseURL,
  plugins: [
    convexClient(),
  ],
});