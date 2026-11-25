import { createRouter } from '@tanstack/react-router'
import { createIsomorphicFn } from '@tanstack/react-start'
import { routeTree } from './routeTree.gen'
import { generateCspNonce } from './lib/securityHeaders'

/**
 * Per-request CSP nonce. On the server, getRouter() runs once per request:
 * the nonce goes into `ssr.nonce`, which TanStack Start puts on every inline
 * script it emits, and the root route's `headers` turns it into the
 * Content-Security-Policy response header. On the client the router reads it
 * back from the <meta property="csp-nonce"> that <HeadContent /> renders.
 *
 * Skipped in `vite dev`, whose HMR preamble is an un-nonced inline script.
 */
const getCspNonce = createIsomorphicFn()
  .server((): string | undefined => (import.meta.env.DEV ? undefined : generateCspNonce()))
  .client((): string | undefined => undefined)

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    ssr: { nonce: getCspNonce() },
  })

  return router
}
