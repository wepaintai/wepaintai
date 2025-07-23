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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
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
      colorMode: args.colorMode,
    });

    // Update recent stroke orders and IDs for quick undo access
    const recentOrders = session.recentStrokeOrders || [];
    const recentIds = session.recentStrokeIds || [];
    const updatedRecentOrders = [...recentOrders, strokeOrder].slice(-10); // Keep last 10
    const updatedRecentIds = [...recentIds, strokeId].slice(-10); // Keep last 10
    
    await ctx.db.patch(args.sessionId, {
      strokeCounter: strokeOrder,
      recentStrokeOrders: updatedRecentOrders,
      recentStrokeIds: updatedRecentIds,
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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
  })),
  handler: async (ctx, args) => {
    // First, ensure session cache is populated for fast undo/redo
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return [];
    }
    
    // Use the index with order to get strokes already sorted
    const strokes = await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc") // Get strokes in strokeOrder
      .collect();
    
    // Check if session needs cache population
    if (strokes.length > 0) {
      const needsCacheUpdate = !session.recentStrokeIds || session.recentStrokeIds.length === 0;
      
      if (needsCacheUpdate) {
        // Populate cache with the last 10 strokes for faster undo
        const lastStrokes = strokes.slice(-10);
        
        await ctx.db.patch(args.sessionId, {
          recentStrokeOrders: lastStrokes.map(s => s.strokeOrder),
          recentStrokeIds: lastStrokes.map(s => s._id),
        });
      }
    }
    
    return strokes;
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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
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

    let lastStroke = null;
    
    // First try to use the cached stroke IDs for instant access
    const recentIds = session.recentStrokeIds || [];
    if (recentIds.length > 0) {
      const lastStrokeId = recentIds[recentIds.length - 1];
      lastStroke = await ctx.db.get(lastStrokeId);
      
      // If the cached stroke was deleted, clean up the cache
      if (!lastStroke) {
        const cleanedIds = recentIds.slice(0, -1);
        await ctx.db.patch(args.sessionId, {
          recentStrokeIds: cleanedIds,
          recentStrokeOrders: (session.recentStrokeOrders || []).slice(0, -1),
        });
      }
    }
    
    // If not found in cache or cache is empty, populate cache and try again
    if (!lastStroke && session.strokeCounter > 0) {
      // Get the last 10 strokes to populate cache
      const recentStrokes = await ctx.db
        .query("strokes")
        .withIndex("by_session", (q) => 
          q.eq("sessionId", args.sessionId)
        )
        .order("desc")
        .take(10);
      
      if (recentStrokes.length > 0) {
        lastStroke = recentStrokes[0];
        
        // Update cache with these strokes for future operations
        const sortedRecent = recentStrokes.reverse(); // Back to ascending order
        await ctx.db.patch(args.sessionId, {
          recentStrokeOrders: sortedRecent.map(s => s.strokeOrder),
          recentStrokeIds: sortedRecent.map(s => s._id),
        });
      }
    }

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
      colorMode: lastStroke.colorMode,
      deletedAt: Date.now(),
    });

    // Delete the last stroke
    await ctx.db.delete(lastStroke._id);
    
    // Update recent stroke orders, IDs, and deleted count
    const recentOrders = session.recentStrokeOrders || [];
    const cachedRecentIds = session.recentStrokeIds || [];
    const updatedRecentOrders = recentOrders.filter(order => order !== lastStroke.strokeOrder);
    const updatedRecentIds = cachedRecentIds.filter(id => id !== lastStroke._id);
    const deletedCount = (session.deletedStrokeCount || 0) + 1;
    
    await ctx.db.patch(args.sessionId, {
      strokeCounter: session.strokeCounter - 1,
      recentStrokeOrders: updatedRecentOrders,
      recentStrokeIds: updatedRecentIds,
      deletedStrokeCount: deletedCount,
      lastDeletedStrokeOrder: lastStroke.strokeOrder,
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

    let lastDeletedStroke = null;
    
    // Use lastDeletedStrokeOrder for direct lookup if available
    if (session.lastDeletedStrokeOrder !== undefined && session.lastDeletedStrokeOrder !== null) {
      lastDeletedStroke = await ctx.db
        .query("deletedStrokes")
        .withIndex("by_session_stroke", (q) => 
          q.eq("sessionId", args.sessionId)
           .eq("strokeOrder", session.lastDeletedStrokeOrder)
        )
        .unique();
    }
    
    // Fallback to the old method if needed
    if (!lastDeletedStroke) {
      lastDeletedStroke = await ctx.db
        .query("deletedStrokes")
        .withIndex("by_session_deleted", (q) => q.eq("sessionId", args.sessionId))
        .order("desc")
        .first();
    }

    if (!lastDeletedStroke) {
      return false; // No deleted strokes to restore
    }

    // Restore the stroke to the strokes table
    const restoredStrokeId = await ctx.db.insert("strokes", {
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
      colorMode: lastDeletedStroke.colorMode,
    });

    // Remove from deleted strokes
    await ctx.db.delete(lastDeletedStroke._id);
    
    // Update recent stroke orders, IDs, and deleted count
    const recentOrders = session.recentStrokeOrders || [];
    const recentIds = session.recentStrokeIds || [];
    const updatedRecentOrders = [...recentOrders, lastDeletedStroke.strokeOrder]
      .sort((a, b) => a - b)
      .slice(-10); // Keep last 10 in order
    const updatedRecentIds = [...recentIds, restoredStrokeId]
      .slice(-10); // Keep last 10
    const deletedCount = Math.max(0, (session.deletedStrokeCount || 1) - 1);
    
    // Find the next most recent deleted stroke for future redo operations
    const nextDeletedStroke = await ctx.db
      .query("deletedStrokes")
      .withIndex("by_session_deleted", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .first();
    
    await ctx.db.patch(args.sessionId, {
      strokeCounter: Math.max(session.strokeCounter, lastDeletedStroke.strokeOrder),
      recentStrokeOrders: updatedRecentOrders,
      recentStrokeIds: updatedRecentIds,
      deletedStrokeCount: deletedCount,
      lastDeletedStrokeOrder: nextDeletedStroke?.strokeOrder,
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
      colorMode: stroke.colorMode,
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
      recentStrokeIds: [],
      deletedStrokeCount: 0,
      lastDeletedStrokeOrder: undefined,
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
    lastStrokeId: v.optional(v.id("strokes")),
    cacheWarmed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return {
        canUndo: false,
        canRedo: false,
        strokeCount: 0,
        deletedCount: 0,
        cacheWarmed: false,
      };
    }

    const recentIds = session.recentStrokeIds || [];
    const recentOrders = session.recentStrokeOrders || [];
    const deletedCount = session.deletedStrokeCount || 0;
    
    // Check if cache needs warming
    const cacheWarmed = recentIds.length > 0 || session.strokeCounter === 0;
    
    // If cache is not warmed and we have strokes, warm it now
    if (!cacheWarmed && session.strokeCounter > 0) {
      // Get the last 10 strokes to populate cache
      const recentStrokes = await ctx.db
        .query("strokes")
        .withIndex("by_session", (q) => 
          q.eq("sessionId", args.sessionId)
        )
        .order("desc")
        .take(10);
      
      if (recentStrokes.length > 0) {
        const sortedRecent = recentStrokes.reverse(); // Back to ascending order
        await ctx.db.patch(args.sessionId, {
          recentStrokeOrders: sortedRecent.map(s => s.strokeOrder),
          recentStrokeIds: sortedRecent.map(s => s._id),
        });
        
        return {
          canUndo: true,
          canRedo: deletedCount > 0,
          strokeCount: session.strokeCounter,
          deletedCount,
          lastStrokeId: sortedRecent[sortedRecent.length - 1]._id,
          cacheWarmed: true,
        };
      }
    }
    
    // If we have recent orders cached, we know we can undo
    const canUndo = recentOrders.length > 0 || session.strokeCounter > 0;
    const canRedo = deletedCount > 0;
    const lastStrokeId = recentIds.length > 0 ? recentIds[recentIds.length - 1] : undefined;
    
    return {
      canUndo,
      canRedo,
      strokeCount: session.strokeCounter,
      deletedCount,
      lastStrokeId,
      cacheWarmed,
    };
  },
});
