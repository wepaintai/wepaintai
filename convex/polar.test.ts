import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { getPublicTokenPackages, getTokenPackage } from './polarPackages'
import schema from './schema'
import { modules } from './test.setup'

const identity = { subject: 'polar-auth-user-1' }

function createTestBackend() {
  return convexTest(schema, modules)
}

async function seedUser(
  t: ReturnType<typeof createTestBackend>,
  authId: string,
  email: string,
  tokens = 3
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('users', {
      authId,
      email,
      tokens,
      lifetimeTokensUsed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
}

function completedCheckout(
  userId: Id<'users'>,
  overrides: Partial<{
    checkoutId: string
    status: string
    productId: string
    amount: number
    currency: string
    externalCustomerId: string | null
  }> = {}
) {
  return {
    checkoutId: 'checkout-50',
    status: 'succeeded',
    productId: 'polar-product-50',
    amount: 499,
    currency: 'usd',
    externalCustomerId: String(userId),
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubEnv('POLAR_PRODUCT_ID_50', 'polar-product-50')
  vi.stubEnv('POLAR_PRODUCT_ID_125', 'polar-product-125')
  vi.stubEnv('POLAR_API_KEY', 'polar-api-key')
  vi.stubEnv('POLAR_API_BASE_URL', 'https://sandbox-api.polar.sh')
  vi.stubEnv('SITE_URL', 'https://wepaint.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('server-authoritative Polar token packages', () => {
  test('defines valid packages without exposing product IDs publicly', () => {
    expect(getTokenPackage('50_tokens')).toMatchObject({
      productId: 'polar-product-50',
      tokens: 50,
      amount: 499,
      currency: 'usd',
    })
    expect(getTokenPackage('125_tokens')).toMatchObject({
      productId: 'polar-product-125',
      tokens: 125,
      amount: 999,
      currency: 'usd',
    })

    const publicPackages = getPublicTokenPackages()
    expect(publicPackages).toHaveLength(2)
    expect(publicPackages[0]).not.toHaveProperty('productId')
    expect(publicPackages[0]).not.toHaveProperty('productIdEnvironmentVariable')
  })

  test('rejects unknown packages', async () => {
    expect(() => getTokenPackage('unknown_package')).toThrow('Unknown token package')

    const t = createTestBackend()
    await expect(
      t.action(api.polar.createCheckout, {
        packageKey: 'unknown_package',
      } as never)
    ).rejects.toThrow()
  })

  test('creates checkout and pending purchase from only the server mapping', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        products: ['polar-product-50'],
        external_customer_id: String(userId),
        customer_email: 'polar-test@example.com',
        allow_discount_codes: false,
        success_url: 'https://wepaint.test?purchase=success&checkout_id={CHECKOUT_ID}',
        return_url: 'https://wepaint.test?purchase=cancelled',
      })

      return new Response(
        JSON.stringify({
          id: 'checkout-50',
          url: 'https://sandbox.polar.sh/checkout/checkout-50',
          amount: 499,
          currency: 'usd',
          product_id: 'polar-product-50',
          external_customer_id: String(userId),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await t.withIdentity(identity).action(api.polar.createCheckout, {
      packageKey: '50_tokens',
    })

    expect(result).toEqual({
      checkoutId: 'checkout-50',
      checkoutUrl: 'https://sandbox.polar.sh/checkout/checkout-50',
    })
    expect(fetchMock).toHaveBeenCalledOnce()

    const purchase = await t.run(async (ctx) => {
      return await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique()
    })
    expect(purchase).toMatchObject({
      userId,
      packageKey: '50_tokens',
      productId: 'polar-product-50',
      amount: 499,
      currency: 'usd',
      tokens: 50,
      status: 'pending',
    })
  })

  test('rejects client-forged token quantities', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      t.withIdentity(identity).action(api.polar.createCheckout, {
        packageKey: '50_tokens',
        tokens: 1_000_000,
      } as never)
    ).rejects.toThrow()
    await expect(
      t.mutation(internal.polarWebhook.createPendingPurchase, {
        userId,
        checkoutId: 'forged-checkout',
        packageKey: '50_tokens',
        tokens: 1_000_000,
      } as never)
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('credits a valid completed checkout for its configured package', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    const result = await t.mutation(
      internal.polarWebhook.validateAndCompletePurchase,
      completedCheckout(userId)
    )

    expect(result).toEqual({ outcome: 'credited', newBalance: 53 })
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    }))
    expect(state.user?.tokens).toBe(53)
    expect(state.purchase?.status).toBe('completed')
    expect(state.transactions).toHaveLength(1)
    expect(state.transactions[0]).toMatchObject({
      type: 'purchase',
      amount: 50,
      balance: 53,
      metadata: {
        polarCheckoutId: 'checkout-50',
        polarProductId: 'polar-product-50',
      },
    })
  })

  test('rejects mismatched products, amounts, and currencies', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    const attempts = [
      { overrides: { productId: 'polar-product-125' }, reason: 'product' },
      { overrides: { amount: 1 }, reason: 'amount' },
      { overrides: { currency: 'eur' }, reason: 'currency' },
    ] as const

    for (const attempt of attempts) {
      await expect(
        t.mutation(
          internal.polarWebhook.validateAndCompletePurchase,
          completedCheckout(userId, attempt.overrides)
        )
      ).resolves.toEqual({ outcome: 'rejected', reason: attempt.reason })
    }

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(state.user?.tokens).toBe(3)
    expect(state.transactions).toHaveLength(0)
  })

  test('rejects forged persisted token quantities', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.run(async (ctx) => {
      await ctx.db.insert('polarPurchases', {
        userId,
        checkoutId: 'checkout-50',
        packageKey: '50_tokens',
        productId: 'polar-product-50',
        productName: '50 Token Pack',
        amount: 499,
        currency: 'usd',
        tokens: 1_000_000,
        status: 'pending',
        createdAt: Date.now(),
      })
    })

    await expect(
      t.mutation(internal.polarWebhook.validateAndCompletePurchase, completedCheckout(userId))
    ).resolves.toEqual({ outcome: 'rejected', reason: 'package' })

    const user = await t.run(async (ctx) => await ctx.db.get(userId))
    expect(user?.tokens).toBe(3)
  })

  test('rejects a purchase that would overflow the token balance', async () => {
    const t = createTestBackend()
    const userId = await seedUser(
      t,
      identity.subject,
      'polar-test@example.com',
      Number.MAX_SAFE_INTEGER - 10
    )
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    await expect(
      t.mutation(internal.polarWebhook.validateAndCompletePurchase, completedCheckout(userId))
    ).rejects.toThrow('Token balance must be a non-negative safe integer')

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(state.user?.tokens).toBe(Number.MAX_SAFE_INTEGER - 10)
    expect(state.purchase?.status).toBe('pending')
    expect(state.transactions).toHaveLength(0)
  })

  test('delivers duplicate checkout events exactly once', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    const [first, duplicate] = await Promise.all([
      t.mutation(internal.polarWebhook.validateAndCompletePurchase, completedCheckout(userId)),
      t.mutation(internal.polarWebhook.validateAndCompletePurchase, completedCheckout(userId)),
    ])

    expect([first.outcome, duplicate.outcome].sort()).toEqual(['credited', 'duplicate'])
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      transactions: await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    }))
    expect(state.user?.tokens).toBe(53)
    expect(state.transactions).toHaveLength(1)
  })

  test('rejects cross-user, unknown-checkout, and incomplete deliveries', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    const otherUserId = await seedUser(t, 'polar-auth-user-2', 'other-polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    await expect(
      t.mutation(
        internal.polarWebhook.validateAndCompletePurchase,
        completedCheckout(userId, {
          externalCustomerId: String(otherUserId),
        })
      )
    ).resolves.toEqual({ outcome: 'rejected', reason: 'user' })
    await expect(
      t.mutation(
        internal.polarWebhook.validateAndCompletePurchase,
        completedCheckout(userId, { checkoutId: 'unknown-checkout' })
      )
    ).resolves.toEqual({ outcome: 'rejected', reason: 'checkout' })
    await expect(
      t.mutation(
        internal.polarWebhook.validateAndCompletePurchase,
        completedCheckout(userId, { status: 'open' })
      )
    ).resolves.toEqual({ outcome: 'rejected', reason: 'status' })

    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      otherUser: await ctx.db.get(otherUserId),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(state.user?.tokens).toBe(3)
    expect(state.otherUser?.tokens).toBe(3)
    expect(state.transactions).toHaveLength(0)
  })
})
