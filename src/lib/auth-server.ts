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
const MAX_AUTH_PROXY_BODY_BYTES = 1_048_576 // 1 MiB
const AUTH_PROXY_TIMEOUT_MS = 15_000
const normalizedConvexSiteUrl = convexSiteUrl.replace(/\/+$/, '')

export async function authProxyHandler(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  const target = `${normalizedConvexSiteUrl}${requestUrl.pathname}${requestUrl.search}`

  const forwardedHost = request.headers.get('x-forwarded-host') || requestUrl.host
  const forwardedProto =
    request.headers.get('x-forwarded-proto') || requestUrl.protocol.replace(/:$/, '')

  const headers = new Headers(request.headers)
  headers.delete('transfer-encoding')
  headers.delete('content-length')
  headers.delete('connection')
  headers.set('accept-encoding', 'identity')
  headers.set('host', new URL(normalizedConvexSiteUrl).host)
  headers.set('x-forwarded-host', forwardedHost)
  headers.set('x-forwarded-proto', forwardedProto)
  headers.set('x-better-auth-forwarded-host', forwardedHost)
  headers.set('x-better-auth-forwarded-proto', forwardedProto)

  let body: ArrayBuffer | undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentLengthHeader = request.headers.get('content-length')
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_AUTH_PROXY_BODY_BYTES) {
      return new Response('Payload Too Large', { status: 413 })
    }
    const rawBody = await request.arrayBuffer()
    if (rawBody.byteLength > MAX_AUTH_PROXY_BODY_BYTES) {
      return new Response('Payload Too Large', { status: 413 })
    }
    body = rawBody
  }

  return fetch(target, {
    method: request.method,
    headers,
    redirect: 'manual',
    body,
    signal: AbortSignal.timeout(AUTH_PROXY_TIMEOUT_MS),
  })
}
