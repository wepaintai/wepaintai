import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { assertCanModifySession, canReadSession } from "./sessionAuth";

/**
 * Update or create a live stroke for a user
 */
export const updateLiveStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
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
    editKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    const { user } = await assertCanModifySession(ctx, session, args.guestKey, {
      editKey: args.editKey,
    });

    // Derive authenticated user attribution strictly from ctx.auth
    if (args.userId && (!user || user._id !== args.userId)) {
      throw new Error("Unauthorized");
    }
    const effectiveUserId = user?._id;
    const effectiveGuestId = effectiveUserId ? undefined : args.guestId;

    const now = Date.now();

    // Find existing live stroke for this user in this session. Guests all have
    // userId undefined, so they are keyed by their stable per-browser guestId.
    const existingLiveStroke = effectiveUserId
      ? await ctx.db
          .query("liveStrokes")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", effectiveUserId).eq("sessionId", args.sessionId)
          )
          .first()
      : effectiveGuestId
        ? await ctx.db
            .query("liveStrokes")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", effectiveGuestId).eq("sessionId", args.sessionId)
            )
            .first()
        : await ctx.db
            .query("liveStrokes")
            .withIndex("by_user_session", (q) =>
              q.eq("userId", undefined).eq("sessionId", args.sessionId)
            )
            .filter((q) => q.eq(q.field("guestId"), undefined))
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
        userId: effectiveUserId,
        guestId: effectiveGuestId,
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
    editKey: v.optional(v.string()),
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
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
    }
    const thirtySecondsAgo = Date.now() - 30 * 1000; // 30 seconds
    
    const rows = await ctx.db
      .query("liveStrokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.gt(q.field("lastUpdated"), thirtySecondsAgo))
      .collect();
    // Never expose a guest's per-browser guestId: it keys their presence and
    // live stroke, so leaking it would let others impersonate them.
    return rows.map(({ guestId: _guestId, ...stroke }) => stroke);
  },
});

/**
 * Clear a user's live stroke when they finish drawing
 */
export const clearLiveStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      // Session is gone; nothing to clear
      return null;
    }
    const { user } = await assertCanModifySession(ctx, session, args.guestKey, {
      editKey: args.editKey,
    });

    // A caller may only clear their own live stroke: a userId-scoped stroke
    // requires the caller to be signed in as that user
    if (args.userId && (!user || user._id !== args.userId)) {
      throw new Error("Unauthorized");
    }
    const effectiveUserId = user?._id;
    const effectiveGuestId = effectiveUserId ? undefined : args.guestId;

    const liveStroke = effectiveUserId
      ? await ctx.db
          .query("liveStrokes")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", effectiveUserId).eq("sessionId", args.sessionId)
          )
          .first()
      : effectiveGuestId
        ? await ctx.db
            .query("liveStrokes")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", effectiveGuestId).eq("sessionId", args.sessionId)
            )
            .first()
        : await ctx.db
            .query("liveStrokes")
            .withIndex("by_user_session", (q) =>
              q.eq("userId", undefined).eq("sessionId", args.sessionId)
            )
            .filter((q) => q.eq(q.field("guestId"), undefined))
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
