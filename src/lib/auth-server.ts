import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start'

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
 * Proxy /api/auth/* to the Convex HTTP actions deployment.
 *
 * This replicates the header handling of the component's built-in `handler`,
 * but buffers the request body: the built-in handler forwards the body as a
 * stream, which undici cannot replay when the upstream responds early
 * (e.g. a 401 on bad credentials), turning auth errors into
 * 500 "fetch failed" responses.
 */
export async function authProxyHandler(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  const target = `${convexSiteUrl}${requestUrl.pathname}${requestUrl.search}`

  const headers = new Headers(request.headers)
  headers.delete('transfer-encoding')
  headers.delete('content-length')
  headers.delete('connection')
  headers.set('accept-encoding', 'identity')
  headers.set('host', new URL(convexSiteUrl).host)
  headers.set('x-forwarded-host', requestUrl.host)
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(/:$/, ''))
  headers.set('x-better-auth-forwarded-host', requestUrl.host)
  headers.set(
    'x-better-auth-forwarded-proto',
    requestUrl.protocol.replace(/:$/, ''),
  )

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer()

  return fetch(target, {
    method: request.method,
    headers,
    redirect: 'manual',
    body,
  })
}
