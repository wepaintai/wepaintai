import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Add a new stroke to a painting session
 */
export const addStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))), // Layer to add stroke to (paint, uploaded image, or AI image)
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
    guestKey: v.optional(v.string()),
  },
  returns: v.id("strokes"),
  handler: async (ctx, args) => {
    // Get the session to increment stroke counter and enforce access
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Authorization: allow if public or owner or guest owner
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
          .first();
        if (!user || session.createdBy !== user._id) {
          // Fall through to guest key check
          if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) throw new Error("Unauthorized");
        }
      } else {
        if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) throw new Error("Unauthorized");
      }
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
    guestKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))),
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
    // Authorization: allow if public or owner or guest owner
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
        // Cache warming removed from query to avoid writes in query context
        // const lastStrokes = strokes.slice(-10);
        // (No-op)
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
    layerId: v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages")),
    guestKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))),
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
    guestKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))),
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

    // If the last action was a bulk clear and there are no strokes, treat Undo as restore-all
    if (session.lastAction === 'clear' && session.lastClearBatchId) {
      const anyStroke = await ctx.db
        .query("strokes")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .first();
      if (!anyStroke) {
        const deleted = await ctx.db
          .query("deletedStrokes")
          .withIndex("by_session_deleted", (q) => q.eq("sessionId", args.sessionId))
          .collect();
        const batch = deleted.filter((d: any) => d.clearBatchId === session.lastClearBatchId);
        if (batch.length > 0) {
          const sorted = batch.sort((a, b) => a.strokeOrder - b.strokeOrder);
          let maxOrder = 0;
          const recentOrders: number[] = [];
          const recentIds: any[] = [];
          for (const s of sorted) {
            const restoredId = await ctx.db.insert("strokes", {
              sessionId: s.sessionId,
              layerId: s.layerId,
              userId: s.userId,
              userColor: s.userColor,
              points: s.points,
              brushColor: s.brushColor,
              brushSize: s.brushSize,
              opacity: s.opacity,
              strokeOrder: s.strokeOrder,
              isEraser: s.isEraser,
              colorMode: s.colorMode,
            });
            maxOrder = Math.max(maxOrder, s.strokeOrder);
            recentOrders.push(s.strokeOrder);
            recentIds.push(restoredId);
            await ctx.db.delete(s._id);
          }
          const newDeletedCount = Math.max(0, (session.deletedStrokeCount || 0) - batch.length);
          await ctx.db.patch(args.sessionId, {
            strokeCounter: maxOrder,
            recentStrokeOrders: recentOrders.sort((a, b) => a - b).slice(-10),
            recentStrokeIds: recentIds.slice(-10) as any,
            deletedStrokeCount: newDeletedCount,
            lastDeletedStrokeOrder: undefined,
            lastAction: undefined,
            lastClearBatchId: undefined,
          });
          return true;
        }
      }
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
    
    const sessionPatch: any = {
      strokeCounter: Math.max(session.strokeCounter, lastDeletedStroke.strokeOrder),
      recentStrokeOrders: updatedRecentOrders,
      recentStrokeIds: updatedRecentIds,
      deletedStrokeCount: deletedCount,
    };
    if (nextDeletedStroke) {
      sessionPatch.lastDeletedStrokeOrder = nextDeletedStroke.strokeOrder;
    }
    await ctx.db.patch(args.sessionId, sessionPatch);

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

    if (strokes.length === 0) {
      // Nothing to move, but mark last action so Undo can no-op gracefully
      await ctx.db.patch(args.sessionId, {
        lastAction: 'clear',
        lastClearBatchId: undefined,
        recentStrokeOrders: [],
        recentStrokeIds: [],
        lastDeletedStrokeOrder: undefined,
      });
      return null;
    }

    // Tag this clear with batch id and move strokes to deletedStrokes
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const s of strokes) {
      await ctx.db.insert("deletedStrokes", {
        sessionId: s.sessionId,
        layerId: s.layerId,
        userId: s.userId,
        userColor: s.userColor,
        points: s.points,
        brushColor: s.brushColor,
        brushSize: s.brushSize,
        opacity: s.opacity,
        strokeOrder: s.strokeOrder,
        isEraser: s.isEraser,
        colorMode: s.colorMode,
        deletedAt: Date.now(),
        clearBatchId: batchId,
      });
      await ctx.db.delete(s._id);
    }

    const newDeletedCount = (session.deletedStrokeCount || 0) + strokes.length;
    const lastOrder = Math.max(...strokes.map((s) => s.strokeOrder));
    await ctx.db.patch(args.sessionId, {
      strokeCounter: 0,
      recentStrokeOrders: [],
      recentStrokeIds: [],
      deletedStrokeCount: newDeletedCount,
      lastDeletedStrokeOrder: lastOrder,
      lastAction: 'clear',
      lastClearBatchId: batchId,
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
    guestKey: v.optional(v.string()),
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

    // Authorization for private sessions (view availability only if owner or guest owner)
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      let authorized = false;
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
          .first();
        authorized = !!user && session.createdBy === user._id;
      }
      if (!authorized) {
        if (!(session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey)) {
          return {
            canUndo: false,
            canRedo: false,
            strokeCount: 0,
            deletedCount: 0,
            cacheWarmed: false,
          };
        }
      }
    }

    const recentIds = session.recentStrokeIds || [];
    const recentOrders = session.recentStrokeOrders || [];
    const deletedCount = session.deletedStrokeCount || 0;
    
    // Check if cache needs warming
    const cacheWarmed = recentIds.length > 0 || session.strokeCounter === 0;
    
    // If cache is not warmed and we have strokes, warm it now
    if (!cacheWarmed && session.strokeCounter > 0) {
      // Get the last 10 strokes to compute availability quickly
      const recentStrokes = await ctx.db
        .query("strokes")
        .withIndex("by_session", (q) => 
          q.eq("sessionId", args.sessionId)
        )
        .order("desc")
        .take(10);
      
      if (recentStrokes.length > 0) {
        const sortedRecent = recentStrokes.reverse(); // Back to ascending order
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
    
    // If we have recent orders cached, we know we can undo; also allow undo after a clear
    const canUndo = (session.lastAction === 'clear') || recentOrders.length > 0 || session.strokeCounter > 0;
    const canRedo = (session.lastAction === 'clear') ? false : (deletedCount > 0);
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
