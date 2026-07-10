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

const unauthorizedResponse = () => new Response('Unauthorized', { status: 401 })
const malformedResponse = () => new Response('Bad Request', { status: 400 })

function verificationHeaders(headers: Headers): Record<string, string> {
  return {
    'webhook-id': headers.get('webhook-id') ?? '',
    'webhook-timestamp': headers.get('webhook-timestamp') ?? '',
    'webhook-signature': headers.get('webhook-signature') ?? '',
  }
}

// Polar webhook handler
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
    if (event.type === 'checkout.created') {
      return new Response('OK', { status: 200 })
    }

    if (event.type === 'checkout.updated') {
      const checkoutData = event.data

      if (checkoutData.status !== 'succeeded' && checkoutData.status !== 'confirmed') {
        return new Response('OK', { status: 200 })
      }

      if (!checkoutData.productId) {
        return malformedResponse()
      }

      const result = await ctx.runMutation(internal.polarWebhook.validateAndCompletePurchase, {
        checkoutId: checkoutData.id,
        status: checkoutData.status,
        productId: checkoutData.productId,
        amount: checkoutData.amount,
        currency: checkoutData.currency,
        externalCustomerId: checkoutData.externalCustomerId,
      })

      if (result.outcome === 'rejected') {
        const status = result.reason === 'checkout' ? 404 : 400
        return new Response('Checkout validation failed', { status })
      }

      return new Response('OK', { status: 200 })
    }

    return new Response('OK', { status: 200 })
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

    if (args.status !== 'succeeded' && args.status !== 'confirmed') {
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

    if (purchase.status === 'failed') {
      return { outcome: 'rejected' as const, reason: 'status' as const }
    }

    const existingTransaction = await ctx.db
      .query('tokenTransactions')
      .withIndex('by_user', (q) => q.eq('userId', purchase.userId))
      .filter((q) =>
        q.and(
          q.eq(q.field('type'), 'purchase'),
          q.eq(q.field('metadata.polarCheckoutId'), args.checkoutId)
        )
      )
      .first()

    if (existingTransaction) {
      if (purchase.status !== 'completed') {
        await ctx.db.patch(purchase._id, {
          status: 'completed',
          completedAt: Date.now(),
        })
      }
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
    })

    return { outcome: 'credited' as const, newBalance }
  },
})
