import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * Create a new painting session
 */
export const createSession = mutation({
  args: {
    name: v.optional(v.string()),
    canvasWidth: v.number(),
    canvasHeight: v.number(),
    isPublic: v.optional(v.boolean()),
  },
  returns: v.id("paintingSessions"),
  handler: async (ctx, args) => {
    // Get the authenticated user ID if available
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.subject as Id<"users"> | undefined;
    
    const sessionId = await ctx.db.insert("paintingSessions", {
      name: args.name,
      createdBy: userId,
      isPublic: args.isPublic ?? true,
      canvasWidth: args.canvasWidth,
      canvasHeight: args.canvasHeight,
      strokeCounter: 0,
      paintLayerOrder: 0, // Initialize paint layer at the bottom
      paintLayerVisible: true, // Paint layer visible by default
    });
    
    return sessionId;
  },
});

/**
 * Get session details
 */
export const getSession = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.union(
    v.object({
      _id: v.id("paintingSessions"),
      _creationTime: v.number(),
      name: v.optional(v.string()),
      createdBy: v.optional(v.id("users")),
      isPublic: v.boolean(),
      canvasWidth: v.number(),
      canvasHeight: v.number(),
      strokeCounter: v.number(),
      paintLayerOrder: v.optional(v.number()),
      paintLayerVisible: v.optional(v.boolean()),
      backgroundImage: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

/**
 * List recent public sessions
 */
export const listRecentSessions = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id("paintingSessions"),
    _creationTime: v.number(),
    name: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    isPublic: v.boolean(),
    canvasWidth: v.number(),
    canvasHeight: v.number(),
    strokeCounter: v.number(),
    paintLayerOrder: v.optional(v.number()),
    paintLayerVisible: v.optional(v.boolean()),
    backgroundImage: v.optional(v.string()),
  })),
  handler: async (ctx) => {
    return await ctx.db
      .query("paintingSessions")
      .filter((q) => q.eq(q.field("isPublic"), true))
      .order("desc")
      .take(20);
  },
});
