import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertCanModifySession } from "./sessionAuth";

// Query to get all paint layers for a session
export const getPaintLayers = query({
  args: { sessionId: v.id("paintingSessions"), guestKey: v.optional(v.string()) },
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
    const layers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    return layers.sort((a, b) => a.layerOrder - b.layerOrder);
  },
});

// Mutation to create a new paint layer
export const createPaintLayer = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    name: v.string(),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);

    // Get the highest layer order across ALL layer types (paint, uploaded, AI)
    // so the new layer lands on top of images too, not just other paint layers
    const existingLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    let maxOrder = existingLayers.reduce((max, layer) =>
      Math.max(max, layer.layerOrder), -1
    );
    uploadedImages.forEach(img => {
      maxOrder = Math.max(maxOrder, img.layerOrder);
    });
    aiImages.forEach(img => {
      maxOrder = Math.max(maxOrder, img.layerOrder);
    });
    
    // Create the new paint layer
    const layerId = await ctx.db.insert("paintLayers", {
      sessionId: args.sessionId,
      name: args.name,
      layerOrder: maxOrder + 1,
      visible: true,
      opacity: 1,
      createdBy: undefined, // Will be set from auth when implemented
      createdAt: Date.now(),
    });
    
    return layerId;
  },
});

// Mutation to update paint layer properties
export const updatePaintLayer = mutation({
  args: {
    layerId: v.id("paintLayers"),
    name: v.optional(v.string()),
    visible: v.optional(v.boolean()),
    opacity: v.optional(v.number()),
    // Allow transforms here for convenience
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    // Legacy uniform scale (will also set scaleX/scaleY if provided)
    scale: v.optional(v.number()),
    // New non-uniform scales
    scaleX: v.optional(v.number()),
    scaleY: v.optional(v.number()),
    rotation: v.optional(v.number()),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const layer = await ctx.db.get(args.layerId);
    if (!layer) throw new Error("Layer not found");
    const session = await ctx.db.get(layer.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);

    const { layerId, guestKey: _guestKey, ...updates } = args;
    
    // Remove undefined values
    const cleanUpdates: any = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );
    // If legacy scale provided, mirror to scaleX/scaleY
    if (cleanUpdates.scale !== undefined) {
      cleanUpdates.scaleX = cleanUpdates.scale;
      cleanUpdates.scaleY = cleanUpdates.scale;
    }
    
    if (Object.keys(cleanUpdates).length > 0) {
      await ctx.db.patch(layerId, cleanUpdates);
    }
    
    return layerId;
  },
});

// Dedicated transform updater (optional separate API)
export const updatePaintLayerTransform = mutation({
  args: {
    layerId: v.id("paintLayers"),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    // Legacy uniform scale (will also set scaleX/scaleY if provided)
    scale: v.optional(v.number()),
    // New non-uniform scales
    scaleX: v.optional(v.number()),
    scaleY: v.optional(v.number()),
    rotation: v.optional(v.number()),
    opacity: v.optional(v.number()),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const layer = await ctx.db.get(args.layerId);
    if (!layer) throw new Error("Layer not found");
    const session = await ctx.db.get(layer.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);

    const { layerId, guestKey: _guestKey, ...updates } = args;
    const updateFields: any = {};
    if (updates.x !== undefined) updateFields.x = updates.x;
    if (updates.y !== undefined) updateFields.y = updates.y;
    if (updates.scale !== undefined) {
      updateFields.scale = updates.scale;
      updateFields.scaleX = updates.scale;
      updateFields.scaleY = updates.scale;
    }
    if (updates.scaleX !== undefined) updateFields.scaleX = updates.scaleX;
    if (updates.scaleY !== undefined) updateFields.scaleY = updates.scaleY;
    if (updates.rotation !== undefined) updateFields.rotation = updates.rotation;
    if (updates.opacity !== undefined) updateFields.opacity = updates.opacity;
    if (Object.keys(updateFields).length > 0) {
      await ctx.db.patch(layerId, updateFields);
    }
    return layerId;
  },
});

// Mutation to delete a paint layer and its strokes
export const deletePaintLayer = mutation({
  args: {
    layerId: v.id("paintLayers"),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get the layer to delete
    const layer = await ctx.db.get(args.layerId);
    if (!layer) {
      throw new Error("Layer not found");
    }
    const session = await ctx.db.get(layer.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);
    
    // Check if this is the last paint layer
    const allPaintLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", layer.sessionId))
      .collect();
    
    if (allPaintLayers.length <= 1) {
      throw new Error("Cannot delete the last paint layer");
    }
    
    // Delete all strokes associated with this layer
    const strokes = await ctx.db
      .query("strokes")
      .withIndex("by_layer", (q) => 
        q.eq("sessionId", layer.sessionId).eq("layerId", args.layerId)
      )
      .collect();
    
    for (const stroke of strokes) {
      await ctx.db.delete(stroke._id);
    }
    
    // Delete the layer
    await ctx.db.delete(args.layerId);
    
    // Reorder remaining layers to fill the gap
    const remainingLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", layer.sessionId))
      .collect();
    
    const sortedLayers = remainingLayers
      .sort((a, b) => a.layerOrder - b.layerOrder);
    
    // Update layer orders to be sequential
    for (let i = 0; i < sortedLayers.length; i++) {
      if (sortedLayers[i].layerOrder !== i) {
        await ctx.db.patch(sortedLayers[i]._id, { layerOrder: i });
      }
    }
  },
});

// Mutation to reorder paint layers
export const reorderPaintLayer = mutation({
  args: {
    layerId: v.id("paintLayers"),
    newOrder: v.number(),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const layer = await ctx.db.get(args.layerId);
    if (!layer) {
      throw new Error("Layer not found");
    }
    const session = await ctx.db.get(layer.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);
    
    const oldOrder = layer.layerOrder;
    if (oldOrder === args.newOrder) {
      return; // No change needed
    }
    
    // Get all layers for this session
    const allLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", layer.sessionId))
      .collect();
    
    // Sort by current order
    allLayers.sort((a, b) => a.layerOrder - b.layerOrder);
    
    // Remove the layer from its current position
    const layerIndex = allLayers.findIndex(l => l._id === args.layerId);
    const [movedLayer] = allLayers.splice(layerIndex, 1);
    
    // Insert at new position
    allLayers.splice(args.newOrder, 0, movedLayer);
    
    // Update all layer orders
    for (let i = 0; i < allLayers.length; i++) {
      if (allLayers[i].layerOrder !== i) {
        await ctx.db.patch(allLayers[i]._id, { layerOrder: i });
      }
    }
  },
});

// Mutation to merge two paint layers
export const mergePaintLayers = mutation({
  args: {
    sourceLayerId: v.id("paintLayers"),
    targetLayerId: v.id("paintLayers"),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.sourceLayerId === args.targetLayerId) {
      throw new Error("Cannot merge a layer with itself");
    }
    
    // Get both layers
    const sourceLayer = await ctx.db.get(args.sourceLayerId);
    const targetLayer = await ctx.db.get(args.targetLayerId);
    
    if (!sourceLayer || !targetLayer) {
      throw new Error("One or both layers not found");
    }
    
    if (sourceLayer.sessionId !== targetLayer.sessionId) {
      throw new Error("Layers must belong to the same session");
    }
    const session = await ctx.db.get(sourceLayer.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);
    
    // Get all strokes from source layer
    const sourceStrokes = await ctx.db
      .query("strokes")
      .withIndex("by_layer", (q) => 
        q.eq("sessionId", sourceLayer.sessionId).eq("layerId", args.sourceLayerId)
      )
      .collect();
    
    // Update all source strokes to point to target layer
    for (const stroke of sourceStrokes) {
      await ctx.db.patch(stroke._id, { layerId: args.targetLayerId });
    }
    
    // Delete the source layer
    await ctx.db.delete(args.sourceLayerId);
    
    // Reorder remaining layers
    const remainingLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", sourceLayer.sessionId))
      .collect();
    
    const sortedLayers = remainingLayers
      .sort((a, b) => a.layerOrder - b.layerOrder);
    
    // Update layer orders to be sequential
    for (let i = 0; i < sortedLayers.length; i++) {
      if (sortedLayers[i].layerOrder !== i) {
        await ctx.db.patch(sortedLayers[i]._id, { layerOrder: i });
      }
    }
  },
});

// Mutation to ensure a default paint layer exists for a session
export const ensureDefaultPaintLayer = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey);

    // Check if any paint layers exist for this session
    const existingLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    
    if (!existingLayers) {
      // Create a default paint layer
      const layerId = await ctx.db.insert("paintLayers", {
        sessionId: args.sessionId,
        name: "Layer 1",
        layerOrder: 0,
        visible: true,
        opacity: 1,
        createdBy: undefined,
        createdAt: Date.now(),
      });
      
      return layerId;
    }
    
    return existingLayers._id;
  },
});
