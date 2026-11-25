import { httpAction, internalMutation } from './_generated/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks'
import {
  getTokenPackage,
  getTokenPackageDefinition,
  isTokenPackageKey,
  tokenPackageKeyValidator,
} from './polarPackages'
import { assertPositiveTokenAmount, assertValidTokenBalance } from './tokenPolicy'
import { settleCheckout } from './polarReconcile'

const unauthorizedResponse = () => new Response('Unauthorized', { status: 401 })
const malformedResponse = () => new Response('Bad Request', { status: 400 })

function verificationHeaders(headers: Headers): Record<string, string> {
  return {
    'webhook-id': headers.get('webhook-id') ?? '',
    'webhook-timestamp': headers.get('webhook-timestamp') ?? '',
    'webhook-signature': headers.get('webhook-signature') ?? '',
  }
}

const ok = () => new Response('OK', { status: 200 })

// Polar webhook handler.
//
// Response policy: signature/verification failures are 4xx, events that fail
// Polar's schema are 400, and transient processing errors are 5xx so Polar
// retries. A validly signed event is never answered with a 4xx for business
// reasons (unknown checkout, mismatched product, ...): those return 200 and log
// a `[POLAR-ALERT]` line, because retrying an unchanged event cannot help.
export const handlePolarWebhook = httpAction(async (ctx, request) => {
  const webhookSecret = process.env.POLAR_WEBHOOK_SECRET
  if (!webhookSecret?.trim()) {
    console.error('[Polar Webhook] Webhook verification is not configured')
    return unauthorizedResponse()
  }

  let event: ReturnType<typeof validateEvent>
  try {
    const rawBody = await request.text()
    event = validateEvent(rawBody, verificationHeaders(request.headers), webhookSecret)
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      console.warn('[Polar Webhook] Webhook verification failed')
      return unauthorizedResponse()
    }
    console.warn('[Polar Webhook] Malformed webhook event rejected')
    return malformedResponse()
  }

  try {
    if (event.type === 'checkout.updated' || event.type === 'checkout.expired') {
      const checkoutData = event.data
      // `checkout.expired` is its own event type; treat it as `expired` unless
      // Polar reports that the checkout actually settled.
      const status =
        event.type === 'checkout.expired' && checkoutData.status !== 'succeeded'
          ? 'expired'
          : checkoutData.status

      await settleCheckout(
        ctx,
        {
          id: checkoutData.id,
          status,
          productId: checkoutData.productId ?? null,
          amount: checkoutData.amount,
          currency: checkoutData.currency,
          externalCustomerId: checkoutData.externalCustomerId ?? null,
        },
        event.type
      )
      return ok()
    }

    if (event.type === 'order.paid') {
      const order = event.data
      // Only one-time purchases created by our checkout flow are fulfilled.
      // The order itself is only a trigger: tokens are granted after the
      // authoritative checkout is re-fetched from Polar and validated through
      // the same idempotent completion, keyed on the checkout id.
      if (!order.paid || order.billingReason !== 'purchase' || !order.checkoutId) {
        return ok()
      }

      const outcome = await ctx.runAction(internal.polarReconcile.reconcileCheckout, {
        checkoutId: order.checkoutId,
        source: 'order.paid',
      })
      if (outcome === 'retry') {
        return new Response('Service Unavailable', { status: 503 })
      }
      return ok()
    }

    return ok()
  } catch {
    console.error('[Polar Webhook] Webhook processing failed')
    return new Response('Internal Server Error', { status: 500 })
  }
})

// Internal mutation to create a pending purchase
export const createPendingPurchase = internalMutation({
  args: {
    userId: v.id('users'),
    checkoutId: v.string(),
    packageKey: tokenPackageKeyValidator,
  },
  handler: async (ctx, args) => {
    const tokenPackage = getTokenPackage(args.packageKey)
    const existingPurchase = await ctx.db
      .query('polarPurchases')
      .withIndex('by_checkout', (q) => q.eq('checkoutId', args.checkoutId))
      .first()

    if (existingPurchase) {
      throw new Error('Checkout already registered')
    }

    return await ctx.db.insert('polarPurchases', {
      userId: args.userId,
      checkoutId: args.checkoutId,
      packageKey: tokenPackage.key,
      productId: tokenPackage.productId,
      productName: tokenPackage.name,
      amount: tokenPackage.amount,
      currency: tokenPackage.currency,
      tokens: tokenPackage.tokens,
      status: 'pending',
      createdAt: Date.now(),
    })
  },
})

export const purchaseFailureReasonValidator = v.union(
  v.literal('checkout_failed'),
  v.literal('checkout_expired'),
  v.literal('validation_rejected'),
  v.literal('reconcile_timeout')
)

// Only `pending` purchases can move to `failed`. A `completed` purchase is
// never reverted, so late or out-of-order failure events are no-ops.
export const markPurchaseFailed = internalMutation({
  args: {
    checkoutId: v.string(),
    reason: purchaseFailureReasonValidator,
  },
  handler: async (ctx, args) => {
    const purchase = await ctx.db
      .query('polarPurchases')
      .withIndex('by_checkout', (q) => q.eq('checkoutId', args.checkoutId))
      .first()

    if (!purchase) {
      return { updated: false as const, status: null }
    }

    if (purchase.status !== 'pending') {
      return { updated: false as const, status: purchase.status }
    }

    await ctx.db.patch(purchase._id, {
      status: 'failed',
      failureReason: args.reason,
      failedAt: Date.now(),
    })
    return { updated: true as const, status: 'failed' as const }
  },
})

export const validateAndCompletePurchase = internalMutation({
  args: {
    checkoutId: v.string(),
    status: v.string(),
    productId: v.string(),
    amount: v.number(),
    currency: v.string(),
    externalCustomerId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const purchase = await ctx.db
      .query('polarPurchases')
      .withIndex('by_checkout', (q) => q.eq('checkoutId', args.checkoutId))
      .first()

    if (!purchase) {
      return { outcome: 'rejected' as const, reason: 'checkout' as const }
    }

    if (args.status !== 'succeeded') {
      return { outcome: 'rejected' as const, reason: 'status' as const }
    }

    if (!purchase.packageKey || !isTokenPackageKey(purchase.packageKey)) {
      return { outcome: 'rejected' as const, reason: 'package' as const }
    }

    const definition = getTokenPackageDefinition(purchase.packageKey)
    if (
      purchase.tokens !== definition.tokens ||
      purchase.amount !== definition.amount ||
      purchase.currency.toLowerCase() !== definition.currency ||
      !purchase.productId.trim()
    ) {
      return { outcome: 'rejected' as const, reason: 'package' as const }
    }

    if (args.productId !== purchase.productId) {
      return { outcome: 'rejected' as const, reason: 'product' as const }
    }

    if (args.amount !== purchase.amount) {
      return { outcome: 'rejected' as const, reason: 'amount' as const }
    }

    if (args.currency.toLowerCase() !== purchase.currency.toLowerCase()) {
      return { outcome: 'rejected' as const, reason: 'currency' as const }
    }

    if (args.externalCustomerId !== String(purchase.userId)) {
      return { outcome: 'rejected' as const, reason: 'user' as const }
    }

    // A validated `succeeded` checkout completes from `pending` or `failed`:
    // Polar may deliver `failed` before a retried payment succeeds, or deliver
    // events out of order. Only `completed` is terminal.
    if (purchase.status === 'completed') {
      return { outcome: 'duplicate' as const }
    }

    const operationKey = `polar-purchase:${args.checkoutId}`
    const existingByKey = await ctx.db
      .query('tokenTransactions')
      .withIndex('by_user_operation', (q) =>
        q.eq('userId', purchase.userId).eq('operationKey', operationKey)
      )
      .first()

    const existingTransaction =
      existingByKey ??
      (await ctx.db
        .query('tokenTransactions')
        .withIndex('by_user', (q) => q.eq('userId', purchase.userId))
        .filter((q) =>
          q.and(
            q.eq(q.field('type'), 'purchase'),
            q.eq(q.field('metadata.polarCheckoutId'), args.checkoutId)
          )
        )
        .first())

    if (existingTransaction) {
      await ctx.db.patch(purchase._id, {
        status: 'completed',
        completedAt: Date.now(),
        failureReason: undefined,
        failedAt: undefined,
      })
      return { outcome: 'duplicate' as const }
    }

    const tokens = assertPositiveTokenAmount(purchase.tokens, 'Purchase tokens')
    const user = await ctx.db.get(purchase.userId)
    if (!user) {
      throw new Error('Purchase user not found')
    }

    const currentTokens = assertValidTokenBalance(user.tokens ?? 0)
    const newBalance = assertValidTokenBalance(currentTokens + tokens)

    await ctx.db.patch(purchase.userId, {
      tokens: newBalance,
      updatedAt: Date.now(),
    })
    await ctx.db.insert('tokenTransactions', {
      userId: purchase.userId,
      operationKey,
      type: 'purchase',
      amount: tokens,
      balance: newBalance,
      description: `Purchased ${definition.name}`,
      metadata: {
        polarCheckoutId: args.checkoutId,
        polarProductId: purchase.productId,
      },
      createdAt: Date.now(),
    })
    await ctx.db.patch(purchase._id, {
      status: 'completed',
      completedAt: Date.now(),
      failureReason: undefined,
      failedAt: undefined,
    })

    return { outcome: 'credited' as const, newBalance }
  },
})
