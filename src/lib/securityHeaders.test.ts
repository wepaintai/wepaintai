import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy, generateCspNonce } from './securityHeaders'

function parse(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/)
      return [name!, sources]
    }),
  )
}

describe('buildContentSecurityPolicy', () => {
  it('locks down framing, base, objects and forms', () => {
    const csp = parse(buildContentSecurityPolicy({ nonce: 'abc123==' }))
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('form-action')).toEqual(["'self'"])
    expect(csp.get('default-src')).toEqual(["'self'"])
  })

  it('allows scripts only from self, the nonce and PostHog — never unsafe-inline/eval', () => {
    const scriptSrc = parse(buildContentSecurityPolicy({ nonce: 'abc123==' })).get('script-src')!
    expect(scriptSrc).toEqual([
      "'self'",
      "'nonce-abc123=='",
      'https://us.i.posthog.com',
      'https://us-assets.i.posthog.com',
    ])
    expect(scriptSrc.join(' ')).not.toMatch(/unsafe/)
  })

  it('keeps the source lists the app needs', () => {
    const csp = parse(buildContentSecurityPolicy({ nonce: 'n' }))
    expect(csp.get('connect-src')).toEqual(expect.arrayContaining(["'self'", 'https:', 'wss:']))
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:'])
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(csp.get('font-src')).toEqual(["'self'", 'data:', 'https:'])
    expect(csp.get('worker-src')).toEqual(["'self'", 'blob:'])
  })

  it('adds explicit backend origins (http/ws for a local Convex backend)', () => {
    const csp = parse(
      buildContentSecurityPolicy({
        nonce: 'n',
        backendOrigins: ['http://127.0.0.1:3210', 'http://127.0.0.1:3211/', undefined, 'not a url'],
      }),
    )
    expect(csp.get('connect-src')).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:3210',
        'ws://127.0.0.1:3210',
        'http://127.0.0.1:3211',
        'ws://127.0.0.1:3211',
      ]),
    )
    expect(csp.get('img-src')).toEqual(
      expect.arrayContaining(['http://127.0.0.1:3210', 'http://127.0.0.1:3211']),
    )
    expect(csp.get('img-src')).not.toContain('ws://127.0.0.1:3210')
  })

  it('rejects a nonce that could inject directives', () => {
    expect(() => buildContentSecurityPolicy({ nonce: "x'; script-src *" })).toThrow()
  })
})

describe('generateCspNonce', () => {
  it('returns unique 128-bit base64 nonces', () => {
    const a = generateCspNonce()
    const b = generateCspNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(() => buildContentSecurityPolicy({ nonce: a })).not.toThrow()
  })
})
