import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { type ActionCtx, internalAction, internalQuery } from './_generated/server'

// Purchases still `pending` this long after checkout creation are re-checked
// against Polar, in case a webhook delivery was lost.
export const RECONCILE_STALE_AFTER_MS = 30 * 60 * 1000
// Pending purchases that still cannot be settled after this long are marked
// `failed` (with an alert) so they stop blocking the oldest-first queue. A
// later validated `succeeded` checkout still completes a `failed` purchase.
export const RECONCILE_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000
export const RECONCILE_BATCH_SIZE = 25
const POLAR_FETCH_TIMEOUT_MS = 10_000

export interface CheckoutSnapshot {
  id: string
  status: string
  productId: string | null
  amount: number
  currency: string
  externalCustomerId: string | null
}

export type SettlementOutcome = 'credited' | 'duplicate' | 'rejected' | 'closed' | 'ignored'

type AlertDetails = Record<string, string | number | null>

// Alert lines carry identifiers and reasons only, never payloads or secrets.
export function polarAlert(message: string, details: AlertDetails) {
  console.error(`[POLAR-ALERT] ${message}`, details)
}

/**
 * Applies an authoritative checkout state to the matching purchase. Shared by
 * the webhook handler and reconciliation so both use the same validation and
 * the same idempotent completion keyed on the checkout id.
 */
export async function settleCheckout(
  ctx: ActionCtx,
  checkout: CheckoutSnapshot,
  source: string
): Promise<SettlementOutcome> {
  if (checkout.status === 'failed' || checkout.status === 'expired') {
    const result = await ctx.runMutation(internal.polarWebhook.markPurchaseFailed, {
      checkoutId: checkout.id,
      reason: checkout.status === 'expired' ? 'checkout_expired' : 'checkout_failed',
    })
    if (result.status === 'completed') {
      console.warn('[Polar] Ignoring terminal checkout status for a completed purchase', {
        checkoutId: checkout.id,
        status: checkout.status,
        source,
      })
    }
    return 'closed'
  }

  // Only credit tokens once payment has settled (`succeeded`). Polar emits
  // `confirmed` when the customer submits payment details, before capture/3DS
  // completes; crediting on `confirmed` risks granting tokens for checkouts
  // that subsequently fail.
  if (checkout.status !== 'succeeded') {
    return 'ignored'
  }

  if (!checkout.productId) {
    polarAlert('Succeeded checkout has no product; not credited', {
      checkoutId: checkout.id,
      reason: 'product',
      source,
    })
    return 'rejected'
  }

  const result = await ctx.runMutation(internal.polarWebhook.validateAndCompletePurchase, {
    checkoutId: checkout.id,
    status: checkout.status,
    productId: checkout.productId,
    amount: checkout.amount,
    currency: checkout.currency,
    externalCustomerId: checkout.externalCustomerId,
  })

  if (result.outcome === 'rejected') {
    polarAlert('Succeeded checkout failed validation; not credited', {
      checkoutId: checkout.id,
      reason: result.reason,
      source,
    })
    return 'rejected'
  }

  return result.outcome
}

type PolarApiConfig = { apiKey: string; baseUrl: string }

function getPolarApiConfig(): PolarApiConfig | null {
  const apiKey = process.env.POLAR_API_KEY?.trim()
  if (!apiKey) {
    return null
  }
  const baseUrl = (process.env.POLAR_API_BASE_URL || 'https://sandbox-api.polar.sh').replace(
    /\/+$/,
    ''
  )
  return { apiKey, baseUrl }
}

type FetchCheckoutResult =
  | { kind: 'ok'; checkout: CheckoutSnapshot }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'error' }

function parseCheckout(body: unknown, expectedId: string): CheckoutSnapshot | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  const record = body as Record<string, unknown>
  if (
    record.id !== expectedId ||
    typeof record.status !== 'string' ||
    typeof record.amount !== 'number' ||
    typeof record.currency !== 'string' ||
    (record.product_id != null && typeof record.product_id !== 'string') ||
    (record.external_customer_id != null && typeof record.external_customer_id !== 'string')
  ) {
    return null
  }
  return {
    id: record.id,
    status: record.status,
    productId: (record.product_id as string | null | undefined) ?? null,
    amount: record.amount,
    currency: record.currency,
    externalCustomerId: (record.external_customer_id as string | null | undefined) ?? null,
  }
}

async function fetchCheckout(
  config: PolarApiConfig,
  checkoutId: string
): Promise<FetchCheckoutResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), POLAR_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${config.baseUrl}/v1/checkouts/${encodeURIComponent(checkoutId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      }
    )
    if (response.status === 401 || response.status === 403) {
      return { kind: 'unauthorized' }
    }
    if (response.status === 404) {
      return { kind: 'not_found' }
    }
    if (!response.ok) {
      console.warn('[Polar Reconcile] Checkout lookup failed', {
        checkoutId,
        status: response.status,
      })
      return { kind: 'error' }
    }
    const checkout = parseCheckout(await response.json(), checkoutId)
    if (!checkout) {
      polarAlert('Polar returned an unexpected checkout shape', {
        checkoutId,
        reason: 'malformed',
      })
      return { kind: 'error' }
    }
    return { kind: 'ok', checkout }
  } catch {
    console.warn('[Polar Reconcile] Checkout lookup errored', { checkoutId })
    return { kind: 'error' }
  } finally {
    clearTimeout(timeout)
  }
}

type PurchaseSummary = Pick<Doc<'polarPurchases'>, 'checkoutId' | 'status' | 'createdAt'>

type ReconcileResult = 'settled' | 'pending' | 'retry' | 'unauthorized'

async function reconcilePurchase(
  ctx: ActionCtx,
  config: PolarApiConfig,
  purchase: PurchaseSummary,
  source: string,
  now: number
): Promise<ReconcileResult> {
  const checkoutId = purchase.checkoutId
  const pastGiveUp =
    purchase.status === 'pending' && now - purchase.createdAt > RECONCILE_GIVE_UP_AFTER_MS

  const giveUp = async (reason: string) => {
    polarAlert('Pending purchase could not be reconciled; marking failed', {
      checkoutId,
      reason,
      source,
    })
    await ctx.runMutation(internal.polarWebhook.markPurchaseFailed, {
      checkoutId,
      reason: 'reconcile_timeout',
    })
    return 'settled' as const
  }

  const fetched = await fetchCheckout(config, checkoutId)
  if (fetched.kind === 'unauthorized') {
    polarAlert('Polar API rejected the API key during reconciliation', {
      checkoutId,
      reason: 'unauthorized',
      source,
    })
    return 'unauthorized'
  }
  if (fetched.kind === 'not_found') {
    if (pastGiveUp) {
      return await giveUp('not_found')
    }
    polarAlert('Checkout not found at Polar', { checkoutId, reason: 'not_found', source })
    return 'pending'
  }
  if (fetched.kind === 'error') {
    return pastGiveUp ? await giveUp('lookup_error') : 'retry'
  }

  const outcome = await settleCheckout(ctx, fetched.checkout, source)
  if (outcome === 'rejected') {
    // A succeeded checkout that fails validation will fail again on every run;
    // take it out of the pending queue (the alert was already logged).
    await ctx.runMutation(internal.polarWebhook.markPurchaseFailed, {
      checkoutId,
      reason: 'validation_rejected',
    })
    return 'settled'
  }
  if (outcome === 'ignored') {
    return pastGiveUp ? await giveUp(`status_${fetched.checkout.status}`) : 'pending'
  }
  return 'settled'
}

export const listStalePendingPurchases = internalQuery({
  args: {
    createdBefore: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit), 100))
    const purchases = await ctx.db
      .query('polarPurchases')
      .withIndex('by_status_created', (q) =>
        q.eq('status', 'pending').lt('createdAt', args.createdBefore)
      )
      .take(limit)
    return purchases.map((purchase) => ({
      checkoutId: purchase.checkoutId,
      status: purchase.status,
      createdAt: purchase.createdAt,
    }))
  },
})

export const getPurchaseSummary = internalQuery({
  args: { checkoutId: v.string() },
  handler: async (ctx, args) => {
    const purchase = await ctx.db
      .query('polarPurchases')
      .withIndex('by_checkout', (q) => q.eq('checkoutId', args.checkoutId))
      .first()
    if (!purchase) {
      return null
    }
    return {
      checkoutId: purchase.checkoutId,
      status: purchase.status,
      createdAt: purchase.createdAt,
    }
  },
})

/**
 * Re-checks one checkout against Polar and settles it. Used by the `order.paid`
 * webhook. Returns `retry` when Polar could not be reached, so the webhook can
 * answer 5xx and let Polar redeliver.
 */
export const reconcileCheckout = internalAction({
  args: {
    checkoutId: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args): Promise<'settled' | 'skipped' | 'retry'> => {
    const purchase = await ctx.runQuery(internal.polarReconcile.getPurchaseSummary, {
      checkoutId: args.checkoutId,
    })
    if (!purchase) {
      polarAlert('Paid order references an unknown checkout', {
        checkoutId: args.checkoutId,
        reason: 'checkout',
        source: args.source,
      })
      return 'skipped'
    }
    if (purchase.status === 'completed') {
      return 'skipped'
    }

    const config = getPolarApiConfig()
    if (!config) {
      polarAlert('POLAR_API_KEY is not configured; cannot verify paid order', {
        checkoutId: args.checkoutId,
        reason: 'unconfigured',
        source: args.source,
      })
      return 'skipped'
    }

    const result = await reconcilePurchase(ctx, config, purchase, args.source, Date.now())
    if (result === 'retry' || result === 'unauthorized') {
      return 'retry'
    }
    return result === 'settled' ? 'settled' : 'skipped'
  },
})

/**
 * Cron: settles purchases stuck in `pending` (for example after a lost
 * webhook delivery) by asking Polar for the authoritative checkout state.
 */
export const reconcilePendingPurchases = internalAction({
  args: {},
  handler: async (ctx) => {
    const config = getPolarApiConfig()
    if (!config) {
      console.warn('[Polar Reconcile] POLAR_API_KEY is not configured; skipping reconciliation')
      return { skipped: true as const, checked: 0, settled: 0 }
    }

    const now = Date.now()
    const purchases = await ctx.runQuery(internal.polarReconcile.listStalePendingPurchases, {
      createdBefore: now - RECONCILE_STALE_AFTER_MS,
      limit: RECONCILE_BATCH_SIZE,
    })

    let checked = 0
    let settled = 0
    for (const purchase of purchases) {
      checked += 1
      try {
        const result = await reconcilePurchase(ctx, config, purchase, 'reconcile', now)
        if (result === 'unauthorized') {
          // A bad key fails for every row; stop instead of hammering the API.
          break
        }
        if (result === 'settled') {
          settled += 1
        }
      } catch {
        console.error('[Polar Reconcile] Failed to reconcile purchase', {
          checkoutId: purchase.checkoutId,
        })
      }
    }

    if (purchases.length === RECONCILE_BATCH_SIZE) {
      console.warn('[Polar Reconcile] Batch limit reached; remaining purchases wait for next run')
    }

    return { skipped: false as const, checked, settled }
  },
})
