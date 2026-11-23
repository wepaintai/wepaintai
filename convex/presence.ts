import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { assertCanModifySession, canReadSession, resolveAuthenticatedUser } from "./sessionAuth";

/**
 * Update user presence in a session
 */
export const updatePresence = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
    userColor: v.string(),
    userName: v.string(),
    cursorX: v.number(),
    cursorY: v.number(),
    isDrawing: v.boolean(),
    currentTool: v.string(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    const { user } = await assertCanModifySession(ctx, session, args.guestKey);

    if (args.userId && (!user || user._id !== args.userId)) {
      throw new Error("Unauthorized");
    }
    const effectiveUserId = user?._id;
    const effectiveGuestId = effectiveUserId ? undefined : args.guestId;

    const now = Date.now();

    // Find existing presence record. Guests all have userId undefined, so they
    // are keyed by their stable per-browser guestId instead.
    const existingPresence = effectiveUserId
      ? await ctx.db
          .query("userPresence")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", effectiveUserId).eq("sessionId", args.sessionId)
          )
          .first()
      : effectiveGuestId
        ? await ctx.db
            .query("userPresence")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", effectiveGuestId).eq("sessionId", args.sessionId)
            )
            .first()
        : await ctx.db
            .query("userPresence")
            .withIndex("by_user_session", (q) =>
              q.eq("userId", undefined).eq("sessionId", args.sessionId)
            )
            .filter((q) => q.eq(q.field("guestId"), undefined))
            .first();

    if (existingPresence) {
      // If an identical update arrived within a short window, skip writing to reduce conflicts
      const recentlyUpdated = now - (existingPresence.lastSeen || 0) < 200;
      const noChange =
        existingPresence.cursorX === args.cursorX &&
        existingPresence.cursorY === args.cursorY &&
        existingPresence.isDrawing === args.isDrawing &&
        existingPresence.currentTool === args.currentTool &&
        existingPresence.userColor === args.userColor &&
        existingPresence.userName === args.userName;
      if (recentlyUpdated && noChange) {
        return null;
      }
      // Replace the entire document to avoid conflicts
      await ctx.db.replace(existingPresence._id, {
        sessionId: args.sessionId,
        userId: effectiveUserId,
        guestId: effectiveGuestId,
        userColor: args.userColor,
        userName: args.userName,
        cursorX: args.cursorX,
        cursorY: args.cursorY,
        isDrawing: args.isDrawing,
        currentTool: args.currentTool,
        lastSeen: now,
      });
    } else {
      // Create new presence record
      await ctx.db.insert("userPresence", {
        sessionId: args.sessionId,
        userId: effectiveUserId,
        guestId: effectiveGuestId,
        userColor: args.userColor,
        userName: args.userName,
        cursorX: args.cursorX,
        cursorY: args.cursorY,
        isDrawing: args.isDrawing,
        currentTool: args.currentTool,
        lastSeen: now,
      });
    }

    return null;
  },
});

/**
 * Get all active users in a session
 */
export const getSessionPresence = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("userPresence"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
    userColor: v.string(),
    userName: v.string(),
    cursorX: v.number(),
    cursorY: v.number(),
    isDrawing: v.boolean(),
    currentTool: v.string(),
    lastSeen: v.number(),
  })),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey))) {
      return [];
    }
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000; // 5 minutes
    
    return await ctx.db
      .query("userPresence")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.gt(q.field("lastSeen"), fiveMinutesAgo))
      .collect();
  },
});

/**
 * Remove user from session (when they leave)
 */
export const leaveSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
    userName: v.optional(v.string()),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    let user: Awaited<ReturnType<typeof resolveAuthenticatedUser>>;
    if (session && session.deletedAt === undefined) {
      ({ user } = await assertCanModifySession(ctx, session, args.guestKey));
    } else {
      user = await resolveAuthenticatedUser(ctx);
      // If session is gone/deleted, only allow authenticated callers to clean
      // up their own presence row rather than arbitrary records.
      if (!user && !args.guestKey) {
        return null;
      }
    }

    if (args.userId && (!user || user._id !== args.userId)) {
      throw new Error("Unauthorized");
    }
    const effectiveUserId = user?._id;
    const effectiveGuestId = effectiveUserId ? undefined : args.guestId;

    const presence = effectiveUserId
      ? await ctx.db
          .query("userPresence")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", effectiveUserId).eq("sessionId", args.sessionId)
          )
          .first()
      : effectiveGuestId
        ? await ctx.db
            .query("userPresence")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", effectiveGuestId).eq("sessionId", args.sessionId)
            )
            .first()
        : null;

    if (presence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});

/**
 * Best-effort leave fired via navigator.sendBeacon on pagehide (tab close /
 * navigation away), routed through an HTTP action. Takes raw strings because
 * beacon payloads are untyped; invalid ids are ignored. Removes the caller's
 * presence row and any in-progress live stroke so collaborators don't see a
 * ghost user or a frozen partial stroke.
 */
export const beaconLeave = internalMutation({
  args: {
    sessionId: v.string(),
    userId: v.optional(v.string()),
    guestId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("paintingSessions", args.sessionId);
    if (!sessionId) return null;
    const userId = args.userId
      ? ctx.db.normalizeId("users", args.userId)
      : null;
    if (args.userId && !userId) return null;

    const presence = userId
      ? await ctx.db
          .query("userPresence")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", userId).eq("sessionId", sessionId)
          )
          .first()
      : args.guestId
        ? await ctx.db
            .query("userPresence")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", args.guestId).eq("sessionId", sessionId)
            )
            .first()
        : null;
    if (presence) {
      await ctx.db.delete(presence._id);
    }

    const liveStroke = userId
      ? await ctx.db
          .query("liveStrokes")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", userId).eq("sessionId", sessionId)
          )
          .first()
      : args.guestId
        ? await ctx.db
            .query("liveStrokes")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", args.guestId).eq("sessionId", sessionId)
            )
            .first()
        : null;
    if (liveStroke) {
      await ctx.db.delete(liveStroke._id);
    }

    return null;
  },
});

/**
 * Clean up old presence records (internal function).
 * Internal-only duplicate of the cron-driven cleanup; never client-callable.
 */
export const cleanupOldPresence = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // 1 hour
    
    const oldPresence = await ctx.db
      .query("userPresence")
      .filter((q) => q.lt(q.field("lastSeen"), oneHourAgo))
      .collect();

    for (const presence of oldPresence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});

/**
 * Internal cron-safe cleanup for old presence records
 */
export const cleanupOldPresenceInternal = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // 1 hour
    
    const oldPresence = await ctx.db
      .query("userPresence")
      .filter((q) => q.lt(q.field("lastSeen"), oneHourAgo))
      .collect();

    for (const presence of oldPresence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});
