import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import { modules } from './test.setup'

const identity = { subject: 'auth-user-1' }

function createTestBackend() {
  return convexTest(schema, modules)
}

async function seedUser(tokens: number) {
  const t = createTestBackend()
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert('users', {
      authId: identity.subject,
      email: 'token-test@example.com',
      tokens,
      lifetimeTokensUsed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
  return { t, userId, asUser: t.withIdentity(identity) }
}

describe('token billing policy', () => {
  test('the legacy public debit endpoint no longer exists', async () => {
    const { t, userId, asUser } = await seedUser(3)
    const legacyDebit = makeFunctionReference<'mutation'>('tokens:useTokens')

    await expect(
      asUser.mutation(legacyDebit, {
        tokenCost: -1_000,
        description: 'mint tokens',
      })
    ).rejects.toThrow()

    const user = await t.run(async (ctx) => await ctx.db.get(userId))
    expect(user?.tokens).toBe(3)
  })

  test('rejects caller-supplied costs on the internal operation API', async () => {
    const { t, userId, asUser } = await seedUser(3)

    for (const tokenCost of [-1_000, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(
        asUser.mutation(internal.tokens.consumeTokensForOperation, {
          operationId: `malicious-cost-${tokenCost}`,
          operationType: 'background-removal',
          tokenCost,
        } as never)
      ).rejects.toThrow()
    }

    const user = await t.run(async (ctx) => await ctx.db.get(userId))
    expect(user?.tokens).toBe(3)
  })

  test('charges the fixed server price exactly once for duplicate requests', async () => {
    const { t, userId, asUser } = await seedUser(3)
    const args = {
      operationId: 'background-removal-1',
      operationType: 'background-removal' as const,
    }

    const [first, duplicate] = await Promise.all([
      asUser.mutation(internal.tokens.consumeTokensForOperation, args),
      asUser.mutation(internal.tokens.consumeTokensForOperation, args),
    ])

    expect([first.charged, duplicate.charged].sort()).toEqual([false, true])

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      transactions: await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user_operation', (q) => q.eq('userId', userId))
        .collect(),
    }))

    expect(state.user?.tokens).toBe(2)
    expect(state.user?.lifetimeTokensUsed).toBe(1)
    expect(state.transactions).toHaveLength(1)
    expect(state.transactions[0]).toMatchObject({
      operationKey: 'background-removal:background-removal-1',
      amount: -1,
      balance: 2,
      type: 'usage',
    })
  })

  test('requires authentication and enforces insufficient balance', async () => {
    const unauthenticated = createTestBackend()
    await expect(
      unauthenticated.mutation(internal.tokens.consumeTokensForOperation, {
        operationId: 'anonymous-operation',
        operationType: 'ai-generation',
      })
    ).rejects.toThrow('Not authenticated')

    const { asUser } = await seedUser(0)
    await expect(
      asUser.mutation(internal.tokens.consumeTokensForOperation, {
        operationId: 'no-balance',
        operationType: 'background-removal',
      })
    ).rejects.toThrow('Insufficient tokens')
  })

  test('refunds a charged operation at most once and ignores uncharged refunds', async () => {
    const { t, userId, asUser } = await seedUser(2)

    // Uncharged operation cannot mint a refund
    const uncharged = await asUser.mutation(internal.tokens.refundTokensForOperation, {
      operationId: 'never-charged',
      operationType: 'background-removal',
    })
    expect(uncharged).toEqual({ newBalance: 2, refunded: false })

    await asUser.mutation(internal.tokens.consumeTokensForOperation, {
      operationId: 'bg-op-1',
      operationType: 'background-removal',
    })

    const [firstRefund, secondRefund] = await Promise.all([
      asUser.mutation(internal.tokens.refundTokensForOperation, {
        operationId: 'bg-op-1',
        operationType: 'background-removal',
        reason: 'Provider failed',
      }),
      asUser.mutation(internal.tokens.refundTokensForOperation, {
        operationId: 'bg-op-1',
        operationType: 'background-removal',
        reason: 'Provider failed',
      }),
    ])
    expect([firstRefund.refunded, secondRefund.refunded].sort()).toEqual([false, true])

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      transactions: await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    }))
    expect(state.user?.tokens).toBe(2)
    expect(state.user?.lifetimeTokensUsed).toBe(0)
    expect(state.transactions.map((tx) => tx.type)).toEqual(['usage', 'refund'])
  })
})

describe('AUD-006 atomic pre-provider AI token reservation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('a 1-token balance cannot launch two concurrent AI generations', async () => {
    const { t, userId, asUser } = await seedUser(1)
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert('paintingSessions', {
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
    )

    let providerCalls = 0
    const tinyPngBase64 = btoa('PNGDATA12345')
    const fetchMock = vi.fn(async () => {
      providerCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 15))
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: tinyPngBase64 } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const validBase64Png = btoa('A'.repeat(120))
    const args = {
      sessionId,
      prompt: 'neon city',
      imageData: `data:image/png;base64,${validBase64Png}`,
    }

    const [first, second] = await Promise.all([
      asUser.action(api.geminiGeneration.generateImage, args),
      asUser.action(api.geminiGeneration.generateImage, args),
    ])

    expect(providerCalls).toBe(1)
    expect([first.success, second.success].sort()).toEqual([false, true])
    const failed = first.success ? second : first
    expect(failed.error).toContain('Insufficient tokens')

    const user = await t.run(async (ctx) => await ctx.db.get(userId))
    expect(user?.tokens).toBe(0)
    expect(user?.lifetimeTokensUsed).toBe(1)
  })

  test('refunds reserved token on Replicate failure, Gemini failure, and canceled background removal', async () => {
    const { t, userId, asUser } = await seedUser(1)
    vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate-token')
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key')

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert('paintingSessions', {
        createdBy: userId,
        isPublic: false,
        canvasWidth: 800,
        canvasHeight: 600,
        strokeCounter: 0,
      })
    )
    const validBase64Png = btoa('B'.repeat(120))

    // 1. Replicate HTTP 500 refunds reserved token
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream error', { status: 500 }))
    )
    const repFailed = await asUser.action(api.aiGeneration.generateImage, {
      sessionId,
      prompt: 'test',
      imageData: `data:image/png;base64,${validBase64Png}`,
    })
    expect(repFailed.success).toBe(false)
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    // 2. Gemini failure refunds reserved token and passes API key in header (not URL)
    const geminiFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).not.toContain('key=')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-goog-api-key')).toBe('test-gemini-key')
      return new Response('quota exceeded', { status: 429 })
    })
    vi.stubGlobal('fetch', geminiFetch)
    const gemFailed = await asUser.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'test',
      imageData: `data:image/png;base64,${validBase64Png}`,
    })
    expect(gemFailed.success).toBe(false)
    expect(geminiFetch).toHaveBeenCalledOnce()
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    // 3. Canceled background removal refunds reserved token
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'pred-cancel' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'canceled' }), { status: 200 })
        )
    )
    await expect(
      asUser.action(api.backgroundRemoval.removeBackground, {
        sessionId,
        imageData: `data:image/png;base64,${validBase64Png}`,
      })
    ).rejects.toThrow('Background removal failed')
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    // 4. Image merge failure refunds reserved token
    const mergeFailed = await asUser.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: 'missing-1',
      secondLayerId: 'missing-2',
      mergeMode: 'full',
    })
    expect(mergeFailed.success).toBe(false)
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)
  })
})
