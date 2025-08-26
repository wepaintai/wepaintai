import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Update user presence in a session
 */
export const updatePresence = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    userName: v.string(),
    cursorX: v.number(),
    cursorY: v.number(),
    isDrawing: v.boolean(),
    currentTool: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    
    // Find existing presence record
    const existingPresence = await ctx.db
      .query("userPresence")
      .withIndex("by_user_session", (q) => 
        q.eq("userId", args.userId).eq("sessionId", args.sessionId)
      )
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
        userId: args.userId,
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
        userId: args.userId,
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
    if (!session) return [];
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
          .first();
        if (!user || session.createdBy !== user._id) {
          if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return [];
        }
      } else {
        if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return [];
      }
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
    userName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const presence = await ctx.db
      .query("userPresence")
      .withIndex("by_user_session", (q) => 
        q.eq("userId", args.userId).eq("sessionId", args.sessionId)
      )
      .first();

    if (presence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});

/**
 * Clean up old presence records (internal function)
 */
export const cleanupOldPresence = mutation({
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
