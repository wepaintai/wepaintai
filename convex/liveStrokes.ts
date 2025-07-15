import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Update or create a live stroke for a user
 */
export const updateLiveStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    userName: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    
    // Find existing live stroke for this user in this session
    const existingLiveStroke = await ctx.db
      .query("liveStrokes")
      .withIndex("by_user_session", (q) => 
        q.eq("userId", args.userId).eq("sessionId", args.sessionId)
      )
      .first();

    if (existingLiveStroke) {
      // Update existing live stroke
      await ctx.db.patch(existingLiveStroke._id, {
        userColor: args.userColor,
        userName: args.userName,
        points: args.points,
        brushColor: args.brushColor,
        brushSize: args.brushSize,
        opacity: args.opacity,
        colorMode: args.colorMode,
        lastUpdated: now,
      });
    } else {
      // Create new live stroke
      await ctx.db.insert("liveStrokes", {
        sessionId: args.sessionId,
        userId: args.userId,
        userColor: args.userColor,
        userName: args.userName,
        points: args.points,
        brushColor: args.brushColor,
        brushSize: args.brushSize,
        opacity: args.opacity,
        colorMode: args.colorMode,
        lastUpdated: now,
      });
    }

    return null;
  },
});

/**
 * Get all active live strokes for a session
 */
export const getLiveStrokes = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.array(v.object({
    _id: v.id("liveStrokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    userName: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
    lastUpdated: v.number(),
  })),
  handler: async (ctx, args) => {
    const thirtySecondsAgo = Date.now() - 30 * 1000; // 30 seconds
    
    return await ctx.db
      .query("liveStrokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.gt(q.field("lastUpdated"), thirtySecondsAgo))
      .collect();
  },
});

/**
 * Clear a user's live stroke when they finish drawing
 */
export const clearLiveStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const liveStroke = await ctx.db
      .query("liveStrokes")
      .withIndex("by_user_session", (q) => 
        q.eq("userId", args.userId).eq("sessionId", args.sessionId)
      )
      .first();

    if (liveStroke) {
      await ctx.db.delete(liveStroke._id);
    }

    return null;
  },
});

/**
 * Clean up stale live strokes (older than 30 seconds)
 */
export const cleanupStaleLiveStrokes = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const thirtySecondsAgo = Date.now() - 30 * 1000; // 30 seconds
    
    const staleLiveStrokes = await ctx.db
      .query("liveStrokes")
      .filter((q) => q.lt(q.field("lastUpdated"), thirtySecondsAgo))
      .collect();

    for (const liveStroke of staleLiveStrokes) {
      await ctx.db.delete(liveStroke._id);
    }

    return null;
  },
});

/**
 * Clear all live strokes for a session (useful when clearing the canvas)
 */
export const clearSessionLiveStrokes = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const liveStrokes = await ctx.db
      .query("liveStrokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    for (const liveStroke of liveStrokes) {
      await ctx.db.delete(liveStroke._id);
    }

    return null;
  },
});
