import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.CONVEX_SITE_URL || "https://polished-flamingo-936.convex.site",
  plugins: [convexClient()],
})
