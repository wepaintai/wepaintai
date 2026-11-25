import { describe, expect, it, vi } from 'vitest'
import {
  BodyTooLargeError,
  createAuthProxyHandler,
  hostsFromConfig,
  isTrustedForwardedHost,
  parseHost,
  readBodyWithLimit,
  resolveForwardedOrigin,
} from './authProxy'

describe('parseHost', () => {
  it('normalizes case, trailing dots, ports and lists', () => {
    expect(parseHost('App.WePaint.AI')).toEqual({
      host: 'app.wepaint.ai',
      hostname: 'app.wepaint.ai',
      port: null,
    })
    expect(parseHost('app.wepaint.ai.')?.host).toBe('app.wepaint.ai')
    expect(parseHost('localhost:3000')).toEqual({
      host: 'localhost:3000',
      hostname: 'localhost',
      port: '3000',
    })
    expect(parseHost(' app.wepaint.ai , evil.com')?.host).toBe('app.wepaint.ai')
    expect(parseHost('[::1]:3000')?.hostname).toBe('[::1]')
  })

  it('rejects malformed values', () => {
    for (const bad of [
      null,
      '',
      'app.wepaint.ai/evil',
      'user@app.wepaint.ai',
      'app.wepaint.ai:99999',
      'app.wepaint.ai:',
      'app..wepaint.ai',
      '-app.wepaint.ai',
      'app.wepaint.ai\r\nx: y',
    ]) {
      expect(parseHost(bad)).toBeNull()
    }
  })
})

describe('isTrustedForwardedHost', () => {
  it('accepts the built-in public hosts and preview patterns', () => {
    for (const host of [
      'app.wepaint.ai',
      'wepaint.ai',
      'www.wepaint.ai',
      'APP.WEPAINT.AI',
      'preview-pr-101.wepaint.ai',
      'preview-auth-3.wepaint.ai',
      'app.wepaint.ai, attacker.example',
    ]) {
      expect(isTrustedForwardedHost(host), host).toBe(true)
    }
  })

  it('rejects look-alikes and unanchored matches', () => {
    for (const host of [
      'evil.com',
      'app.wepaint.ai.evil.com',
      'evilwepaint.ai',
      'xpreview-pr-1.wepaint.ai',
      'preview-pr-1.wepaint.ai.evil.com',
      'preview-pr-.wepaint.ai',
      'preview-pr-abc.wepaint.ai',
      'preview-foo-1.wepaint.ai',
      'attacker.example, app.wepaint.ai',
      'app.wepaint.ai:8443',
      undefined,
    ]) {
      expect(isTrustedForwardedHost(host), String(host)).toBe(false)
    }
  })

  it('accepts localhost only when allowed (development)', () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
      expect(isTrustedForwardedHost(host), host).toBe(false)
      expect(isTrustedForwardedHost(host, { allowLocalhost: true }), host).toBe(true)
    }
  })

  it('accepts configured extra hosts exactly', () => {
    const extraHosts = hostsFromConfig([
      'https://staging.example.com',
      undefined,
      'other.example.com:8443, https://Third.Example.com/',
      'not a url://',
    ])
    expect(extraHosts).toEqual([
      'staging.example.com',
      'other.example.com:8443',
      'third.example.com',
    ])
    expect(isTrustedForwardedHost('staging.example.com', { extraHosts })).toBe(true)
    expect(isTrustedForwardedHost('third.example.com', { extraHosts })).toBe(true)
    expect(isTrustedForwardedHost('other.example.com:8443', { extraHosts })).toBe(true)
    expect(isTrustedForwardedHost('other.example.com', { extraHosts })).toBe(false)
    expect(isTrustedForwardedHost('staging.example.com:444', { extraHosts })).toBe(false)
    expect(isTrustedForwardedHost('sub.staging.example.com', { extraHosts })).toBe(false)
  })
})

describe('resolveForwardedOrigin', () => {
  const req = (url: string, headers: Record<string, string>) => new Request(url, { headers })

  it('uses an allowlisted forwarded host and proto', () => {
    expect(
      resolveForwardedOrigin(
        req('http://127.0.0.1:3000/api/auth/get-session', {
          'x-forwarded-host': 'preview-pr-7.wepaint.ai',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toEqual({ host: 'preview-pr-7.wepaint.ai', proto: 'https' })
  })

  it('ignores a spoofed forwarded host and its proto', () => {
    expect(
      resolveForwardedOrigin(
        req('http://127.0.0.1:3000/api/auth/get-session', {
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toEqual({ host: '127.0.0.1:3000', proto: 'http' })
  })

  it('accepts the proto alone when the request host is allowlisted (cloudflared)', () => {
    expect(
      resolveForwardedOrigin(
        req('http://app.wepaint.ai/api/auth/get-session', { 'x-forwarded-proto': 'https' }),
      ),
    ).toEqual({ host: 'app.wepaint.ai', proto: 'https' })
  })

  it('rejects non-http(s) proto values', () => {
    expect(
      resolveForwardedOrigin(
        req('http://app.wepaint.ai/x', {
          'x-forwarded-host': 'app.wepaint.ai',
          'x-forwarded-proto': 'javascript',
        }),
      ),
    ).toEqual({ host: 'app.wepaint.ai', proto: 'http' })
  })

  it('falls back to the request host when an untrusted host is forwarded', () => {
    expect(
      resolveForwardedOrigin(
        req('http://app.wepaint.ai/x', {
          'x-forwarded-host': 'app.wepaint.ai.evil.com',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toEqual({ host: 'app.wepaint.ai', proto: 'https' })
  })
})

function streamOf(chunks: Uint8Array[], onCancel?: () => void, onPull?: () => void) {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.()
      if (index < chunks.length) controller.enqueue(chunks[index++])
      else controller.close()
    },
    cancel() {
      onCancel?.()
    },
  })
}

function streamingRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request('http://app.wepaint.ai/api/auth/sign-in/social', {
    method: 'POST',
    body,
    headers,
    // Required by the fetch spec for streaming request bodies
    duplex: 'half',
  } as RequestInit)
}

describe('readBodyWithLimit', () => {
  it('returns the body intact when under the cap', async () => {
    const body = await readBodyWithLimit(
      streamingRequest(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])])),
      10,
    )
    expect(Array.from(body)).toEqual([1, 2, 3])
  })

  it('accepts a body exactly at the cap', async () => {
    const body = await readBodyWithLimit(
      streamingRequest(streamOf([new Uint8Array(4), new Uint8Array(4)])),
      8,
    )
    expect(body.byteLength).toBe(8)
  })

  it('aborts a chunked body without content-length once over the cap', async () => {
    const cancel = vi.fn()
    let pulls = 0
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(4))
    const request = streamingRequest(streamOf(chunks, cancel, () => pulls++))
    expect(request.headers.get('content-length')).toBeNull()
    await expect(readBodyWithLimit(request, 10)).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(cancel).toHaveBeenCalled()
    // Stopped after the chunk that crossed the cap, not after reading all 100
    expect(pulls).toBeLessThan(10)
  })

  it('aborts when content-length understates the real body', async () => {
    const request = streamingRequest(
      streamOf([new Uint8Array(6), new Uint8Array(6)]),
      { 'content-length': '2' },
    )
    await expect(readBodyWithLimit(request, 8)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('rejects up front when content-length exceeds the cap', async () => {
    const pull = vi.fn()
    const request = streamingRequest(streamOf([new Uint8Array(1)], undefined, pull), {
      'content-length': '9999',
    })
    await expect(readBodyWithLimit(request, 8)).rejects.toBeInstanceOf(BodyTooLargeError)
  })
})

describe('createAuthProxyHandler', () => {
  const okFetch = () =>
    vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }))

  it('forwards to the Convex site with sanitized forwarding headers', async () => {
    const fetchImpl = okFetch()
    const handler = createAuthProxyHandler({
      convexSiteUrl: 'https://site.wepaint.ai/',
      fetchImpl,
    })
    const response = await handler(
      new Request('http://127.0.0.1:3000/api/auth/get-session?x=1', {
        headers: {
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'https',
          'x-better-auth-forwarded-host': 'attacker.example',
          cookie: 'a=b',
        },
      }),
    )
    expect(response.status).toBe(200)
    const [target, init] = fetchImpl.mock.calls[0]!
    expect(target).toBe('https://site.wepaint.ai/api/auth/get-session?x=1')
    const headers = new Headers(init!.headers)
    expect(headers.get('host')).toBe('site.wepaint.ai')
    expect(headers.get('x-forwarded-host')).toBe('127.0.0.1:3000')
    expect(headers.get('x-better-auth-forwarded-host')).toBe('127.0.0.1:3000')
    expect(headers.get('x-forwarded-proto')).toBe('http')
    expect(headers.get('x-better-auth-forwarded-proto')).toBe('http')
    expect(headers.get('cookie')).toBe('a=b')
    expect(init!.redirect).toBe('manual')
    expect(init!.body).toBeUndefined()
  })

  it('forwards an allowlisted host', async () => {
    const fetchImpl = okFetch()
    const handler = createAuthProxyHandler({ convexSiteUrl: 'https://site.wepaint.ai', fetchImpl })
    await handler(
      new Request('http://127.0.0.1:3000/api/auth/get-session', {
        headers: { 'x-forwarded-host': 'app.wepaint.ai', 'x-forwarded-proto': 'https' },
      }),
    )
    const headers = new Headers(fetchImpl.mock.calls[0]![1]!.headers)
    expect(headers.get('x-better-auth-forwarded-host')).toBe('app.wepaint.ai')
    expect(headers.get('x-better-auth-forwarded-proto')).toBe('https')
  })

  it('buffers POST bodies under the cap', async () => {
    const fetchImpl = okFetch()
    const handler = createAuthProxyHandler({ convexSiteUrl: 'https://site.wepaint.ai', fetchImpl })
    await handler(
      new Request('http://app.wepaint.ai/api/auth/sign-in/social', {
        method: 'POST',
        body: JSON.stringify({ provider: 'google' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    const init = fetchImpl.mock.calls[0]![1]!
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"provider":"google"}')
    expect(new Headers(init.headers).get('content-length')).toBeNull()
  })

  it('returns 413 for an oversized chunked body without calling upstream', async () => {
    const fetchImpl = okFetch()
    const handler = createAuthProxyHandler({
      convexSiteUrl: 'https://site.wepaint.ai',
      fetchImpl,
      maxBodyBytes: 16,
    })
    const response = await handler(
      streamingRequest(streamOf(Array.from({ length: 10 }, () => new Uint8Array(8)))),
    )
    expect(response.status).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns 413 for an oversized content-length', async () => {
    const fetchImpl = okFetch()
    const handler = createAuthProxyHandler({
      convexSiteUrl: 'https://site.wepaint.ai',
      fetchImpl,
      maxBodyBytes: 16,
    })
    const response = await handler(
      new Request('http://app.wepaint.ai/api/auth/sign-in/social', {
        method: 'POST',
        body: 'x'.repeat(32),
      }),
    )
    expect(response.status).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
