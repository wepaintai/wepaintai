import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import { MAX_PROMPT_LENGTH } from './tokenPolicy'
import { modules } from './test.setup'

const OWNER = 'owner-auth'
const COLLABORATOR = 'collab-auth'
const IMAGE = `data:image/png;base64,${btoa('P'.repeat(300))}`
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

async function seed(options: { ownerTokens?: number; isPublic?: boolean } = {}) {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      authId: OWNER,
      email: 'owner@example.com',
      tokens: options.ownerTokens ?? 1,
      lifetimeTokensUsed: 0,
    })
    const collaboratorId = await ctx.db.insert('users', {
      authId: COLLABORATOR,
      email: 'collab@example.com',
      tokens: 1,
      lifetimeTokensUsed: 0,
    })
    const sessionId = await ctx.db.insert('paintingSessions', {
      createdBy: ownerId,
      isPublic: options.isPublic ?? false,
      canvasWidth: 800,
      canvasHeight: 600,
      strokeCounter: 0,
    })
    const layerId = await ctx.db.insert('aiGeneratedImages', {
      sessionId,
      imageUrl: 'https://example.com/layer.png',
      width: 10,
      height: 10,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: 1,
      createdAt: Date.now(),
    })
    return { ownerId, collaboratorId, sessionId, layerId }
  })
  return {
    t,
    ...ids,
    asOwner: t.withIdentity({ subject: OWNER }),
    asCollaborator: t.withIdentity({ subject: COLLABORATOR }),
  }
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

/**
 * Route mocked fetches: Replicate create / poll / cancel and result downloads.
 * `poll` receives the 0-based poll attempt.
 */
function mockReplicate(opts: {
  create?: Handler
  poll?: (attempt: number) => Response | Promise<Response>
  download?: Handler
}) {
  const calls = { create: 0, poll: 0, cancel: [] as string[], download: 0 }
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/cancel')) {
      calls.cancel.push(url)
      return new Response('{}', { status: 200 })
    }
    if (url === 'https://api.replicate.com/v1/predictions' && init?.method === 'POST') {
      calls.create += 1
      return opts.create
        ? opts.create(url, init)
        : new Response(JSON.stringify({ id: 'pred-1', status: 'starting' }), { status: 201 })
    }
    if (url.startsWith('https://api.replicate.com/v1/predictions/')) {
      const attempt = calls.poll++
      if (!opts.poll) throw new Error('unexpected poll')
      return opts.poll(attempt)
    }
    calls.download += 1
    return opts.download
      ? opts.download(url, init)
      : new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Backend = Awaited<ReturnType<typeof seed>>['t']

async function balance(t: Backend, authId: string) {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_auth_id', (q) => q.eq('authId', authId))
      .first()
    return user?.tokens
  })
}

async function allRows(t: Backend) {
  return await t.run(async (ctx) => ({
    generations: await ctx.db.query('aiGenerations').collect(),
    merges: await ctx.db.query('imageMerges').collect(),
    removals: await ctx.db.query('backgroundRemovals').collect(),
  }))
}

beforeEach(() => {
  vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')
  vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')
  vi.stubEnv('REPLICATE_POLL_INTERVAL_MS', '5')
  vi.stubEnv('REPLICATE_TIMEOUT_SECONDS', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Replicate polling and billing after acceptance', () => {
  test('transient poll errors are retried with backoff instead of failing the operation', async () => {
    const { t, sessionId, asOwner } = await seed()
    const { calls } = mockReplicate({
      poll: (attempt) => {
        if (attempt === 0) return new Response('bad gateway', { status: 502 })
        if (attempt === 1) throw new TypeError('network blip')
        if (attempt === 2) return new Response('slow down', { status: 429 })
        if (attempt === 3) return json({ status: 'processing' })
        return json({ status: 'succeeded', output: ['https://replicate.delivery/out.png'] })
      },
    })

    const result = await asOwner.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(result.success).toBe(true)
    expect(calls.poll).toBe(5)
    expect(calls.cancel).toEqual([])
    expect(await balance(t, OWNER)).toBe(0)

    const { generations } = await allRows(t)
    expect(generations).toHaveLength(1)
    expect(generations[0]).toMatchObject({ status: 'completed', replicateId: 'pred-1' })
    const feed = await asOwner.query(api.aiGeneration.getSessionGenerations, { sessionId })
    expect(feed).toHaveLength(1)
  })

  test('a prediction that fails after acceptance is failed_billed and not refunded', async () => {
    const { t, sessionId, asOwner } = await seed()
    mockReplicate({ poll: () => json({ status: 'failed', error: 'model crashed' }) })

    const result = await asOwner.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('model crashed')
    expect(result.error).toContain('not refunded')
    expect(await balance(t, OWNER)).toBe(0)
    expect((await allRows(t)).generations[0].status).toBe('failed_billed')
  })

  test('timeout cancels the Replicate prediction, marks failed_billed, and does not refund', async () => {
    const { t, sessionId, asOwner } = await seed()
    const { calls } = mockReplicate({ poll: () => json({ status: 'processing' }) })

    const result = await asOwner.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
    expect(calls.cancel).toEqual(['https://api.replicate.com/v1/predictions/pred-1/cancel'])
    expect(await balance(t, OWNER)).toBe(0)
    expect((await allRows(t)).generations[0]).toMatchObject({
      status: 'failed_billed',
      replicateId: 'pred-1',
    })
  })

  test('status checks that keep failing until the deadline cancel and bill (no refund)', async () => {
    const { t, sessionId, asOwner } = await seed()
    const { calls } = mockReplicate({ poll: () => new Response('unavailable', { status: 503 }) })

    const result = await asOwner.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: (await t.run((ctx) => ctx.db.query('aiGeneratedImages').first()))!._id,
      secondLayerId: (await t.run((ctx) => ctx.db.query('aiGeneratedImages').first()))!._id,
      mergeMode: 'full',
    })
    expect(result.success).toBe(false)
    expect(calls.poll).toBeGreaterThan(1)
    expect(calls.cancel).toHaveLength(1)
    expect(await balance(t, OWNER)).toBe(0)
    expect((await allRows(t)).merges[0].status).toBe('failed_billed')
  })

  test('a non-retryable status-check error cancels and bills immediately', async () => {
    const { t, sessionId, asOwner } = await seed()
    const { calls } = mockReplicate({ poll: () => new Response('nope', { status: 401 }) })

    const result = await asOwner.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(result.success).toBe(false)
    expect(calls.poll).toBe(1)
    expect(calls.cancel).toHaveLength(1)
    expect(await balance(t, OWNER)).toBe(0)
  })

  test('a generated image that cannot be downloaded/stored is failed_billed, never an expiring URL', async () => {
    const { t, sessionId, asOwner } = await seed()
    mockReplicate({
      poll: () => json({ status: 'succeeded', output: 'https://replicate.delivery/out.png' }),
      download: () => new Response('gone', { status: 410 }),
    })

    const result = await asOwner.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to save')
    expect(result.error).toContain('not refunded')
    expect(await balance(t, OWNER)).toBe(0)
    const row = (await allRows(t)).generations[0]
    expect(row.status).toBe('failed_billed')
    expect(row.resultImageUrl).toBeUndefined()
  })

  test('background removal canceled after acceptance is failed_billed (no refund)', async () => {
    const { t, sessionId, asOwner } = await seed()
    mockReplicate({ poll: () => json({ status: 'canceled' }) })

    await expect(
      asOwner.action(api.backgroundRemoval.removeBackground, { sessionId, imageData: IMAGE })
    ).rejects.toThrow('not refunded')
    expect(await balance(t, OWNER)).toBe(0)
    expect((await allRows(t)).removals[0]).toMatchObject({
      status: 'failed_billed',
      replicateId: 'pred-1',
    })
  })

  test('background removal that succeeds upstream but cannot be stored is failed_billed', async () => {
    const { t, sessionId, asOwner } = await seed()
    mockReplicate({
      poll: () => json({ status: 'succeeded', output: 'https://replicate.delivery/bg.png' }),
      download: () => new Response('gone', { status: 404 }),
    })

    await expect(
      asOwner.action(api.backgroundRemoval.removeBackground, { sessionId, imageData: IMAGE })
    ).rejects.toThrow('not refunded')
    expect(await balance(t, OWNER)).toBe(0)
    expect((await allRows(t)).removals[0].status).toBe('failed_billed')
  })

  test('background removal success records a completed operation row', async () => {
    const { t, sessionId, asOwner } = await seed()
    mockReplicate({
      poll: () => json({ status: 'succeeded', output: 'https://replicate.delivery/bg.png' }),
    })

    const result = await asOwner.action(api.backgroundRemoval.removeBackground, {
      sessionId,
      imageData: IMAGE,
    })
    expect(result.success).toBe(true)
    const { removals } = await allRows(t)
    expect(removals[0]).toMatchObject({ status: 'completed', userId: OWNER })
    // The usage debit is keyed by the operation row id
    const tx = await t.run((ctx) => ctx.db.query('tokenTransactions').collect())
    expect(tx[0].operationKey).toBe(`background-removal:${removals[0]._id}`)
  })
})

describe('Gemini billing', () => {
  test('the row is marked in flight before the Gemini call (stale sweeps treat it as billed)', async () => {
    const { t, sessionId, asOwner } = await seed()
    let statusDuringCall: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        statusDuringCall = (await allRows(t)).generations[0]?.status
        return new Response('overloaded', { status: 503 })
      })
    )
    const result = await asOwner.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(statusDuringCall).toBe('processing')
    // An explicit rejection is still refunded
    expect(result.error).toContain('refunded')
    expect(await balance(t, OWNER)).toBe(1)
    expect((await allRows(t)).generations[0].status).toBe('failed')
  })

  test('a 200 response without an image is failed_billed (no free text-only calls)', async () => {
    const { t, sessionId, asOwner } = await seed()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ candidates: [{ content: { parts: [{ text: 'Here is a poem instead.' }] } }] })
      )
    )

    const result = await asOwner.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'write me a poem',
      imageData: IMAGE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('did not return an image')
    expect(result.error).toContain('not refunded')
    expect(await balance(t, OWNER)).toBe(0)
    expect((await allRows(t)).generations[0]).toMatchObject({
      status: 'failed_billed',
      provider: 'gemini',
    })
  })
})

describe('operation creation guards', () => {
  test('a 0-token user cannot create operation rows or reach any provider', async () => {
    const { t, sessionId, layerId, asOwner } = await seed({ ownerTokens: 0 })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < 3; i++) {
      const rep = await asOwner.action(api.aiGeneration.generateImage, {
        sessionId,
        prompt: 'x',
        imageData: IMAGE,
      })
      expect(rep.error).toContain('Insufficient tokens')
      const gem = await asOwner.action(api.geminiGeneration.generateImage, {
        sessionId,
        prompt: 'x',
        imageData: IMAGE,
      })
      expect(gem.error).toContain('Insufficient tokens')
      const merge = await asOwner.action(api.imageMerger.mergeImages, {
        sessionId,
        firstLayerId: layerId,
        secondLayerId: layerId,
        mergeMode: 'full',
      })
      expect(merge.error).toContain('Insufficient tokens')
      await expect(
        asOwner.action(api.backgroundRemoval.removeBackground, { sessionId, imageData: IMAGE })
      ).rejects.toThrow('Insufficient tokens')
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await allRows(t)).toEqual({ generations: [], merges: [], removals: [] })
  })

  test('prompts longer than the server cap are rejected before any write or provider call', async () => {
    const { t, sessionId, asOwner } = await seed()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const longPrompt = 'p'.repeat(MAX_PROMPT_LENGTH + 1)

    for (const fn of [api.aiGeneration.generateImage, api.geminiGeneration.generateImage]) {
      const result = await asOwner.action(fn, { sessionId, prompt: longPrompt, imageData: IMAGE })
      expect(result.success).toBe(false)
      expect(result.error).toContain('too long')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await allRows(t)).generations).toEqual([])
    expect(await balance(t, OWNER)).toBe(1)

    // The internal reservation enforces the same cap, and allows exactly the cap
    const tooLong = await asOwner.mutation(internal.aiOperations.beginOperation, {
      sessionId,
      operation: { type: 'ai-generation', prompt: longPrompt, provider: 'replicate' },
    })
    expect(tooLong).toEqual({ status: 'prompt_too_long' })
    const atCap = await asOwner.mutation(internal.aiOperations.beginOperation, {
      sessionId,
      operation: {
        type: 'ai-generation',
        prompt: 'p'.repeat(MAX_PROMPT_LENGTH),
        provider: 'replicate',
      },
    })
    expect(atCap.status).toBe('ok')
  })
})

describe('result writes re-check session access', () => {
  test('a session deleted mid-generation never receives the result (and billing stays correct)', async () => {
    const { t, sessionId, asOwner } = await seed()
    mockReplicate({
      poll: async () => {
        await t.run(async (ctx) => ctx.db.patch(sessionId, { deletedAt: Date.now() }))
        return json({ status: 'succeeded', output: 'https://replicate.delivery/out.png' })
      },
    })

    const result = await asOwner.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'a cat',
      imageData: IMAGE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('no longer have access')
    const row = (await allRows(t)).generations[0]
    expect(row.status).toBe('failed_billed')
    expect(row.resultImageUrl).toBeUndefined()
    expect(await balance(t, OWNER)).toBe(0)

    // Even after the owner restores the session, the feed stays empty
    await t.run(async (ctx) => ctx.db.patch(sessionId, { deletedAt: undefined }))
    expect(await asOwner.query(api.aiGeneration.getSessionGenerations, { sessionId })).toEqual([])
  })

  test('a collaborator who loses access (session made private) does not land a merge result', async () => {
    const { t, sessionId, layerId, asCollaborator, asOwner } = await seed({ isPublic: true })
    mockReplicate({
      poll: async () => {
        await t.run(async (ctx) => ctx.db.patch(sessionId, { isPublic: false }))
        return json({ status: 'succeeded', output: 'https://replicate.delivery/merge.png' })
      },
    })

    const result = await asCollaborator.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: layerId,
      secondLayerId: layerId,
      mergeMode: 'full',
    })
    expect(result.success).toBe(false)
    const merge = (await allRows(t)).merges[0]
    expect(merge.status).toBe('failed_billed')
    expect(merge.resultImageUrl).toBeUndefined()
    expect(await balance(t, COLLABORATOR)).toBe(0)
    const ownerView = await asOwner.query(api.imageMerger.getSessionMerges, { sessionId })
    expect(ownerView.every((m) => m.resultImageUrl === undefined)).toBe(true)
  })
})
