import { defineMiddleware, getRequestHost, redirect, setResponseHeader } from 'nitro/h3'

/**
 * Baseline browser security headers for every response. The
 * Content-Security-Policy (with frame-ancestors 'none') needs a per-request
 * nonce, so it is sent with SSR HTML from the root route's `headers` instead
 * (src/routes/__root.tsx). Browsers ignore HSTS on plain-http localhost.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

/**
 * h3 merges headers set on the event only into 2xx Responses, so non-2xx
 * Responses (404 pages, auth redirects, 413s, upstream auth errors) get the
 * headers added here directly. Proxied `fetch` Responses have immutable
 * headers and are re-wrapped.
 */
function withSecurityHeaders(response: Response): Response {
  const missing = Object.entries(SECURITY_HEADERS).filter(
    ([name]) => !response.headers.has(name),
  )
  if (missing.length === 0) return response
  try {
    for (const [name, value] of missing) response.headers.set(name, value)
    return response
  } catch {
    const headers = new Headers(response.headers)
    for (const [name, value] of missing) headers.set(name, value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * 1. Redirect the apex / www domains to the canonical app host using 308
 *    (preserving HTTP method/body). The apex is not a trusted auth origin, and
 *    its host-only OAuth session cookie would land on the wrong host anyway.
 * 2. Attach the security headers above to all responses.
 */
export default defineMiddleware(async (event, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    setResponseHeader(event, name, value)
  }

  const rawHost = getRequestHost(event, { xForwardedHost: true })
  const host = rawHost.toLowerCase().replace(/:\d+$/, '')
  if (host === 'wepaint.ai' || host === 'www.wepaint.ai') {
    const url = new URL(event.req.url)
    return redirect(`https://app.wepaint.ai${url.pathname}${url.search}`, 308)
  }

  const result = await next()
  return result instanceof Response && !result.ok ? withSecurityHeaders(result) : result
})
