import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Get paint layer settings for a session
export const getPaintLayerSettings = query({
  args: { sessionId: v.id("paintingSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    
    // Return default settings if not stored
    return {
      layerOrder: session.paintLayerOrder ?? 0,
      visible: session.paintLayerVisible ?? true,
    };
  },
});

// Update paint layer order
export const updatePaintLayerOrder = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    newLayerOrder: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    
    // Get all images to validate order range
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    // Total layers including paint layer
    const totalLayers = uploadedImages.length + aiImages.length + 1;
    
    // Clamp the new order to valid range
    const clampedOrder = Math.max(0, Math.min(args.newLayerOrder, totalLayers - 1));
    
    // Get current paint layer order
    const currentPaintOrder = session.paintLayerOrder ?? 0;
    
    // If order hasn't changed, return early
    if (currentPaintOrder === clampedOrder) return;
    
    // Combine all images
    const allImages = [
      ...uploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
      ...aiImages.map(img => ({ ...img, type: 'ai' as const }))
    ];
    
    // Adjust image orders based on paint layer movement
    await Promise.all(
      allImages.map(async (img) => {
        let newImageOrder = img.layerOrder;
        
        if (currentPaintOrder < clampedOrder) {
          // Paint layer moving up
          if (img.layerOrder > currentPaintOrder && img.layerOrder <= clampedOrder) {
            newImageOrder = img.layerOrder - 1;
          }
        } else {
          // Paint layer moving down
          if (img.layerOrder >= clampedOrder && img.layerOrder < currentPaintOrder) {
            newImageOrder = img.layerOrder + 1;
          }
        }
        
        if (newImageOrder !== img.layerOrder) {
          if (img.type === 'uploaded') {
            await ctx.db.patch(img._id, { layerOrder: newImageOrder });
          } else {
            await ctx.db.patch(img._id, { layerOrder: newImageOrder });
          }
        }
      })
    );
    
    // Update paint layer order on session
    await ctx.db.patch(args.sessionId, {
      paintLayerOrder: clampedOrder,
    });
  },
});

// Update paint layer visibility
export const updatePaintLayerVisibility = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    visible: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    
    await ctx.db.patch(args.sessionId, {
      paintLayerVisible: args.visible,
    });
  },
});

// Normalize layer orders for a session (ensures sequential 0...n-1 ordering)
export const normalizeLayerOrders = mutation({
  args: { sessionId: v.id("paintingSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    
    // Get all images
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    // Get paint layer order
    const paintLayerOrder = session.paintLayerOrder ?? 0;
    
    // Combine all layers including paint
    const allLayers = [
      { id: 'paint', type: 'paint' as const, layerOrder: paintLayerOrder },
      ...uploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
      ...aiImages.map(img => ({ ...img, type: 'ai' as const }))
    ].sort((a, b) => a.layerOrder - b.layerOrder);
    
    // Reassign sequential orders
    await Promise.all(
      allLayers.map(async (layer, index) => {
        if (layer.type === 'paint') {
          await ctx.db.patch(args.sessionId, {
            paintLayerOrder: index,
          });
        } else if (layer.type === 'uploaded') {
          await ctx.db.patch(layer._id, { layerOrder: index });
        } else {
          await ctx.db.patch(layer._id, { layerOrder: index });
        }
      })
    );
  },
});