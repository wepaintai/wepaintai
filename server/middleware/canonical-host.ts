import { defineEventHandler, getRequestHost, redirect, setResponseHeader } from 'nitro/h3'

/**
 * 1. Redirect the apex / www domains to the canonical app host using 308
 *    (preserving HTTP method/body). The apex is not a trusted auth origin, and
 *    its host-only OAuth session cookie would land on the wrong host anyway.
 * 2. Attach baseline browser security headers to all responses.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'X-Frame-Options', 'DENY')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  setResponseHeader(
    event,
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  )

  const rawHost = getRequestHost(event, { xForwardedHost: true })
  const host = rawHost.toLowerCase().replace(/:\d+$/, '')
  if (host === 'wepaint.ai' || host === 'www.wepaint.ai') {
    const url = new URL(event.req.url)
    return redirect(`https://app.wepaint.ai${url.pathname}${url.search}`, 308)
  }
})
