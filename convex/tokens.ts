import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  assertPositiveTokenAmount,
  assertValidTokenBalance,
  createTokenOperationKey,
  getTokenCost,
  type TokenOperationType,
} from "./tokenPolicy";

const tokenOperationValidator = v.union(
  v.literal("ai-generation"),
  v.literal("background-removal"),
  v.literal("image-merge"),
);

// Get user's current token balance
export const getTokenBalance = query({
  args: {},
  handler: async (ctx) => {
    console.log("[getTokenBalance] Starting query");
    
    // Return null immediately if running in an environment without auth
    // This prevents any auth-related errors from being thrown
    if (typeof ctx.auth === 'undefined') {
      console.log("[getTokenBalance] Running without auth context");
      return null;
    }
    
    try {
      // Check if auth is available
      if (!ctx.auth || typeof ctx.auth.getUserIdentity !== 'function') {
        console.log("[getTokenBalance] Auth not properly configured");
        return null;
      }
      
      let identity;
      try {
        identity = await ctx.auth.getUserIdentity();
      } catch (authError) {
        console.log("[getTokenBalance] Auth error:", authError);
        return null;
      }
      
      if (!identity) {
        // Return null for unauthenticated users
        return null;
      }

      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
        .first();

      if (!user) {
        return null;
      }

      return {
        tokens: user.tokens ?? 0,
        lifetimeUsed: user.lifetimeTokensUsed ?? 0,
      };
    } catch (error) {
      // Log error details for debugging
      console.error("[getTokenBalance] Error details:", {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        error
      });
      // Return null on any error to prevent crashes
      return null;
    }
  },
});

// Get user's token transaction history
export const getTokenHistory = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (!user) return [];

    const rawLimit = args.limit ?? 50;
    const limit = Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
      : 50;
    const transactions = await ctx.db
      .query("tokenTransactions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return transactions;
  },
});

// Token consumption is internal-only. Callers identify the completed operation;
// this mutation owns the price, authentication, and idempotency policy.
export const consumeTokensForOperation = internalMutation({
  args: {
    operationId: v.string(),
    operationType: tokenOperationValidator,
    sessionId: v.optional(v.id("paintingSessions")),
    targetLayerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found");
    }

    const operationType: TokenOperationType = args.operationType;
    const operationKey = createTokenOperationKey(operationType, args.operationId);
    const existingTransaction = await ctx.db
      .query("tokenTransactions")
      .withIndex("by_user_operation", (q) =>
        q.eq("userId", user._id).eq("operationKey", operationKey),
      )
      .first();

    if (existingTransaction) {
      return { newBalance: user.tokens ?? existingTransaction.balance, charged: false };
    }

    const tokenCost = assertPositiveTokenAmount(getTokenCost(operationType));
    const currentTokens = assertValidTokenBalance(user.tokens ?? 0);
    if (currentTokens < tokenCost) {
      throw new Error("Insufficient tokens");
    }

    const newBalance = currentTokens - tokenCost;
    await ctx.db.patch(user._id, {
      tokens: newBalance,
      lifetimeTokensUsed: (user.lifetimeTokensUsed ?? 0) + tokenCost,
      updatedAt: Date.now(),
    });

    const descriptions = {
      "ai-generation": "AI image generation",
      "background-removal": "Background removal",
      "image-merge": "Image merge operation",
    } as const;

    const metadata: {
      aiGenerationId?: Id<"aiGenerations">;
      backgroundRemovalId?: string;
      imageMergeId?: Id<"imageMerges">;
      sessionId?: string;
      targetLayerId?: string;
    } = {};

    if (operationType === "ai-generation") {
      const generationId = ctx.db.normalizeId("aiGenerations", args.operationId);
      if (!generationId) throw new Error("Invalid AI generation ID");
      metadata.aiGenerationId = generationId;
    } else if (operationType === "background-removal") {
      metadata.backgroundRemovalId = args.operationId;
      metadata.sessionId = args.sessionId;
      metadata.targetLayerId = args.targetLayerId;
    } else {
      const imageMergeId = ctx.db.normalizeId("imageMerges", args.operationId);
      if (!imageMergeId) throw new Error("Invalid image merge ID");
      metadata.imageMergeId = imageMergeId;
    }

    await ctx.db.insert("tokenTransactions", {
      userId: user._id,
      operationKey,
      type: "usage",
      amount: -tokenCost,
      balance: newBalance,
      description: descriptions[operationType],
      metadata,
      createdAt: Date.now(),
    });

    return { newBalance, charged: true };
  },
});

// Idempotently refund a previously reserved/debited operation if the external
// provider fails before producing a usable result. Never credits unless a
// matching usage debit exists, and never refunds the same operation twice.
export const refundTokensForOperation = internalMutation({
  args: {
    operationId: v.string(),
    operationType: tokenOperationValidator,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found");
    }

    const operationKey = createTokenOperationKey(args.operationType, args.operationId);
    const refundKey = `refund:${operationKey}`;

    const existingRefund = await ctx.db
      .query("tokenTransactions")
      .withIndex("by_user_operation", (q) =>
        q.eq("userId", user._id).eq("operationKey", refundKey),
      )
      .first();

    if (existingRefund) {
      return { newBalance: user.tokens ?? existingRefund.balance, refunded: false };
    }

    const usageTx = await ctx.db
      .query("tokenTransactions")
      .withIndex("by_user_operation", (q) =>
        q.eq("userId", user._id).eq("operationKey", operationKey),
      )
      .first();

    if (!usageTx || usageTx.type !== "usage") {
      return { newBalance: user.tokens ?? 0, refunded: false };
    }

    const refundAmount = assertPositiveTokenAmount(Math.abs(usageTx.amount), "Refund amount");
    const currentTokens = assertValidTokenBalance(user.tokens ?? 0);
    const newBalance = assertValidTokenBalance(currentTokens + refundAmount);

    await ctx.db.patch(user._id, {
      tokens: newBalance,
      lifetimeTokensUsed: Math.max(0, (user.lifetimeTokensUsed ?? 0) - refundAmount),
      updatedAt: Date.now(),
    });

    await ctx.db.insert("tokenTransactions", {
      userId: user._id,
      operationKey: refundKey,
      type: "refund",
      amount: refundAmount,
      balance: newBalance,
      description: args.reason
        ? `Refund: ${usageTx.description} (${args.reason})`
        : `Refund: ${usageTx.description}`,
      metadata: usageTx.metadata,
      createdAt: Date.now(),
    });

    return { newBalance, refunded: true };
  },
});

// Balance checks are also internal and use the same server-owned price table.
export const hasEnoughTokensForOperation = internalQuery({
  args: {
    operationType: tokenOperationValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (!user) return false;
    const requiredTokens = assertPositiveTokenAmount(
      getTokenCost(args.operationType),
    );
    return (user.tokens ?? 0) >= requiredTokens;
  },
});
