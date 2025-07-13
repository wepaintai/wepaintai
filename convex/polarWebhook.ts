import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

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
  
  // Decode base64 secret (remove whsec_ prefix if present)
  const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const decodedSecret = Uint8Array.from(atob(secretKey), c => c.charCodeAt(0));
  
  // Create the signed content: msg_id.timestamp.payload
  const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
  
  // Use Web Crypto API to compute HMAC
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    decodedSecret,
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
  
  // Extract signatures from header (can be space-delimited)
  const signatures = webhookSignature.split(' ');
  let isValid = false;
  
  for (const sig of signatures) {
    if (sig === expectedSig) {
      isValid = true;
      break;
    }
  }
  
  if (!isValid) {
    console.error('[Polar Webhook] Signature verification failed');
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
  const rawBody = await request.text();
  
  try {
    // Parse headers into a plain object
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    // Log all headers for debugging
    console.log("[Polar Webhook] Received headers:", headers);
    
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