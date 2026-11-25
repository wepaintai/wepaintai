import { createRouter } from '@tanstack/react-router'
import { createIsomorphicFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { routeTree } from './routeTree.gen'
import { buildContentSecurityPolicy, generateCspNonce } from './lib/securityHeaders'

/**
 * Per-request CSP nonce. On the server, getRouter() runs once per request:
 * generate a nonce, send the matching Content-Security-Policy header, and hand
 * the nonce to the router so every inline script it emits carries it. On the
 * client the router picks the nonce up from the <meta property="csp-nonce">
 * that <HeadContent /> renders from `ssr.nonce`.
 *
 * Skipped in `vite dev`, whose HMR preamble is an un-nonced inline script.
 */
const getCspNonce = createIsomorphicFn()
  .server((): string | undefined => {
    if (import.meta.env.DEV) return undefined
    const nonce = generateCspNonce()
    setResponseHeader(
      'Content-Security-Policy',
      buildContentSecurityPolicy({
        nonce,
        backendOrigins: [
          import.meta.env.VITE_CONVEX_URL ?? process.env.VITE_CONVEX_URL,
          import.meta.env.VITE_CONVEX_SITE_URL ?? process.env.VITE_CONVEX_SITE_URL,
        ],
      }),
    )
    return nonce
  })
  .client((): string | undefined => undefined)

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    ssr: { nonce: getCspNonce() },
  })

  return router
}
