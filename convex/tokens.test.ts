import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import schema from './schema'
import { TOKEN_COSTS, assertPositiveTokenAmount, assertValidTokenBalance } from './tokenPolicy'
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

  test('the server owns the price: every operation debits exactly TOKEN_COSTS and corrupt balances are refused', async () => {
    // Validator layer: an extra caller-supplied cost is not even accepted
    const { asUser: validatorUser } = await seedUser(3)
    await expect(
      validatorUser.mutation(internal.tokens.consumeTokensForOperation, {
        operationId: 'malicious-cost',
        operationType: 'background-removal',
        tokenCost: -1_000,
      } as never)
    ).rejects.toThrow()

    // Logic layer: each operation type debits the server price, nothing else
    for (const operationType of Object.keys(TOKEN_COSTS) as Array<keyof typeof TOKEN_COSTS>) {
      const { t, userId, asUser } = await seedUser(10)
      const operationId = await t.run(async (ctx) => {
        if (operationType === 'ai-generation') {
          return await ctx.db.insert('aiGenerations', {
            sessionId: await ctx.db.insert('paintingSessions', {
              isPublic: false,
              canvasWidth: 1,
              canvasHeight: 1,
              strokeCounter: 0,
            }),
            status: 'pending',
            createdAt: Date.now(),
          })
        }
        if (operationType === 'image-merge') {
          return await ctx.db.insert('imageMerges', {
            sessionId: await ctx.db.insert('paintingSessions', {
              isPublic: false,
              canvasWidth: 1,
              canvasHeight: 1,
              strokeCounter: 0,
            }),
            firstLayerId: 'a',
            secondLayerId: 'b',
            mergeMode: 'full',
            status: 'pending',
            createdAt: Date.now(),
          })
        }
        return 'bg-op'
      })
      const result = await asUser.mutation(internal.tokens.consumeTokensForOperation, {
        operationId,
        operationType,
      })
      expect(result).toEqual({ charged: true, newBalance: 10 - TOKEN_COSTS[operationType] })
      const tx = await t.run(async (ctx) =>
        ctx.db
          .query('tokenTransactions')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect()
      )
      expect(tx).toHaveLength(1)
      expect(tx[0].amount).toBe(-TOKEN_COSTS[operationType])
    }

    // A corrupt stored balance (fractional or negative) is never debited
    for (const corrupt of [1.5, -5]) {
      const { t, userId, asUser } = await seedUser(corrupt)
      await expect(
        asUser.mutation(internal.tokens.consumeTokensForOperation, {
          operationId: `corrupt-${corrupt}`,
          operationType: 'background-removal',
        })
      ).rejects.toThrow(/Token balance must be a non-negative safe integer|Insufficient tokens/)
      expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(corrupt)
    }

    // The policy guards themselves reject non-positive / non-integer amounts
    for (const bad of [-1_000, 0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => assertPositiveTokenAmount(bad)).toThrow()
    }
    expect(() => assertValidTokenBalance(-1)).toThrow()
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

  test('row-keyed refund: at most once, only with a matching debit, always to the row owner', async () => {
    const { t, userId, asUser } = await seedUser(2)
    const { generationId, outsiderId } = await t.run(async (ctx) => {
      const outsiderId = await ctx.db.insert('users', {
        authId: 'outsider-auth',
        email: 'outsider@example.com',
        tokens: 0,
      })
      const sessionId = await ctx.db.insert('paintingSessions', {
        createdBy: userId,
        isPublic: false,
        canvasWidth: 1,
        canvasHeight: 1,
        strokeCounter: 0,
      })
      const generationId = await ctx.db.insert('aiGenerations', {
        sessionId,
        userId: identity.subject,
        status: 'pending',
        createdAt: Date.now(),
      })
      return { generationId, outsiderId }
    })

    // Uncharged operation cannot mint a refund
    expect(
      await t.mutation(internal.aiOperations.refundOperation, {
        operationId: generationId,
        operationType: 'ai-generation',
      })
    ).toEqual({ refunded: false, newBalance: 2 })

    await asUser.mutation(internal.tokens.consumeTokensForOperation, {
      operationId: generationId,
      operationType: 'ai-generation',
    })

    // Another user's credentials neither redirect nor block the refund: the
    // user is derived from the stored row, so the outsider gains nothing.
    const asOutsider = t.withIdentity({ subject: 'outsider-auth' })
    const [firstRefund, secondRefund] = await Promise.all([
      asOutsider.mutation(internal.aiOperations.refundOperation, {
        operationId: generationId,
        operationType: 'ai-generation',
        reason: 'Provider failed',
      }),
      t.mutation(internal.aiOperations.refundOperation, {
        operationId: generationId,
        operationType: 'ai-generation',
        reason: 'Provider failed',
      }),
    ])
    expect([firstRefund.refunded, secondRefund.refunded].sort()).toEqual([false, true])

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      outsider: await ctx.db.get(outsiderId),
      transactions: await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    }))
    expect(state.user?.tokens).toBe(2)
    expect(state.user?.lifetimeTokensUsed).toBe(0)
    expect(state.outsider?.tokens).toBe(0)
    expect(state.transactions.map((tx) => tx.type)).toEqual(['usage', 'refund'])
    expect(state.transactions[1].operationKey).toBe(`refund:ai-generation:${generationId}`)

    // A row re-pointed at another user (who was never debited) refunds nothing
    await t.run(async (ctx) => ctx.db.patch(generationId, { userId: 'outsider-auth' }))
    await t.run(async (ctx) => {
      const refundRow = state.transactions[1]
      await ctx.db.delete(refundRow._id)
    })
    expect(
      await t.mutation(internal.aiOperations.refundOperation, {
        operationId: generationId,
        operationType: 'ai-generation',
      })
    ).toMatchObject({ refunded: false })
    expect((await t.run((ctx) => ctx.db.get(outsiderId)))?.tokens).toBe(0)
  })

  test('failOperation refunds first and atomically, is idempotent, and never touches terminal rows', async () => {
    const { t, userId, asUser } = await seedUser(3)
    const ids = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert('paintingSessions', {
        createdBy: userId,
        isPublic: false,
        canvasWidth: 1,
        canvasHeight: 1,
        strokeCounter: 0,
      })
      const mk = () =>
        ctx.db.insert('aiGenerations', {
          sessionId,
          userId: identity.subject,
          status: 'processing',
          createdAt: Date.now(),
        })
      return { refundable: await mk(), billed: await mk(), done: await mk() }
    })
    for (const operationId of Object.values(ids)) {
      await asUser.mutation(internal.tokens.consumeTokensForOperation, {
        operationId,
        operationType: 'ai-generation',
      })
    }
    await t.run(async (ctx) => ctx.db.patch(ids.done, { status: 'completed' }))

    const refund = await t.mutation(internal.aiOperations.failOperation, {
      operationType: 'ai-generation',
      operationId: ids.refundable,
      outcome: 'refund',
      error: 'rejected',
    })
    expect(refund).toEqual({ status: 'failed', refunded: true })
    // Second settle of the same row is a no-op (no double refund)
    expect(
      await t.mutation(internal.aiOperations.failOperation, {
        operationType: 'ai-generation',
        operationId: ids.refundable,
        outcome: 'refund',
        error: 'again',
      })
    ).toEqual({ status: 'already_terminal', refunded: false })

    expect(
      await t.mutation(internal.aiOperations.failOperation, {
        operationType: 'ai-generation',
        operationId: ids.billed,
        outcome: 'billed',
        error: 'timed out',
      })
    ).toEqual({ status: 'failed_billed', refunded: false })

    // A completed row can never be failed or refunded afterwards
    expect(
      await t.mutation(internal.aiOperations.failOperation, {
        operationType: 'ai-generation',
        operationId: ids.done,
        outcome: 'refund',
        error: 'stale sweep',
      })
    ).toEqual({ status: 'already_terminal', refunded: false })

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      rows: await Promise.all([ids.refundable, ids.billed, ids.done].map((id) => ctx.db.get(id))),
    }))
    expect(state.user?.tokens).toBe(1) // 3 - 3 debits + 1 refund
    expect(state.rows.map((r) => r?.status)).toEqual(['failed', 'failed_billed', 'completed'])
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

  test('refunds when the provider never accepted the request (Replicate 500, Gemini 429, missing merge layers)', async () => {
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

    // 1. Replicate HTTP 500 on create refunds reserved token
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
    expect(repFailed.error).toContain('refunded')
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    // 2. Gemini 429 refunds reserved token and passes API key in header (not URL)
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

    // 3. Gemini network error before acceptance refunds
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    const gemNetwork = await asUser.action(api.geminiGeneration.generateImage, {
      sessionId,
      prompt: 'test',
      imageData: `data:image/png;base64,${validBase64Png}`,
    })
    expect(gemNetwork.success).toBe(false)
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    // 4. Background removal rejected at create refunds
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad input', { status: 422 })))
    await expect(
      asUser.action(api.backgroundRemoval.removeBackground, {
        sessionId,
        imageData: `data:image/png;base64,${validBase64Png}`,
      })
    ).rejects.toThrow('refunded')
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    // 5. Image merge failure before the provider refunds reserved token
    const mergeFailed = await asUser.action(api.imageMerger.mergeImages, {
      sessionId,
      firstLayerId: 'missing-1',
      secondLayerId: 'missing-2',
      mergeMode: 'full',
    })
    expect(mergeFailed.success).toBe(false)
    expect((await t.run((ctx) => ctx.db.get(userId)))?.tokens).toBe(1)

    const statuses = await t.run(async (ctx) => [
      ...(await ctx.db.query('aiGenerations').collect()).map((r) => r.status),
      ...(await ctx.db.query('backgroundRemovals').collect()).map((r) => r.status),
      ...(await ctx.db.query('imageMerges').collect()).map((r) => r.status),
    ])
    expect(statuses).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
  })
})
