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
