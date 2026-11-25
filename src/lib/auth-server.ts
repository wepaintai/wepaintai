import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start'
import { createAuthProxyHandler, hostsFromConfig } from './authProxy'

const convexUrl =
  import.meta.env.VITE_CONVEX_URL ?? process.env.VITE_CONVEX_URL
const convexSiteUrl =
  import.meta.env.VITE_CONVEX_SITE_URL ?? process.env.VITE_CONVEX_SITE_URL

if (!convexUrl || !convexSiteUrl) {
  throw new Error('VITE_CONVEX_URL and VITE_CONVEX_SITE_URL must be set')
}

export const { getToken } = convexBetterAuthReactStart({
  convexUrl,
  convexSiteUrl,
  basePath: '/api/auth',
})

/**
 * Proxy /api/auth/* to the Convex HTTP actions deployment (same-origin auth
 * cookies). A client-supplied X-Forwarded-Host is forwarded only if it is one
 * of the app's public hosts (app/www/apex wepaint.ai, preview-pr-N /
 * preview-auth-N), a host from SITE_URL / APP_URL / VITE_APP_URL /
 * AUTH_TRUSTED_HOSTS (comma-separated) in the server's runtime env, or
 * localhost in development. Otherwise the request's own host is used.
 */
export const authProxyHandler = createAuthProxyHandler({
  convexSiteUrl,
  trustedHosts: {
    extraHosts: hostsFromConfig([
      process.env.SITE_URL,
      process.env.APP_URL,
      import.meta.env.VITE_APP_URL ?? process.env.VITE_APP_URL,
      process.env.AUTH_TRUSTED_HOSTS,
    ]),
    allowLocalhost: import.meta.env.DEV,
  },
})
