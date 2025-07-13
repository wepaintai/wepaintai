import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";

interface PolarCheckoutResponse {
  id: string;
  checkout_url?: string;
  url?: string;
  amount: number;
  currency: string;
}

interface CheckoutResult {
  checkoutUrl: string;
  checkoutId: string;
}

// Create a Polar checkout session
export const createCheckout = action({
  args: {
    productId: v.string(),
    tokens: v.number(),
  },
  handler: async (ctx, args): Promise<CheckoutResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.runQuery(api.auth.getCurrentUser);
    if (!user) {
      throw new Error("User not found");
    }

    // Get Polar API key from environment
    const polarApiKey = process.env.POLAR_API_KEY;
    if (!polarApiKey) {
      throw new Error("Polar API key not configured");
    }

    // Get API base URL (defaults to sandbox if not set)
    const polarApiBaseUrl = process.env.POLAR_API_BASE_URL || 'https://sandbox-api.polar.sh';

    try {
      // Create checkout session with Polar
      const response = await fetch(`${polarApiBaseUrl}/v1/checkouts`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${polarApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          product_id: args.productId,
          metadata: {
            userId: user._id,
            tokens: args.tokens,
          },
          success_url: `${process.env.VITE_APP_URL || 'http://localhost:3000'}?purchase=success`,
          cancel_url: `${process.env.VITE_APP_URL || 'http://localhost:3000'}?purchase=cancelled`,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Polar API error:", error);
        throw new Error("Failed to create checkout session");
      }

      const data: PolarCheckoutResponse = await response.json();
      
      // Create pending purchase record
      await ctx.runMutation(internal.polarWebhook.createPendingPurchase, {
        userId: user._id,
        checkoutId: data.id,
        productId: args.productId,
        productName: `${args.tokens} Token Pack`,
        amount: data.amount,
        currency: data.currency,
        tokens: args.tokens,
      });

      return {
        checkoutUrl: data.checkout_url || data.url || '',
        checkoutId: data.id,
      };
    } catch (error) {
      console.error("Error creating Polar checkout:", error);
      throw new Error("Failed to create checkout session");
    }
  },
});

interface TokenPackage {
  id: string;
  name: string;
  tokens: number;
  price: number;
  currency: string;
  description: string;
  pricePerToken: number;
}

// Get available token packages
export const getTokenPackages = action({
  args: {},
  handler: async (ctx): Promise<TokenPackage[]> => {
    // For now, return hardcoded packages. Later this could fetch from Polar
    return [
      {
        id: "prod_100_tokens",
        name: "125 Token Pack",
        tokens: 125,
        price: 999, // in cents
        currency: "USD",
        description: "",
        pricePerToken: 0.08, // $9.99 / 125 tokens
      },
    ];
  },
});