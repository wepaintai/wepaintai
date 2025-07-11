import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

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
        console.log("[getTokenBalance] No identity found");
        return null;
      }

      console.log("[getTokenBalance] Querying for user with clerkId:", identity.subject);
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .first();

      if (!user) {
        // User not found in database
        console.log("[getTokenBalance] User not found in database for clerkId:", identity.subject);
        
        // Try to create the user (this handles the case where AuthSync hasn't run yet)
        try {
          console.log("[getTokenBalance] Attempting to create user...");
          
          // Create new user with initial tokens
          const userId = await ctx.db.insert("users", {
            clerkId: identity.subject,
            email: identity.email,
            name: identity.name || identity.givenName || identity.email?.split("@")[0] || "User",
            tokens: 10, // Initial 10 tokens for new users
            lifetimeTokensUsed: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          
          console.log("[getTokenBalance] Created new user with ID:", userId);
          
          // Record initial token grant
          await ctx.db.insert("tokenTransactions", {
            userId,
            type: "initial",
            amount: 10,
            balance: 10,
            description: "Welcome bonus - 10 free tokens",
            createdAt: Date.now(),
          });
          
          return {
            tokens: 10,
            lifetimeUsed: 0,
          };
        } catch (createError) {
          console.error("[getTokenBalance] Failed to create user:", createError);
          return null;
        }
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
    // Return false immediately if running in an environment without auth
    if (typeof ctx.auth === 'undefined') {
      console.log("[hasEnoughTokens] Running without auth context");
      return false;
    }
    
    try {
      // Check if auth is available
      if (!ctx.auth || typeof ctx.auth.getUserIdentity !== 'function') {
        console.log("[hasEnoughTokens] Auth not properly configured");
        return false;
      }
      
      let identity;
      try {
        identity = await ctx.auth.getUserIdentity();
      } catch (authError) {
        console.log("[hasEnoughTokens] Auth error:", authError);
        return false;
      }
      
      if (!identity) return false;

      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .first();

      if (!user) return false;

      return (user.tokens ?? 0) >= args.requiredTokens;
    } catch (error) {
      console.error("[hasEnoughTokens] Error:", error);
      return false;
    }
  },
});