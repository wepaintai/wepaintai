import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const addUserPrompt = mutation({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated to save prompts");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (!user) {
      throw new Error("User not found");
    }

    const existingPrompt = await ctx.db
      .query("userPrompts")
      .withIndex("by_user_prompt", (q) => 
        q.eq("userId", user._id).eq("prompt", args.prompt)
      )
      .first();

    if (existingPrompt) {
      // Update usage count and last used timestamp
      await ctx.db.patch(existingPrompt._id, {
        usageCount: existingPrompt.usageCount + 1,
        lastUsed: Date.now(),
      });
    } else {
      // Create new prompt entry
      await ctx.db.insert("userPrompts", {
        userId: user._id,
        prompt: args.prompt,
        usageCount: 1,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      });
    }
  },
});

export const getUserPrompts = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (!user) {
      return [];
    }

    const limit = args.limit || 20;
    
    // Get user's prompts sorted by last used date (most recent first)
    const prompts = await ctx.db
      .query("userPrompts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return prompts.map((p) => ({
      prompt: p.prompt,
      usageCount: p.usageCount,
      lastUsed: p.lastUsed,
    }));
  },
});

export const clearUserPrompts = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated to clear prompts");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (!user) {
      throw new Error("User not found");
    }

    // Get all user's prompts
    const prompts = await ctx.db
      .query("userPrompts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    // Delete them all
    for (const prompt of prompts) {
      await ctx.db.delete(prompt._id);
    }

    return { deleted: prompts.length };
  },
});