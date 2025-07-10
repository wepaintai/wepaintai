import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// Get user's current token balance
export const getTokenBalance = query({
  args: {},
  handler: async (ctx) => {
    try {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        // Return null for unauthenticated users
        return null;
      }

      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .first();

      if (!user) {
        // User not found in database
        return null;
      }

      return {
        tokens: user.tokens ?? 0,
        lifetimeUsed: user.lifetimeTokensUsed ?? 0,
      };
    } catch (error) {
      console.error("[getTokenBalance] Error:", error);
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
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) return [];

    const limit = args.limit ?? 50;
    const transactions = await ctx.db
      .query("tokenTransactions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return transactions;
  },
});

// Use tokens for AI generation
export const useTokensForGeneration = mutation({
  args: {
    generationId: v.id("aiGenerations"),
    tokenCost: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found");
    }

    const currentTokens = user.tokens ?? 0;
    if (currentTokens < args.tokenCost) {
      throw new Error("Insufficient tokens");
    }

    // Update user tokens
    const newBalance = currentTokens - args.tokenCost;
    await ctx.db.patch(user._id, {
      tokens: newBalance,
      lifetimeTokensUsed: (user.lifetimeTokensUsed ?? 0) + args.tokenCost,
      updatedAt: Date.now(),
    });

    // Record transaction
    await ctx.db.insert("tokenTransactions", {
      userId: user._id,
      type: "usage",
      amount: -args.tokenCost,
      balance: newBalance,
      description: "AI image generation",
      metadata: {
        aiGenerationId: args.generationId,
      },
      createdAt: Date.now(),
    });

    return { newBalance };
  },
});

// Internal mutation to credit tokens after successful Polar purchase
export const creditTokensFromPurchase = internalMutation({
  args: {
    userId: v.id("users"),
    tokens: v.number(),
    polarCheckoutId: v.string(),
    polarProductId: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentTokens = user.tokens ?? 0;
    const newBalance = currentTokens + args.tokens;

    // Update user tokens
    await ctx.db.patch(args.userId, {
      tokens: newBalance,
      updatedAt: Date.now(),
    });

    // Record transaction
    await ctx.db.insert("tokenTransactions", {
      userId: args.userId,
      type: "purchase",
      amount: args.tokens,
      balance: newBalance,
      description: args.description,
      metadata: {
        polarCheckoutId: args.polarCheckoutId,
        polarProductId: args.polarProductId,
      },
      createdAt: Date.now(),
    });

    return { newBalance };
  },
});

// Check if user has enough tokens
export const hasEnoughTokens = query({
  args: {
    requiredTokens: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) return false;

    return (user.tokens ?? 0) >= args.requiredTokens;
  },
});