import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { assertCanModifySession } from "./sessionAuth";

/**
 * Upsert (update or insert) the acknowledged stroke order for a viewer in a session.
 */
export const upsertViewerState = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    viewerId: v.string(), // Client-generated viewer ID
    lastAckedStrokeOrder: v.number(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    await assertCanModifySession(ctx, session, args.guestKey);

    const existingState = await ctx.db
      .query("viewerStates")
      .withIndex("by_session_viewer", (q) =>
        q.eq("sessionId", args.sessionId).eq("viewerId", args.viewerId)
      )
      .first();

    if (existingState) {
      if (args.lastAckedStrokeOrder > existingState.lastAckedStrokeOrder) {
        await ctx.db.patch(existingState._id, {
          lastAckedStrokeOrder: args.lastAckedStrokeOrder,
        });
      }
    } else {
      await ctx.db.insert("viewerStates", {
        sessionId: args.sessionId,
        viewerId: args.viewerId,
        lastAckedStrokeOrder: args.lastAckedStrokeOrder,
      });
    }
    return null;
  },
});

/**
 * Get the last acknowledged stroke order for a viewer in a session.
 */
export const getViewerState = query({
  args: {
    sessionId: v.id("paintingSessions"),
    viewerId: v.string(), // Client-generated viewer ID
  },
  returns: v.union(
    v.object({
      _id: v.id("viewerStates"),
      _creationTime: v.number(),
      sessionId: v.id("paintingSessions"),
      viewerId: v.string(),
      lastAckedStrokeOrder: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("viewerStates")
      .withIndex("by_session_viewer", (q) =>
        q.eq("sessionId", args.sessionId).eq("viewerId", args.viewerId)
      )
      .first();
    return state;
  },
});

/**
 * Get all viewer states for a session (for debugging or advanced sync).
 */
export const getAllViewerStatesForSession = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.array(
    v.object({
      _id: v.id("viewerStates"),
      _creationTime: v.number(),
      sessionId: v.id("paintingSessions"),
      viewerId: v.string(),
      lastAckedStrokeOrder: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("viewerStates")
      .withIndex("by_session_viewer", (q) => q.eq("sessionId", args.sessionId))
      // Consider adding .order("desc") by lastAckedStrokeOrder or _creationTime if useful
      .collect();
  },
});

/**
 * Remove a viewer's state, e.g., when they leave a session.
 */
export const removeViewerState = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    viewerId: v.string(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    await assertCanModifySession(ctx, session, args.guestKey);

    const existingState = await ctx.db
      .query("viewerStates")
      .withIndex("by_session_viewer", (q) =>
        q.eq("sessionId", args.sessionId).eq("viewerId", args.viewerId)
      )
      .first();

    if (existingState) {
      await ctx.db.delete(existingState._id);
    }
    return null;
  },
});

/**
 * Clear all viewer states for a session (useful when clearing the canvas).
 * Internal-only: no client callers, and it would otherwise let anyone wipe a
 * session's viewer sync state.
 */
export const clearSessionViewerStates = internalMutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const viewerStates = await ctx.db
      .query("viewerStates")
      .withIndex("by_session_viewer", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    for (const viewerState of viewerStates) {
      await ctx.db.delete(viewerState._id);
    }
    return null;
  },
});
