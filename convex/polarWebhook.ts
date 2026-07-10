import { httpAction, internalMutation } from './_generated/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import {
  getTokenPackage,
  getTokenPackageDefinition,
  isTokenPackageKey,
  tokenPackageKeyValidator,
} from './polarPackages'
import { assertPositiveTokenAmount, assertValidTokenBalance } from './tokenPolicy'

interface CheckoutUpdateData {
  id: string
  status: string
  productId: string
  amount: number
  currency: string
  externalCustomerId: string | null
}

function parseCheckoutUpdateData(value: unknown): CheckoutUpdateData {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid checkout payload')
  }

  const data = value as Record<string, unknown>
  if (
    typeof data.id !== 'string' ||
    typeof data.status !== 'string' ||
    typeof data.product_id !== 'string' ||
    typeof data.amount !== 'number' ||
    typeof data.currency !== 'string' ||
    (data.external_customer_id !== null && typeof data.external_customer_id !== 'string')
  ) {
    throw new Error('Invalid checkout payload')
  }

  return {
    id: data.id,
    status: data.status,
    productId: data.product_id,
    amount: data.amount,
    currency: data.currency,
    externalCustomerId: data.external_customer_id,
  }
}

// Custom webhook verification for Convex environment following Standard Webhooks spec
async function verifyPolarWebhook(body: string, headers: Record<string, string>, secret: string) {
  // Standard Webhooks uses these headers
  const webhookId = headers['webhook-id'] || headers['Webhook-Id'];
  const webhookTimestamp = headers['webhook-timestamp'] || headers['Webhook-Timestamp'];
  const webhookSignature = headers['webhook-signature'] || headers['Webhook-Signature'];
  
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    console.error('[Polar Webhook] Missing required headers:', {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': webhookSignature
    });
    throw new Error('Missing required webhook headers');
  }
  
  // Try multiple secret formats
  console.log('[Polar Webhook] Secret format check:', {
    hasWhsecPrefix: secret.startsWith('whsec_'),
    length: secret.length,
    preview: secret.substring(0, 10) + '...'
  });
  
  // We'll try multiple approaches for the secret
  const encoder = new TextEncoder();
  const secretsToTry = [];
  
  // 1. Raw secret as-is
  secretsToTry.push(encoder.encode(secret));
  
  // 2. Secret without whsec_ prefix if present
  if (secret.startsWith('whsec_')) {
    const withoutPrefix = secret.slice(6);
    secretsToTry.push(encoder.encode(withoutPrefix));
    
    // 3. Base64 decoded version of secret without prefix
    try {
      const decoded = Uint8Array.from(atob(withoutPrefix), c => c.charCodeAt(0));
      secretsToTry.push(decoded);
    } catch (e) {
      console.log('[Polar Webhook] Could not base64 decode secret without prefix');
    }
  }
  
  // 4. Base64 decoded version of full secret
  try {
    const decoded = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
    secretsToTry.push(decoded);
  } catch (e) {
    console.log('[Polar Webhook] Could not base64 decode full secret');
  }
  
  // Create the signed content: msg_id.timestamp.payload
  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
  
  console.log('[Polar Webhook] Signed content preview:', signedContent.substring(0, 100) + '...');
  
  // Try each secret format
  let isValid = false;
  
  for (let i = 0; i < secretsToTry.length; i++) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        secretsToTry[i],
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      
      const signatureBytes = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(signedContent)
      );
      
      // Convert to base64
      const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
      const expectedSig = `v1,${computedSignature}`;
      
      console.log(`[Polar Webhook] Try ${i + 1} - Computed:`, expectedSig);
      
      // Extract signatures from header (can be space-delimited)
      const signatures = webhookSignature.split(' ');
      
      for (const sig of signatures) {
        if (sig === expectedSig) {
          isValid = true;
          console.log(`[Polar Webhook] Signature matched with secret format ${i + 1}`);
          break;
        }
      }
      
      if (isValid) break;
    } catch (e) {
      console.log(`[Polar Webhook] Failed to compute signature with format ${i + 1}:`, e);
    }
  }
  
  if (!isValid) {
    console.error('[Polar Webhook] Signature verification failed');
    console.error('[Polar Webhook] Received:', webhookSignature);
    console.error('[Polar Webhook] None of the computed signatures matched');
    throw new Error('Invalid signature');
  }
  
  // Check timestamp to prevent replay attacks (5 minute window)
  const timestamp = parseInt(webhookTimestamp);
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - timestamp) > 300) {
    throw new Error('Webhook timestamp too old');
  }
  
  // Parse and return the event
  return JSON.parse(body);
}

// Polar webhook handler
export const handlePolarWebhook = httpAction(async (ctx, request) => {
  // Get the raw body for signature verification
  const rawBody = await request.text()

  try {
    // Parse headers into a plain object
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })

    // Log all headers for debugging
    console.log('[Polar Webhook] Received headers:', headers)

    // Verify webhook signature and parse the event
    const event = await verifyPolarWebhook(rawBody, headers, process.env.POLAR_WEBHOOK_SECRET || '')

    console.log('[Polar Webhook] Received event:', event)

    const { type, data } = event

    if (type === 'checkout.created') {
      // Just log and acknowledge - purchase record already created in polar.ts
      console.log('[Polar Webhook] Checkout created:', data.id)
      return new Response('OK', { status: 200 })
    }

    if (type === 'checkout.updated') {
      const checkoutData = parseCheckoutUpdateData(data)

      if (checkoutData.status !== 'succeeded' && checkoutData.status !== 'confirmed') {
        return new Response('OK', { status: 200 })
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

    // Unknown event type
    console.log('[Polar Webhook] Unhandled event type:', type)
    return new Response('OK', { status: 200 })
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('signature') || error.message.includes('Invalid signature'))
    ) {
      console.error('[Polar Webhook] Verification failed:', error.message)
      return new Response('Unauthorized', { status: 401 })
    }
    console.error('[Polar Webhook] Error processing webhook:', error)
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
