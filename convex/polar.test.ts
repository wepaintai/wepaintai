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

const webhookSecret = 'polar-webhook-secret'

function checkoutUpdatedEvent(
  userId: Id<'users'>,
  overrides: Partial<{
    checkoutId: string
    status: string
    productId: string | null
    amount: number
    currency: string
    externalCustomerId: string | null
  }> = {},
  type: 'checkout.updated' | 'checkout.expired' = 'checkout.updated'
) {
  const now = new Date().toISOString()
  const checkout = {
    checkoutId: 'checkout-50',
    status: 'succeeded',
    productId: 'polar-product-50' as string | null,
    amount: 499,
    currency: 'usd',
    externalCustomerId: String(userId) as string | null,
    ...overrides,
  }

  return {
    type,
    timestamp: now,
    data: {
      id: checkout.checkoutId,
      created_at: now,
      modified_at: null,
      custom_field_data: {},
      payment_processor: 'stripe',
      status: checkout.status,
      client_secret: 'checkout-client-secret',
      url: 'https://sandbox.polar.sh/checkout/checkout-50',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      success_url: 'https://wepaint.test?purchase=success',
      return_url: 'https://wepaint.test?purchase=cancelled',
      embed_origin: null,
      amount: checkout.amount,
      discount_amount: 0,
      net_amount: checkout.amount,
      tax_amount: 0,
      tax_behavior: 'inclusive',
      total_amount: checkout.amount,
      currency: checkout.currency,
      allow_trial: false,
      active_trial_interval: null,
      active_trial_interval_count: null,
      trial_end: null,
      organization_id: 'polar-organization',
      product_id: checkout.productId,
      product_price_id: null,
      discount_id: null,
      allow_discount_codes: false,
      require_billing_address: false,
      is_discount_applicable: true,
      is_free_product_price: false,
      is_payment_required: true,
      is_payment_setup_required: false,
      is_payment_form_required: true,
      customer_id: null,
      is_business_customer: false,
      customer_name: null,
      customer_email: 'polar-test@example.com',
      customer_ip_address: null,
      customer_billing_name: null,
      customer_billing_address: null,
      customer_tax_id: null,
      payment_processor_metadata: {},
      billing_address_fields: {
        country: 'required',
        state: 'optional',
        city: 'optional',
        postal_code: 'required',
        line1: 'optional',
        line2: 'optional',
      },
      trial_interval: null,
      trial_interval_count: null,
      metadata: {},
      external_customer_id: checkout.externalCustomerId,
      products: [],
      product: null,
      product_price: null,
      prices: null,
      discount: null,
      subscription_id: null,
      attached_custom_fields: [],
      customer_metadata: {},
    },
  }
}

async function createWebhookHeaders(
  body: string,
  options: {
    secret?: string
    timestamp?: Date
    webhookId?: string
  } = {}
) {
  const secret = options.secret ?? webhookSecret
  const timestamp = options.timestamp ?? new Date()
  const webhookId = options.webhookId ?? 'polar-delivery-1'
  const timestampSeconds = Math.floor(timestamp.getTime() / 1000).toString()
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${webhookId}.${timestampSeconds}.${body}`)
  )
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))

  return {
    'content-type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': timestampSeconds,
    'webhook-signature': `v1,${encodedSignature}`,
  }
}

async function deliverWebhook(
  t: ReturnType<typeof createTestBackend>,
  event: unknown,
  options: Parameters<typeof createWebhookHeaders>[1] = {}
) {
  const body = typeof event === 'string' ? event : JSON.stringify(event)
  return await t.fetch('/webhooks/polar', {
    method: 'POST',
    headers: await createWebhookHeaders(body, options),
    body,
  })
}

beforeEach(() => {
  vi.stubEnv('POLAR_PRODUCT_ID_50', 'polar-product-50')
  vi.stubEnv('POLAR_PRODUCT_ID_125', 'polar-product-125')
  vi.stubEnv('POLAR_API_KEY', 'polar-api-key')
  vi.stubEnv('POLAR_WEBHOOK_SECRET', webhookSecret)
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
    await expect(
      t.mutation(
        internal.polarWebhook.validateAndCompletePurchase,
        completedCheckout(userId, { status: 'confirmed' })
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

describe('Polar webhook security and delivery handling', () => {
  test('fails closed when the webhook secret is missing', async () => {
    const t = createTestBackend()
    vi.stubEnv('POLAR_WEBHOOK_SECRET', undefined)

    const response = await t.fetch('/webhooks/polar', {
      method: 'POST',
      headers: {
        'webhook-id': 'missing-secret-delivery',
        'webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
        'webhook-signature': 'v1,empty-secret-signature',
      },
      body: '{}',
    })

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  })

  test('rejects invalid signatures without logging sensitive request data', async () => {
    const t = createTestBackend()
    const body = JSON.stringify({ private: 'full-payload-marker' })
    const headers = await createWebhookHeaders(body, { secret: 'wrong-webhook-secret' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await t.fetch('/webhooks/polar', {
      method: 'POST',
      headers: {
        ...headers,
        authorization: 'Bearer private-authorization-marker',
      },
      body,
    })

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
    expect(logged).not.toContain('full-payload-marker')
    expect(logged).not.toContain('private-authorization-marker')
    expect(logged).not.toContain(headers['webhook-signature'])
    expect(logged).not.toContain(webhookSecret)
  })

  test('rejects an expired signed delivery before processing it', async () => {
    const t = createTestBackend()
    const response = await deliverWebhook(t, '{"not":"processed"}', {
      timestamp: new Date(Date.now() - 301_000),
    })

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  })

  test('returns a generic bad request for a signed malformed event', async () => {
    const t = createTestBackend()
    const response = await deliverWebhook(t, {
      type: 'checkout.updated',
      timestamp: new Date().toISOString(),
      data: { id: 'malformed-checkout', private: 'do-not-return' },
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe('Bad Request')
  })

  test('completes and credits a valid signed checkout atomically', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    const response = await deliverWebhook(t, checkoutUpdatedEvent(userId))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(state.user?.tokens).toBe(53)
    expect(state.purchase?.status).toBe('completed')
    expect(state.transactions).toHaveLength(1)
  })

  test('treats duplicate signed deliveries idempotently', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    const event = checkoutUpdatedEvent(userId)

    const first = await deliverWebhook(t, event)
    const duplicate = await deliverWebhook(t, event)

    expect(first.status).toBe(200)
    expect(duplicate.status).toBe(200)
    const state = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(state.user?.tokens).toBe(53)
    expect(state.transactions).toHaveLength(1)
  })

  test('leaves a purchase pending after transient processing failure and succeeds on retry', async () => {
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
    const event = checkoutUpdatedEvent(userId)

    const failed = await deliverWebhook(t, event)
    expect(failed.status).toBe(500)
    const afterFailure = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(afterFailure.user?.tokens).toBe(Number.MAX_SAFE_INTEGER - 10)
    expect(afterFailure.purchase?.status).toBe('pending')
    expect(afterFailure.transactions).toHaveLength(0)

    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { tokens: 3 })
    })
    const retried = await deliverWebhook(t, event)

    expect(retried.status).toBe(200)
    const afterRetry = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(afterRetry.user?.tokens).toBe(53)
    expect(afterRetry.purchase?.status).toBe('completed')
    expect(afterRetry.transactions).toHaveLength(1)
  })

  test('does not credit unsettled confirmed checkouts and marks failed checkouts failed', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    const confirmed = await deliverWebhook(t, checkoutUpdatedEvent(userId, { status: 'confirmed' }))
    expect(confirmed.status).toBe(200)

    const afterConfirmed = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(afterConfirmed.user?.tokens).toBe(3)
    expect(afterConfirmed.purchase?.status).toBe('pending')
    expect(afterConfirmed.transactions).toHaveLength(0)

    const failed = await deliverWebhook(t, checkoutUpdatedEvent(userId, { status: 'failed' }))
    expect(failed.status).toBe(200)

    const afterFailed = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      purchase: await ctx.db
        .query('polarPurchases')
        .withIndex('by_checkout', (q) => q.eq('checkoutId', 'checkout-50'))
        .unique(),
      transactions: await ctx.db.query('tokenTransactions').collect(),
    }))
    expect(afterFailed.user?.tokens).toBe(3)
    expect(afterFailed.purchase?.status).toBe('failed')
    expect(afterFailed.transactions).toHaveLength(0)

    expect(afterFailed.purchase?.failureReason).toBe('checkout_failed')
  })
})

function orderPaidEvent(
  userId: Id<'users'>,
  overrides: Partial<{
    checkoutId: string | null
    paid: boolean
    billingReason: string
  }> = {}
) {
  const now = new Date().toISOString()
  const order = {
    checkoutId: 'checkout-50' as string | null,
    paid: true,
    billingReason: 'purchase',
    ...overrides,
  }

  return {
    type: 'order.paid',
    timestamp: now,
    data: {
      id: 'order-50',
      created_at: now,
      modified_at: null,
      status: order.paid ? 'paid' : 'pending',
      paid: order.paid,
      subtotal_amount: 499,
      discount_amount: 0,
      net_amount: 499,
      tax_amount: 0,
      total_amount: 499,
      applied_balance_amount: 0,
      due_amount: 0,
      refunded_amount: 0,
      refunded_tax_amount: 0,
      currency: 'usd',
      billing_reason: order.billingReason,
      billing_name: null,
      billing_address: null,
      invoice_number: null,
      is_invoice_generated: false,
      receipt_number: null,
      customer_id: 'polar-customer',
      product_id: 'polar-product-50',
      discount_id: null,
      subscription_id: null,
      checkout_id: order.checkoutId,
      metadata: {},
      platform_fee_amount: 0,
      platform_fee_currency: null,
      customer: {
        id: 'polar-customer',
        created_at: now,
        modified_at: null,
        metadata: {},
        external_id: String(userId),
        email: 'polar-test@example.com',
        email_verified: true,
        type: 'individual',
        name: null,
        billing_address: null,
        tax_id: null,
        organization_id: 'polar-organization',
        deleted_at: null,
        avatar_url: 'https://example.com/avatar.png',
      },
      product: null,
      discount: null,
      subscription: null,
      items: [],
      description: '50 Token Pack',
      refundable_amount: 499,
      refundable_tax_amount: 0,
    },
  }
}

// Shape of `GET /v1/checkouts/{id}` (snake_case REST, not the SDK model).
function polarCheckoutResponse(
  userId: Id<'users'>,
  overrides: Partial<{
    id: string
    status: string
    product_id: string | null
    amount: number
    currency: string
    external_customer_id: string | null
  }> = {}
) {
  return {
    id: 'checkout-50',
    status: 'succeeded',
    product_id: 'polar-product-50',
    amount: 499,
    currency: 'usd',
    external_customer_id: String(userId),
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function checkoutIdFromUrl(input: string | URL | Request) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const match = /\/v1\/checkouts\/([^/?]+)$/.exec(url)
  if (!match) {
    throw new Error(`Unexpected Polar request: ${url}`)
  }
  return decodeURIComponent(match[1])
}

async function readPurchaseState(
  t: ReturnType<typeof createTestBackend>,
  userId: Id<'users'>,
  checkoutId = 'checkout-50'
) {
  return await t.run(async (ctx) => ({
    user: await ctx.db.get(userId),
    purchase: await ctx.db
      .query('polarPurchases')
      .withIndex('by_checkout', (q) => q.eq('checkoutId', checkoutId))
      .unique(),
    transactions: await ctx.db
      .query('tokenTransactions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
  }))
}

async function seedPendingPurchase(
  t: ReturnType<typeof createTestBackend>,
  userId: Id<'users'>,
  checkoutId: string,
  ageMs: number
) {
  await t.mutation(internal.polarWebhook.createPendingPurchase, {
    userId,
    checkoutId,
    packageKey: '50_tokens',
  })
  await t.run(async (ctx) => {
    const purchase = await ctx.db
      .query('polarPurchases')
      .withIndex('by_checkout', (q) => q.eq('checkoutId', checkoutId))
      .unique()
    if (!purchase) throw new Error('missing purchase')
    await ctx.db.patch(purchase._id, { createdAt: Date.now() - ageMs })
  })
}

function alertLines(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith('[POLAR-ALERT]'))
}

const MINUTE = 60 * 1000

describe('Polar out-of-order and terminal-state delivery', () => {
  test('a late failed or expired event never reverts a completed purchase', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    expect((await deliverWebhook(t, checkoutUpdatedEvent(userId))).status).toBe(200)
    const failed = await deliverWebhook(t, checkoutUpdatedEvent(userId, { status: 'failed' }), {
      webhookId: 'polar-delivery-2',
    })
    const expired = await deliverWebhook(
      t,
      checkoutUpdatedEvent(userId, { status: 'expired' }, 'checkout.expired'),
      { webhookId: 'polar-delivery-3' }
    )

    expect(failed.status).toBe(200)
    expect(expired.status).toBe(200)
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('completed')
    expect(state.purchase?.failureReason).toBeUndefined()
    expect(state.user?.tokens).toBe(53)
    expect(state.transactions).toHaveLength(1)
  })

  test('a validated succeeded event completes a failed purchase exactly once', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    await deliverWebhook(t, checkoutUpdatedEvent(userId, { status: 'failed' }))
    expect((await readPurchaseState(t, userId)).purchase?.status).toBe('failed')

    const succeeded = await deliverWebhook(t, checkoutUpdatedEvent(userId), {
      webhookId: 'polar-delivery-2',
    })
    const duplicate = await deliverWebhook(t, checkoutUpdatedEvent(userId), {
      webhookId: 'polar-delivery-3',
    })

    expect(succeeded.status).toBe(200)
    expect(duplicate.status).toBe(200)
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('completed')
    expect(state.purchase?.failureReason).toBeUndefined()
    expect(state.purchase?.failedAt).toBeUndefined()
    expect(state.user?.tokens).toBe(53)
    expect(state.transactions).toHaveLength(1)
  })

  test('a succeeded event still validates before completing a failed purchase', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    await t.mutation(internal.polarWebhook.markPurchaseFailed, {
      checkoutId: 'checkout-50',
      reason: 'checkout_failed',
    })

    await expect(
      t.mutation(
        internal.polarWebhook.validateAndCompletePurchase,
        completedCheckout(userId, { amount: 1 })
      )
    ).resolves.toEqual({ outcome: 'rejected', reason: 'amount' })
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('failed')
    expect(state.user?.tokens).toBe(3)
  })

  test('handles the checkout.expired event for pending purchases', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })

    const response = await deliverWebhook(
      t,
      checkoutUpdatedEvent(userId, { status: 'expired' }, 'checkout.expired')
    )

    expect(response.status).toBe(200)
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('failed')
    expect(state.purchase?.failureReason).toBe('checkout_expired')
    expect(state.user?.tokens).toBe(3)
    expect(state.transactions).toHaveLength(0)
  })

  test('answers 200 with an alert, not 4xx, for signed events that fail business validation', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const mismatched = await deliverWebhook(t, checkoutUpdatedEvent(userId, { amount: 1 }))
    const unknown = await deliverWebhook(
      t,
      checkoutUpdatedEvent(userId, { checkoutId: 'unknown-checkout' }),
      { webhookId: 'polar-delivery-2' }
    )
    const noProduct = await deliverWebhook(t, checkoutUpdatedEvent(userId, { productId: null }), {
      webhookId: 'polar-delivery-3',
    })

    expect([mismatched.status, unknown.status, noProduct.status]).toEqual([200, 200, 200])
    const alerts = alertLines(error)
    expect(alerts).toHaveLength(3)
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain('"reason":"amount"')
    expect(logged).toContain('"reason":"checkout"')
    expect(logged).toContain('"reason":"product"')
    expect(logged).not.toContain('checkout-client-secret')
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('pending')
    expect(state.user?.tokens).toBe(3)
    expect(state.transactions).toHaveLength(0)
  })
})

describe('Polar order.paid fulfilment signal', () => {
  test('re-fetches the checkout and credits once alongside checkout.updated', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(checkoutIdFromUrl(input)).toBe('checkout-50')
      expect(String(input)).toBe('https://sandbox-api.polar.sh/v1/checkouts/checkout-50')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer polar-api-key')
      return jsonResponse(polarCheckoutResponse(userId))
    })
    vi.stubGlobal('fetch', fetchMock)

    const paid = await deliverWebhook(t, orderPaidEvent(userId))
    const updated = await deliverWebhook(t, checkoutUpdatedEvent(userId), {
      webhookId: 'polar-delivery-2',
    })
    const paidAgain = await deliverWebhook(t, orderPaidEvent(userId), {
      webhookId: 'polar-delivery-3',
    })

    expect([paid.status, updated.status, paidAgain.status]).toEqual([200, 200, 200])
    // The second order.paid finds the purchase completed and skips the API.
    expect(fetchMock).toHaveBeenCalledOnce()
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('completed')
    expect(state.user?.tokens).toBe(53)
    expect(state.transactions).toHaveLength(1)
  })

  test('completes a failed purchase when Polar reports the checkout succeeded', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    await deliverWebhook(t, checkoutUpdatedEvent(userId, { status: 'failed' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(polarCheckoutResponse(userId)))
    )

    const paid = await deliverWebhook(t, orderPaidEvent(userId), {
      webhookId: 'polar-delivery-2',
    })

    expect(paid.status).toBe(200)
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('completed')
    expect(state.user?.tokens).toBe(53)
    expect(state.transactions).toHaveLength(1)
  })

  test('asks Polar to redeliver when the checkout lookup fails', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream error', { status: 502 }))
    )

    const paid = await deliverWebhook(t, orderPaidEvent(userId))

    expect(paid.status).toBe(503)
    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('pending')
    expect(state.user?.tokens).toBe(3)
  })

  test('does not ask for redelivery when Polar rejects the API key', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 }))
    )

    const paid = await deliverWebhook(t, orderPaidEvent(userId))

    expect(paid.status).toBe(200)
    expect(alertLines(error)).toHaveLength(1)
    expect((await readPurchaseState(t, userId)).purchase?.status).toBe('pending')
  })

  test('ignores orders that are not paid one-time checkout purchases', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await t.mutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: 'checkout-50',
      packageKey: '50_tokens',
    })
    const fetchMock = vi.fn(async () => jsonResponse(polarCheckoutResponse(userId)))
    vi.stubGlobal('fetch', fetchMock)

    const events = [
      orderPaidEvent(userId, { billingReason: 'subscription_cycle' }),
      orderPaidEvent(userId, { checkoutId: null }),
      orderPaidEvent(userId, { paid: false }),
    ]
    for (const [index, event] of events.entries()) {
      const response = await deliverWebhook(t, event, { webhookId: `polar-delivery-${index}` })
      expect(response.status).toBe(200)
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect((await readPurchaseState(t, userId)).purchase?.status).toBe('pending')
  })
})

describe('Polar pending purchase reconciliation', () => {
  test('settles stale purchases from the authoritative checkout state', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await seedPendingPurchase(t, userId, 'checkout-succeeded', 45 * MINUTE)
    await seedPendingPurchase(t, userId, 'checkout-expired', 45 * MINUTE)
    await seedPendingPurchase(t, userId, 'checkout-open', 45 * MINUTE)
    await seedPendingPurchase(t, userId, 'checkout-fresh', 5 * MINUTE)
    const statuses: Record<string, string> = {
      'checkout-succeeded': 'succeeded',
      'checkout-expired': 'expired',
      'checkout-open': 'open',
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer polar-api-key')
      const checkoutId = checkoutIdFromUrl(input)
      const status = statuses[checkoutId]
      if (!status) throw new Error(`unexpected lookup for ${checkoutId}`)
      return jsonResponse(polarCheckoutResponse(userId, { id: checkoutId, status }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    expect(result).toEqual({ skipped: false, checked: 3, settled: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const succeeded = await readPurchaseState(t, userId, 'checkout-succeeded')
    expect(succeeded.purchase?.status).toBe('completed')
    expect(succeeded.user?.tokens).toBe(53)
    expect(succeeded.transactions).toHaveLength(1)
    expect(succeeded.transactions[0].operationKey).toBe('polar-purchase:checkout-succeeded')
    const expired = await readPurchaseState(t, userId, 'checkout-expired')
    expect(expired.purchase?.status).toBe('failed')
    expect(expired.purchase?.failureReason).toBe('checkout_expired')
    expect((await readPurchaseState(t, userId, 'checkout-open')).purchase?.status).toBe('pending')
    expect((await readPurchaseState(t, userId, 'checkout-fresh')).purchase?.status).toBe('pending')

    // A second run only re-checks the still-open checkout; nothing is re-credited.
    fetchMock.mockClear()
    await t.action(internal.polarReconcile.reconcilePendingPurchases, {})
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(checkoutIdFromUrl(fetchMock.mock.calls[0][0])).toBe('checkout-open')
    const after = await readPurchaseState(t, userId, 'checkout-succeeded')
    expect(after.user?.tokens).toBe(53)
    expect(after.transactions).toHaveLength(1)
  })

  test('does nothing when the Polar API key is not configured', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await seedPendingPurchase(t, userId, 'checkout-50', 45 * MINUTE)
    vi.stubEnv('POLAR_API_KEY', undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    expect(result).toEqual({ skipped: true, checked: 0, settled: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await readPurchaseState(t, userId)).purchase?.status).toBe('pending')
  })

  test('bounds each run to the batch size', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    for (let index = 0; index < 30; index += 1) {
      await seedPendingPurchase(t, userId, `checkout-${index}`, (60 + index) * MINUTE)
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      jsonResponse(polarCheckoutResponse(userId, { id: checkoutIdFromUrl(input), status: 'open' }))
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    expect(result).toEqual({ skipped: false, checked: 25, settled: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(25)
    // Oldest first: the five newest stale purchases wait for the next run.
    const looked = fetchMock.mock.calls.map((call) => checkoutIdFromUrl(call[0]))
    expect(looked).not.toContain('checkout-0')
    expect(looked).toContain('checkout-29')
  })

  test('leaves purchases pending on lookup errors and gives up after the max age', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await seedPendingPurchase(t, userId, 'checkout-recent', 45 * MINUTE)
    await seedPendingPurchase(t, userId, 'checkout-ancient', 25 * 60 * MINUTE)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream error', { status: 500 }))
    )

    await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    expect((await readPurchaseState(t, userId, 'checkout-recent')).purchase?.status).toBe('pending')
    const ancient = await readPurchaseState(t, userId, 'checkout-ancient')
    expect(ancient.purchase?.status).toBe('failed')
    expect(ancient.purchase?.failureReason).toBe('reconcile_timeout')
    expect(alertLines(error)).toHaveLength(1)
    expect(ancient.user?.tokens).toBe(3)
  })

  test('stops the batch when Polar rejects the API key', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await seedPendingPurchase(t, userId, 'checkout-a', 50 * MINUTE)
    await seedPendingPurchase(t, userId, 'checkout-b', 40 * MINUTE)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await readPurchaseState(t, userId, 'checkout-a')).purchase?.status).toBe('pending')
    expect((await readPurchaseState(t, userId, 'checkout-b')).purchase?.status).toBe('pending')
  })

  test('removes a succeeded checkout that fails validation from the pending queue', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await seedPendingPurchase(t, userId, 'checkout-50', 45 * MINUTE)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(polarCheckoutResponse(userId, { amount: 1 })))
    )

    await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('failed')
    expect(state.purchase?.failureReason).toBe('validation_rejected')
    expect(state.user?.tokens).toBe(3)
    expect(state.transactions).toHaveLength(0)
    expect(alertLines(error)).toHaveLength(1)
  })

  test('rejects a lookup response for a different checkout', async () => {
    const t = createTestBackend()
    const userId = await seedUser(t, identity.subject, 'polar-test@example.com')
    await seedPendingPurchase(t, userId, 'checkout-50', 45 * MINUTE)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(polarCheckoutResponse(userId, { id: 'checkout-other' })))
    )

    await t.action(internal.polarReconcile.reconcilePendingPurchases, {})

    const state = await readPurchaseState(t, userId)
    expect(state.purchase?.status).toBe('pending')
    expect(state.user?.tokens).toBe(3)
  })
})
