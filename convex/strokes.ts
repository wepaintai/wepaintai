import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Add a new stroke to a painting session
 */
export const addStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.id("paintLayers")), // Layer to add stroke to
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
    
    // Update recent stroke orders for quick undo access
    const recentOrders = session.recentStrokeOrders || [];
    const updatedRecentOrders = [...recentOrders, strokeOrder].slice(-10); // Keep last 10
    
    await ctx.db.patch(args.sessionId, {
      strokeCounter: strokeOrder,
      recentStrokeOrders: updatedRecentOrders,
    });

    // If no layerId provided, ensure a default layer exists
    let layerId = args.layerId;
    if (!layerId) {
      // Check for existing paint layers
      const defaultLayer = await ctx.db
        .query("paintLayers")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .first();
      
      if (defaultLayer) {
        layerId = defaultLayer._id;
      } else {
        // Create a default layer if none exists
        layerId = await ctx.db.insert("paintLayers", {
          sessionId: args.sessionId,
          name: "Layer 1",
          layerOrder: 0,
          visible: true,
          opacity: 1,
          createdBy: args.userId,
          createdAt: Date.now(),
        });
      }
    }

    // Insert the stroke
    const strokeId = await ctx.db.insert("strokes", {
      sessionId: args.sessionId,
      layerId,
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
    layerId: v.optional(v.id("paintLayers")),
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
 * Get strokes for a specific layer
 */
export const getLayerStrokes = query({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.id("paintLayers"),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.id("paintLayers")),
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
      .withIndex("by_layer", (q) => 
        q.eq("sessionId", args.sessionId).eq("layerId", args.layerId)
      )
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
    layerId: v.optional(v.id("paintLayers")),
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

    // Get the stroke with the highest strokeOrder using the existing index
    const lastStroke = await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .first();

    if (!lastStroke) {
      return false; // No strokes to remove
    }

    // Save the stroke to deletedStrokes before deleting
    await ctx.db.insert("deletedStrokes", {
      sessionId: lastStroke.sessionId,
      layerId: lastStroke.layerId,
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
    
    // Update recent stroke orders and deleted count
    const recentOrders = session.recentStrokeOrders || [];
    const updatedRecentOrders = recentOrders.filter(order => order !== lastStroke.strokeOrder);
    const deletedCount = (session.deletedStrokeCount || 0) + 1;
    
    await ctx.db.patch(args.sessionId, {
      recentStrokeOrders: updatedRecentOrders,
      deletedStrokeCount: deletedCount,
    });

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

    // Get the most recently deleted stroke using the existing index
    const lastDeletedStroke = await ctx.db
      .query("deletedStrokes")
      .withIndex("by_session_deleted", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .first();

    if (!lastDeletedStroke) {
      return false; // No deleted strokes to restore
    }

    // Restore the stroke to the strokes table
    await ctx.db.insert("strokes", {
      sessionId: lastDeletedStroke.sessionId,
      layerId: lastDeletedStroke.layerId,
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
    
    // Update recent stroke orders and deleted count
    const recentOrders = session.recentStrokeOrders || [];
    const updatedRecentOrders = [...recentOrders, lastDeletedStroke.strokeOrder]
      .sort((a, b) => a - b)
      .slice(-10); // Keep last 10 in order
    const deletedCount = Math.max(0, (session.deletedStrokeCount || 1) - 1);
    
    await ctx.db.patch(args.sessionId, {
      recentStrokeOrders: updatedRecentOrders,
      deletedStrokeCount: deletedCount,
    });

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
      layerId: stroke.layerId,
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

    // Reset the stroke counter and caches
    await ctx.db.patch(args.sessionId, {
      strokeCounter: 0,
      recentStrokeOrders: [],
      deletedStrokeCount: 0,
    });

    return null;
  },
});

/**
 * Get undo/redo availability for a session (optimized using cache)
 */
export const getUndoRedoAvailability = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.object({
    canUndo: v.boolean(),
    canRedo: v.boolean(),
    strokeCount: v.number(),
    deletedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return {
        canUndo: false,
        canRedo: false,
        strokeCount: 0,
        deletedCount: 0,
      };
    }

    const recentOrders = session.recentStrokeOrders || [];
    const deletedCount = session.deletedStrokeCount || 0;
    
    // If we have recent orders cached, we know we can undo
    const canUndo = recentOrders.length > 0 || session.strokeCounter > 0;
    const canRedo = deletedCount > 0;
    
    return {
      canUndo,
      canRedo,
      strokeCount: session.strokeCounter,
      deletedCount,
    };
  },
});
