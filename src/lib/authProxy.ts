/**
 * Pure helpers for the /api/auth/* proxy (see `auth-server.ts`).
 *
 * Kept free of env/import side effects so they can be unit-tested.
 */

/** Public hosts that front this app in production. */
export const DEFAULT_TRUSTED_FORWARDED_HOSTS: readonly string[] = [
  'app.wepaint.ai',
  'wepaint.ai',
  'www.wepaint.ai',
]

/** PR preview frontends and their auth hosts (see selfhost/preview). */
const TRUSTED_FORWARDED_HOST_PATTERNS: readonly RegExp[] = [
  /^preview-pr-\d+\.wepaint\.ai$/,
  /^preview-auth-\d+\.wepaint\.ai$/,
]

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

const HOST_SYNTAX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[::1\])(?::(\d{1,5}))?$/

export type TrustedHostOptions = {
  /** Extra hosts (`host` or `host:port`) taken from runtime configuration. */
  extraHosts?: readonly string[]
  /** Accept localhost / 127.0.0.1 / [::1] on any port (development only). */
  allowLocalhost?: boolean
}

type ParsedHost = { host: string; hostname: string; port: string | null }

/**
 * Normalize a Host / X-Forwarded-Host value: lowercase, drop a trailing dot,
 * and keep only the first entry of a comma-separated list. Returns null for
 * anything that is not a plain `hostname[:port]`.
 */
export function parseHost(raw: string | null | undefined): ParsedHost | null {
  if (!raw) return null
  const first = raw.split(',')[0]?.trim().toLowerCase().replace(/\.(?=$|:)/, '')
  if (!first || first.length > 253) return null
  const match = HOST_SYNTAX.exec(first)
  if (!match) return null
  const port = match[1] ?? null
  if (port !== null && Number(port) > 65535) return null
  const hostname = port !== null ? first.slice(0, -(port.length + 1)) : first
  return { host: first, hostname, port }
}

/** Turn configured origins/hosts (`https://x.y`, `x.y:8443`, …) into hosts. */
export function hostsFromConfig(values: ReadonlyArray<string | undefined>): string[] {
  const hosts: string[] = []
  for (const value of values) {
    if (!value) continue
    for (const entry of value.split(',')) {
      const trimmed = entry.trim()
      if (!trimmed) continue
      let candidate = trimmed
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
          candidate = new URL(trimmed).host
        } catch {
          continue
        }
      }
      const parsed = parseHost(candidate)
      if (parsed) hosts.push(parsed.host)
    }
  }
  return hosts
}

/**
 * Whether a forwarded host may be passed to Better Auth as the request's
 * public host. Built-in public hosts and preview patterns must be port-less
 * (they are served on 443). Configured extra hosts must match exactly,
 * including any port. Local hosts are accepted only with `allowLocalhost`.
 */
export function isTrustedForwardedHost(
  rawHost: string | null | undefined,
  options: TrustedHostOptions = {},
): boolean {
  const parsed = parseHost(rawHost)
  if (!parsed) return false
  const { host, hostname, port } = parsed

  if (LOCAL_HOSTNAMES.has(hostname)) return options.allowLocalhost === true

  if (port === null) {
    if (DEFAULT_TRUSTED_FORWARDED_HOSTS.includes(hostname)) return true
    if (TRUSTED_FORWARDED_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
      return true
    }
  }
  return (options.extraHosts ?? []).some((extra) => parseHost(extra)?.host === host)
}

/**
 * Decide which host/proto to report upstream. Client-supplied
 * X-Forwarded-Host is honored only when allowlisted; otherwise the request's
 * own host is used. X-Forwarded-Proto is honored (http/https only) when the
 * effective host is allowlisted — e.g. behind cloudflared, which sets the
 * proto but not the host.
 */
export function resolveForwardedOrigin(
  request: Request,
  options: TrustedHostOptions = {},
): { host: string; proto: string } {
  const requestUrl = new URL(request.url)
  const requestProto = requestUrl.protocol.replace(/:$/, '')

  const forwardedHostHeader = request.headers.get('x-forwarded-host')
  const forwarded = isTrustedForwardedHost(forwardedHostHeader, options)
    ? parseHost(forwardedHostHeader)
    : null
  const host = forwarded?.host ?? requestUrl.host
  const hostTrusted = forwarded !== null || isTrustedForwardedHost(requestUrl.host, options)

  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
    .toLowerCase()
  const proto =
    hostTrusted && (forwardedProto === 'http' || forwardedProto === 'https')
      ? forwardedProto
      : requestProto

  return { host, proto }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Payload Too Large')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a request body into memory, aborting as soon as more than `maxBytes`
 * have arrived. Works whether or not `content-length` is present (chunked
 * uploads) and never buffers more than `maxBytes` + one chunk.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await request.body?.cancel().catch(() => {})
    throw new BodyTooLargeError()
  }
  if (!request.body) return new Uint8Array(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export type AuthProxyConfig = {
  convexSiteUrl: string
  trustedHosts?: TrustedHostOptions
  maxBodyBytes?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export const MAX_AUTH_PROXY_BODY_BYTES = 1_048_576 // 1 MiB
export const AUTH_PROXY_TIMEOUT_MS = 15_000

/**
 * Proxy /api/auth/* to the Convex HTTP actions deployment.
 *
 * This replicates the header handling of the component's built-in `handler`,
 * but buffers the request body: the built-in handler forwards the body as a
 * stream, which undici cannot replay when the upstream responds early
 * (e.g. a 401 on bad credentials), turning auth errors into
 * 500 "fetch failed" responses.
 */
export function createAuthProxyHandler(config: AuthProxyConfig) {
  const siteUrl = config.convexSiteUrl.replace(/\/+$/, '')
  const siteHost = new URL(siteUrl).host
  const maxBodyBytes = config.maxBodyBytes ?? MAX_AUTH_PROXY_BODY_BYTES
  const timeoutMs = config.timeoutMs ?? AUTH_PROXY_TIMEOUT_MS
  const doFetch = config.fetchImpl ?? fetch

  return async function authProxyHandler(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url)
    const target = `${siteUrl}${requestUrl.pathname}${requestUrl.search}`
    const { host, proto } = resolveForwardedOrigin(request, config.trustedHosts)

    const headers = new Headers(request.headers)
    headers.delete('transfer-encoding')
    headers.delete('content-length')
    headers.delete('connection')
    headers.set('accept-encoding', 'identity')
    headers.set('host', siteHost)
    headers.set('x-forwarded-host', host)
    headers.set('x-forwarded-proto', proto)
    headers.set('x-better-auth-forwarded-host', host)
    headers.set('x-better-auth-forwarded-proto', proto)

    let body: Uint8Array<ArrayBuffer> | undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        body = await readBodyWithLimit(request, maxBodyBytes)
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return new Response('Payload Too Large', { status: 413 })
        }
        throw error
      }
    }

    return doFetch(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
}
