/**
 * Content-Security-Policy for SSR HTML responses (AUD-019).
 *
 * Scripts are locked to 'self', a per-request nonce (carried by every inline
 * script TanStack Start emits: scroll restoration, router dehydration and
 * streamed chunks) and the PostHog hosts posthog-js loads its lazy bundles
 * from. No 'unsafe-inline' / 'unsafe-eval' for scripts.
 *
 * The other headers (HSTS, X-Frame-Options, nosniff, Referrer-Policy,
 * Permissions-Policy) are static and set for every response in
 * `server/middleware/canonical-host.ts`.
 */

/** posthog-js: API host plus the CDN it lazy-loads extensions from. */
export const POSTHOG_SCRIPT_HOSTS: readonly string[] = [
  'https://us.i.posthog.com',
  'https://us-assets.i.posthog.com',
]

export type CspOptions = {
  /** Per-request nonce (base64). */
  nonce: string
  /**
   * Explicit origins the app talks to (Convex API / HTTP actions). Needed
   * when they are plain http/ws, e.g. a production build run against a local
   * Convex backend; https/wss origins are already covered.
   */
  backendOrigins?: ReadonlyArray<string | undefined>
}

/** http(s) origin plus its ws(s) counterpart for Convex's sync socket. */
function originsFor(urls: ReadonlyArray<string | undefined>): string[] {
  const origins = new Set<string>()
  for (const raw of urls) {
    if (!raw) continue
    try {
      const url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      origins.add(url.origin)
      origins.add(url.origin.replace(/^http/, 'ws'))
    } catch {
      // Ignore malformed configuration rather than emit a broken header
    }
  }
  return [...origins]
}

export function buildContentSecurityPolicy({ nonce, backendOrigins = [] }: CspOptions): string {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(nonce)) {
    throw new Error('Invalid CSP nonce')
  }
  const backends = originsFor(backendOrigins)
  const httpBackends = backends.filter((origin) => origin.startsWith('http'))

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, ...POSTHOG_SCRIPT_HOSTS]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:', ...httpBackends]],
    ['font-src', ["'self'", 'data:', 'https:']],
    ['connect-src', ["'self'", 'https:', 'wss:', 'data:', 'blob:', ...backends]],
    ['media-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]],
    // Google sign-in is fetch + top-level navigation, never a form post
    ['form-action', ["'self'"]],
  ]

  return directives
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`)
    .join('; ')
}

/** 128-bit random nonce, base64-encoded. */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
