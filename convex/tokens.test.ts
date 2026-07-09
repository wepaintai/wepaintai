import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { describe, expect, test } from 'vitest'
import { internal } from './_generated/api'
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

  test('rejects invalid purchase credits and balance overflow', async () => {
    const { t, userId } = await seedUser(3)

    for (const tokens of [-1, 0, 1.5, Number.NaN]) {
      await expect(
        t.mutation(internal.tokens.creditTokensFromPurchase, {
          userId,
          tokens,
          polarCheckoutId: `invalid-${String(tokens)}`,
          polarProductId: 'test-product',
          description: 'Invalid purchase',
        })
      ).rejects.toThrow('Purchase tokens must be a positive integer')
    }

    await expect(
      t.mutation(internal.tokens.creditTokensFromPurchase, {
        userId,
        tokens: Number.MAX_SAFE_INTEGER,
        polarCheckoutId: 'overflow',
        polarProductId: 'test-product',
        description: 'Overflow purchase',
      })
    ).rejects.toThrow('Token balance must be a non-negative safe integer')

    const user = await t.run(async (ctx) => await ctx.db.get(userId))
    expect(user?.tokens).toBe(3)
  })

  test('credits a purchase checkout at most once', async () => {
    const { t, userId } = await seedUser(3)
    const purchase = {
      userId,
      tokens: 5,
      polarCheckoutId: 'checkout-once',
      polarProductId: 'test-product',
      description: 'Five token purchase',
    }

    await Promise.all([
      t.mutation(internal.tokens.creditTokensFromPurchase, purchase),
      t.mutation(internal.tokens.creditTokensFromPurchase, purchase),
    ])

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      transactions: await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    }))

    expect(state.user?.tokens).toBe(8)
    expect(state.transactions).toHaveLength(1)
    expect(state.transactions[0]).toMatchObject({
      type: 'purchase',
      amount: 5,
      balance: 8,
    })
  })
})
