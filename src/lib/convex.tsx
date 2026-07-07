import { ConvexReactClient } from "convex/react";
import { ConvexClient } from "convex/browser";
import { ConvexBetterAuthProvider, type AuthClient } from "@convex-dev/better-auth/react";
import { authClient } from "./auth-client";
import type { ReactNode } from "react";

export const convexHigh = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
export const convexLow = new ConvexClient(import.meta.env.VITE_CONVEX_URL as string);

export function ConvexClientProvider({
  children,
  initialToken,
}: {
  children: ReactNode;
  initialToken?: string | null;
}) {
  return (
    <ConvexBetterAuthProvider
      client={convexHigh}
      // The package's AuthClient type collapses useSession data to `never`
      // (better-auth 1.6.23 type quirk); runtime shape is correct.
      authClient={authClient as unknown as AuthClient}
      initialToken={initialToken}
    >
      {children}
    </ConvexBetterAuthProvider>
  );
}
