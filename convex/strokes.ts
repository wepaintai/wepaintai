import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Add a new stroke to a painting session
 */
export const addStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    isEraser: v.optional(v.boolean()),
  },
  returns: v.id("strokes"),
  handler: async (ctx, args) => {
    // Get the session to increment stroke counter
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Increment stroke counter for ordering
    const strokeOrder = session.strokeCounter + 1;
    await ctx.db.patch(args.sessionId, {
      strokeCounter: strokeOrder,
    });

    // Insert the stroke
    const strokeId = await ctx.db.insert("strokes", {
      sessionId: args.sessionId,
      userId: args.userId,
      userColor: args.userColor,
      points: args.points,
      brushColor: args.brushColor,
      brushSize: args.brushSize,
      opacity: args.opacity,
      strokeOrder,
      isEraser: args.isEraser,
    });

    return strokeId;
  },
});

/**
 * Get all strokes for a session
 */
export const getSessionStrokes = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(),
    isEraser: v.optional(v.boolean()),
  })),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
  },
});

/**
 * Get strokes after a certain order number (for incremental updates)
 */
export const getStrokesAfter = query({
  args: {
    sessionId: v.id("paintingSessions"),
    afterStrokeOrder: v.number(),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(),
    isEraser: v.optional(v.boolean()),
  })),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => 
        q.eq("sessionId", args.sessionId)
         .gt("strokeOrder", args.afterStrokeOrder)
      )
      .collect();
  },
});

/**
 * Remove the last stroke from a painting session (undo)
 */
export const removeLastStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Get the session to verify it exists
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Get all strokes for this session, sorted by strokeOrder
    const strokes = await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    if (strokes.length === 0) {
      return false; // No strokes to remove
    }

    // Find the stroke with the highest strokeOrder
    const lastStroke = strokes.reduce((latest, stroke) => 
      stroke.strokeOrder > latest.strokeOrder ? stroke : latest
    );

    // Save the stroke to deletedStrokes before deleting
    await ctx.db.insert("deletedStrokes", {
      sessionId: lastStroke.sessionId,
      userId: lastStroke.userId,
      userColor: lastStroke.userColor,
      points: lastStroke.points,
      brushColor: lastStroke.brushColor,
      brushSize: lastStroke.brushSize,
      opacity: lastStroke.opacity,
      strokeOrder: lastStroke.strokeOrder,
      isEraser: lastStroke.isEraser,
      deletedAt: Date.now(),
    });

    // Delete the last stroke
    await ctx.db.delete(lastStroke._id);

    return true;
  },
});

/**
 * Restore the last deleted stroke (redo)
 */
export const restoreLastDeletedStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Get the session to verify it exists
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Get all deleted strokes for this session, sorted by deletedAt
    const deletedStrokes = await ctx.db
      .query("deletedStrokes")
      .withIndex("by_session_deleted", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    if (deletedStrokes.length === 0) {
      return false; // No deleted strokes to restore
    }

    // Find the most recently deleted stroke
    const lastDeletedStroke = deletedStrokes.reduce((latest, stroke) => 
      stroke.deletedAt > latest.deletedAt ? stroke : latest
    );

    // Restore the stroke to the strokes table
    await ctx.db.insert("strokes", {
      sessionId: lastDeletedStroke.sessionId,
      userId: lastDeletedStroke.userId,
      userColor: lastDeletedStroke.userColor,
      points: lastDeletedStroke.points,
      brushColor: lastDeletedStroke.brushColor,
      brushSize: lastDeletedStroke.brushSize,
      opacity: lastDeletedStroke.opacity,
      strokeOrder: lastDeletedStroke.strokeOrder,
      isEraser: lastDeletedStroke.isEraser,
    });

    // Remove from deleted strokes
    await ctx.db.delete(lastDeletedStroke._id);

    return true;
  },
});

/**
 * Delete a specific stroke
 */
export const deleteStroke = mutation({
  args: {
    strokeId: v.id("strokes"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Get the stroke to verify it exists
    const stroke = await ctx.db.get(args.strokeId);
    if (!stroke) {
      return false; // Stroke not found
    }

    // Save the stroke to deletedStrokes before deleting
    await ctx.db.insert("deletedStrokes", {
      sessionId: stroke.sessionId,
      userId: stroke.userId,
      userColor: stroke.userColor,
      points: stroke.points,
      brushColor: stroke.brushColor,
      brushSize: stroke.brushSize,
      opacity: stroke.opacity,
      strokeOrder: stroke.strokeOrder,
      isEraser: stroke.isEraser,
      deletedAt: Date.now(),
    });

    // Delete the stroke
    await ctx.db.delete(stroke._id);

    return true;
  },
});

/**
 * Clear all strokes from a painting session
 */
export const clearSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get the session to verify it exists
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Get all strokes for this session
    const strokes = await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // Delete all strokes
    for (const stroke of strokes) {
      await ctx.db.delete(stroke._id);
    }

    // Get all deleted strokes for this session
    const deletedStrokes = await ctx.db
      .query("deletedStrokes")
      .withIndex("by_session_deleted", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // Delete all deleted strokes
    for (const deletedStroke of deletedStrokes) {
      await ctx.db.delete(deletedStroke._id);
    }

    // Reset the stroke counter
    await ctx.db.patch(args.sessionId, {
      strokeCounter: 0,
    });

    return null;
  },
});
