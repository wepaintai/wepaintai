import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create an anonymous user
 */
export const createAnonymousUser = mutation({
  args: {
    name: v.string(),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    // Create the user with a generated name
    const userId = await ctx.db.insert("users", {
      name: args.name,
      // Anonymous users don't have email
    });
    
    return userId;
  },
});

/**
 * Get a user by ID
 */
export const getUser = query({
  args: {
    userId: v.id("users"),
  },
  returns: v.union(
    v.object({
      _id: v.id("users"),
      _creationTime: v.number(),
      name: v.string(),
      email: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

/**
 * Update user name
 */
export const updateUserName = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      name: args.name,
    });
    return null;
  },
});