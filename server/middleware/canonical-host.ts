import { defineEventHandler, getRequestHost, redirect } from 'nitro/h3'

/**
 * Redirect the apex domain to the canonical app host. Auth only trusts
 * SITE_URL (https://app.wepaint.ai): sign-in from https://wepaint.ai fails
 * Better Auth's origin check, and the OAuth session cookie would land on the
 * wrong host anyway. The Cloudflare tunnel routes the apex to this same node
 * server, so canonicalize here.
 */
export default defineEventHandler((event) => {
  const host = getRequestHost(event, { xForwardedHost: true })
  if (host === 'wepaint.ai') {
    const url = new URL(event.req.url)
    return redirect(`https://app.wepaint.ai${url.pathname}${url.search}`, 301)
  }
})
