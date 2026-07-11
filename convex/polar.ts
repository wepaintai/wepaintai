import { action, query } from './_generated/server'
import { api, internal } from './_generated/api'
import { getPublicTokenPackages, getTokenPackage, tokenPackageKeyValidator } from './polarPackages'

interface PolarCheckoutResponse {
  id: string
  checkout_url?: string
  url?: string
  amount: number
  currency: string
  product_id: string | null
  external_customer_id: string | null
}

interface CheckoutResult {
  checkoutUrl: string
  checkoutId: string
}

export const createCheckout = action({
  args: {
    packageKey: tokenPackageKeyValidator,
  },
  handler: async (ctx, args): Promise<CheckoutResult> => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) {
      throw new Error('Not authenticated')
    }

    const user = await ctx.runQuery(api.auth.getCurrentUser)
    if (!user) {
      throw new Error('User not found')
    }

    const tokenPackage = getTokenPackage(args.packageKey)
    const polarApiKey = process.env.POLAR_API_KEY
    if (!polarApiKey) {
      throw new Error('Polar API key not configured')
    }

    const appUrl = (process.env.APP_URL || process.env.SITE_URL)?.replace(/\/$/, '')
    if (!appUrl) {
      throw new Error('APP_URL or SITE_URL not configured')
    }

    const polarApiBaseUrl = process.env.POLAR_API_BASE_URL || 'https://sandbox-api.polar.sh'
    const externalCustomerId = String(user._id)

    try {
      const response = await fetch(`${polarApiBaseUrl}/v1/checkouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${polarApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          products: [tokenPackage.productId],
          external_customer_id: externalCustomerId,
          customer_email: user.email,
          allow_discount_codes: false,
          success_url: `${appUrl}?purchase=success&checkout_id={CHECKOUT_ID}`,
          return_url: `${appUrl}?purchase=cancelled`,
        }),
      })

      if (!response.ok) {
        console.error('Polar checkout creation failed', {
          status: response.status,
        })
        throw new Error('Failed to create checkout session')
      }

      const data: PolarCheckoutResponse = await response.json()
      const checkoutUrl = data.checkout_url || data.url || ''

      if (
        !data.id?.trim() ||
        !checkoutUrl ||
        data.product_id !== tokenPackage.productId ||
        data.amount !== tokenPackage.amount ||
        data.currency.toLowerCase() !== tokenPackage.currency ||
        data.external_customer_id !== externalCustomerId
      ) {
        throw new Error('Polar returned an invalid checkout')
      }

      await ctx.runMutation(internal.polarWebhook.createPendingPurchase, {
        userId: user._id,
        checkoutId: data.id,
        packageKey: args.packageKey,
      })

      return {
        checkoutUrl,
        checkoutId: data.id,
      }
    } catch (error) {
      console.error('Error creating Polar checkout:', error)
      // Convex's TypeScript target does not include the ErrorOptions `cause` overload.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Failed to create checkout session')
    }
  },
})

export const getTokenPackages = query({
  args: {},
  handler: () => getPublicTokenPackages(),
})
