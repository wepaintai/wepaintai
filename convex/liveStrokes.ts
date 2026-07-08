import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { assertCanModifySession } from "./strokes";

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
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    await assertCanModifySession(ctx, session, args.guestKey);

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
    guestKey: v.optional(v.string()),
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
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
          .first();
        if (!user || session.createdBy !== user._id) {
          if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return [];
        }
      } else {
        if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return [];
      }
    }
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
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      // Session is gone; nothing to clear
      return null;
    }
    await assertCanModifySession(ctx, session, args.guestKey);

    // A caller may only clear their own live stroke: a userId-scoped stroke
    // requires the caller to be signed in as that user
    if (args.userId) {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        throw new Error("Unauthorized");
      }
      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
        .first();
      if (!user || user._id !== args.userId) {
        throw new Error("Unauthorized");
      }
    }

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
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    // Paired with strokes.clearSession — owner-only, even on public sessions
    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

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
