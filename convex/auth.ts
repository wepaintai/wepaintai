import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    console.log("[getCurrentUser] Starting auth check...");
    
    // Get the user identity from Clerk
    const identity = await ctx.auth.getUserIdentity();
    console.log("[getCurrentUser] Identity from ctx.auth:", identity);
    
    if (!identity) {
      console.log("[getCurrentUser] No identity found");
      return null;
    }
    
    // Look up user by Clerk's subject (user ID)
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    console.log("[getCurrentUser] User from database:", user);
    
    return user;
  },
});

// Store user data when they sign in
export const storeUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    console.log("[storeUser] Identity:", identity);
    
    if (!identity) {
      throw new Error("Not authenticated");
    }
    
    // Check if user already exists
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (existingUser) {
      console.log("[storeUser] User already exists:", existingUser);
      // Update user info if needed
      await ctx.db.patch(existingUser._id, {
        email: identity.email,
        name: identity.name || identity.givenName || identity.email?.split("@")[0] || "User",
        updatedAt: Date.now(),
      });
      return existingUser._id;
    }
    
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
    
    console.log("[storeUser] Created new user with ID:", userId);
    
    // Record initial token grant
    await ctx.db.insert("tokenTransactions", {
      userId,
      type: "initial",
      amount: 10,
      balance: 10,
      description: "Welcome bonus - 10 free tokens",
      createdAt: Date.now(),
    });
    
    return userId;
  },
});