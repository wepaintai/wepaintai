import { ConvexReactClient } from "convex/react";
import { ConvexClient } from "convex/browser";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/tanstack-start";
import type { ReactNode } from "react";

export const convexHigh = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
export const convexLow = new ConvexClient(import.meta.env.VITE_CONVEX_URL as string);

export function ConvexClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ConvexProviderWithClerk
      client={convexHigh}
      useAuth={useAuth}
    >
      {children}
    </ConvexProviderWithClerk>
  );
}
