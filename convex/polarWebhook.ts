import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Verify Polar webhook signature using Standard Webhooks spec
async function verifyPolarSignature(
  payload: string,
  headers: Headers,
  secret: string
): Promise<boolean> {
  try {
    const webhookId = headers.get("webhook-id");
    const webhookTimestamp = headers.get("webhook-timestamp");
    const webhookSignature = headers.get("webhook-signature");

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      console.error("[Polar Webhook] Missing required headers:", {
        "webhook-id": webhookId,
        "webhook-timestamp": webhookTimestamp,
        "webhook-signature": webhookSignature
      });
      return false;
    }

    // Check timestamp is within 5 minutes to prevent replay attacks
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const webhookTimestampNum = parseInt(webhookTimestamp);
    if (Math.abs(currentTimestamp - webhookTimestampNum) > 300) {
      console.error("[Polar Webhook] Timestamp too old");
      return false;
    }

    // Decode base64 secret (Standard Webhooks spec requires base64 encoded secret)
    const secretBytes = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
    
    // Construct signed content according to Standard Webhooks spec
    const signedContent = `${webhookId}.${webhookTimestamp}.${payload}`;
    const encoder = new TextEncoder();
    
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedContent)
    );
    
    // Convert to base64
    const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    
    // Check if any of the provided signatures match (supports multiple signatures)
    const signatures = webhookSignature.split(" ");
    for (const sig of signatures) {
      const [version, signature] = sig.split(",");
      if (version === "v1" && signature === computedSignature) {
        return true;
      }
    }
    
    console.error("[Polar Webhook] Signature mismatch");
    return false;
  } catch (error) {
    console.error("[Polar Webhook] Error verifying signature:", error);
    return false;
  }
}

// Polar webhook handler
export const handlePolarWebhook = httpAction(async (ctx, request) => {
  // Get the raw body for signature verification
  const rawBody = await request.text();
  const body = JSON.parse(rawBody);
  console.log("[Polar Webhook] Received event:", body);

  // Verify webhook signature in production
  if (process.env.POLAR_WEBHOOK_SECRET) {
    // Verify the signature using Standard Webhooks spec
    const isValid = await verifyPolarSignature(
      rawBody,
      request.headers,
      process.env.POLAR_WEBHOOK_SECRET
    );
    
    if (!isValid) {
      console.error("[Polar Webhook] Invalid signature");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const { event, data } = body;

  if (event === "checkout.created") {
    // Handle checkout creation
    console.log("[Polar Webhook] Checkout created:", data);
    
    // Extract user ID from metadata
    const userId = data.metadata?.userId as Id<"users"> | undefined;
    if (!userId) {
      console.error("[Polar Webhook] No userId in checkout metadata");
      return new Response("Missing userId", { status: 400 });
    }

    // Create pending purchase record
    await ctx.runMutation(internal.polarWebhook.createPendingPurchase, {
      userId,
      checkoutId: data.id,
      productId: data.product_id,
      productName: data.product.name,
      amount: data.amount,
      currency: data.currency,
      tokens: data.metadata?.tokens || 100, // Default to 100 tokens
    });
  } else if (event === "checkout.updated" && data.status === "succeeded") {
    // Handle successful payment
    console.log("[Polar Webhook] Checkout succeeded:", data);
    
    const purchase = await ctx.runQuery(internal.polarWebhook.getPurchaseByCheckoutId, {
      checkoutId: data.id,
    });

    if (!purchase) {
      console.error("[Polar Webhook] Purchase record not found for checkout:", data.id);
      return new Response("Purchase not found", { status: 404 });
    }

    // Mark purchase as completed
    await ctx.runMutation(internal.polarWebhook.completePurchase, {
      purchaseId: purchase._id,
    });

    // Credit tokens to user
    await ctx.runMutation(internal.tokens.creditTokensFromPurchase, {
      userId: purchase.userId,
      tokens: purchase.tokens,
      polarCheckoutId: purchase.checkoutId,
      polarProductId: purchase.productId,
      description: `Purchased ${purchase.tokens} tokens`,
    });
  }

  return new Response("OK", { status: 200 });
});

// Internal queries and mutations for webhook handling
export const createPendingPurchase = internalMutation({
  args: {
    userId: v.id("users"),
    checkoutId: v.string(),
    productId: v.string(),
    productName: v.string(),
    amount: v.number(),
    currency: v.string(),
    tokens: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("polarPurchases", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const getPurchaseByCheckoutId = internalQuery({
  args: {
    checkoutId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("polarPurchases")
      .withIndex("by_checkout", (q) => q.eq("checkoutId", args.checkoutId))
      .first();
  },
});

export const completePurchase = internalMutation({
  args: {
    purchaseId: v.id("polarPurchases"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.purchaseId, {
      status: "completed",
      completedAt: Date.now(),
    });
  },
});