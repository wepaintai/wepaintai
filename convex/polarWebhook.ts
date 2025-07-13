import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Custom webhook verification for Convex environment
async function verifyPolarWebhook(body: string, headers: Record<string, string>, secret: string) {
  const signature = headers['x-polar-signature'] || headers['X-Polar-Signature'];
  
  if (!signature) {
    throw new Error('No signature header found');
  }
  
  // Extract timestamp and signature from header
  const parts = signature.split(',');
  let timestamp = '';
  let receivedSig = '';
  
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') receivedSig = value;
  }
  
  if (!timestamp || !receivedSig) {
    throw new Error('Invalid signature format');
  }
  
  // Create the signed payload
  const signedPayload = `${timestamp}.${body}`;
  
  // Use Web Crypto API to compute HMAC
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature_bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signedPayload)
  );
  
  // Convert to hex string
  const computedSig = Array.from(new Uint8Array(signature_bytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Compare signatures
  if (computedSig !== receivedSig) {
    throw new Error('Invalid signature');
  }
  
  // Parse and return the event
  return JSON.parse(body);
}

// Polar webhook handler
export const handlePolarWebhook = httpAction(async (ctx, request) => {
  // Get the raw body for signature verification
  const rawBody = await request.text();
  
  try {
    // Parse headers into a plain object
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    // Verify webhook signature and parse the event
    const event = await verifyPolarWebhook(
      rawBody,
      headers,
      process.env.POLAR_WEBHOOK_SECRET || ''
    );
    
    console.log("[Polar Webhook] Received event:", event);
    
    const { type, data } = event;
    
    if (type === "checkout.created") {
      // Handle checkout creation
      console.log("[Polar Webhook] Checkout created:", data.id);
      
      // Extract metadata with fallback values
      const metadata = (data as any).metadata || {};
      const userId = metadata.userId;
      const tokens = metadata.tokens || 0;
      
      if (!userId) {
        console.error("[Polar Webhook] Missing userId in metadata");
        return new Response("Bad Request", { status: 400 });
      }
      
      // Create pending purchase record
      await ctx.runMutation(internal.polarWebhook.createPendingPurchase, {
        userId,
        checkoutId: data.id,
        productId: (data as any).product_id || "",
        productName: `${tokens} Token Pack`,
        amount: (data as any).amount || 0,
        currency: (data as any).currency || "usd",
        tokens,
      });
      
      return new Response("OK", { status: 200 });
    }
    
    if (type === "checkout.updated") {
      const checkoutData = data as any;
      
      // Only process if checkout is succeeded/confirmed
      if (checkoutData.status === "succeeded" || checkoutData.status === "confirmed") {
        console.log("[Polar Webhook] Checkout succeeded:", checkoutData.id);
        
        // Find the pending purchase
        const purchase = await ctx.runQuery(internal.polarWebhook.getPendingPurchase, {
          checkoutId: checkoutData.id,
        });
        
        if (!purchase) {
          console.error("[Polar Webhook] Purchase record not found for checkout:", checkoutData.id);
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
          polarCheckoutId: checkoutData.id,
          polarProductId: purchase.productId,
          description: `Purchased ${purchase.productName}`,
        });
        
        console.log(`[Polar Webhook] Credited ${purchase.tokens} tokens to user ${purchase.userId}`);
      }
      
      return new Response("OK", { status: 200 });
    }
    
    // Unknown event type
    console.log("[Polar Webhook] Unhandled event type:", type);
    return new Response("OK", { status: 200 });
    
  } catch (error) {
    if (error instanceof Error && (error.message.includes('signature') || error.message.includes('Invalid signature'))) {
      console.error("[Polar Webhook] Verification failed:", error.message);
      return new Response("Unauthorized", { status: 401 });
    }
    console.error("[Polar Webhook] Error processing webhook:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});

// Internal mutation to create a pending purchase
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
      userId: args.userId,
      checkoutId: args.checkoutId,
      productId: args.productId,
      productName: args.productName,
      amount: args.amount,
      currency: args.currency,
      tokens: args.tokens,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

// Internal query to get a pending purchase by checkout ID
export const getPendingPurchase = internalQuery({
  args: {
    checkoutId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("polarPurchases")
      .withIndex("by_checkout", (q) => q.eq("checkoutId", args.checkoutId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .first();
  },
});

// Internal mutation to mark a purchase as completed
export const completePurchase = internalMutation({
  args: {
    purchaseId: v.id("polarPurchases"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.patch(args.purchaseId, {
      status: "completed",
      completedAt: Date.now(),
    });
  },
});