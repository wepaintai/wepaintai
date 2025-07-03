import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Unified layer reordering that handles paint, uploaded images, and AI images
export const reorderLayer = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.string(), // Can be 'painting-layer' or an image ID
    newOrder: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    // Get all layers
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    // Get current paint layer order
    const currentPaintOrder = session.paintLayerOrder ?? 0;
    
    // Create a unified layer list
    type UnifiedLayer = {
      id: string;
      type: 'paint' | 'uploaded' | 'ai';
      order: number;
      dbId?: Id<"uploadedImages"> | Id<"aiGeneratedImages">;
    };
    
    const allLayers: UnifiedLayer[] = [
      { id: 'painting-layer', type: 'paint', order: currentPaintOrder },
      ...uploadedImages.map(img => ({ 
        id: img._id, 
        type: 'uploaded' as const, 
        order: img.layerOrder,
        dbId: img._id 
      })),
      ...aiImages.map(img => ({ 
        id: img._id, 
        type: 'ai' as const, 
        order: img.layerOrder,
        dbId: img._id 
      }))
    ];
    
    // Sort by current order
    allLayers.sort((a, b) => a.order - b.order);
    
    // Find the layer being moved
    const layerIndex = allLayers.findIndex(l => l.id === args.layerId);
    if (layerIndex === -1) throw new Error("Layer not found");
    
    const movingLayer = allLayers[layerIndex];
    const currentOrder = movingLayer.order;
    
    // Clamp new order to valid range
    const maxOrder = allLayers.length - 1;
    const targetOrder = Math.max(0, Math.min(args.newOrder, maxOrder));
    
    // If no change needed, return early
    if (currentOrder === targetOrder) return;
    
    // Determine which layers need to shift
    const updates: Array<{ layer: UnifiedLayer; newOrder: number }> = [];
    
    if (currentOrder < targetOrder) {
      // Moving up (increasing order)
      // Shift layers between current and target down
      allLayers.forEach(layer => {
        if (layer.id === args.layerId) {
          updates.push({ layer, newOrder: targetOrder });
        } else if (layer.order > currentOrder && layer.order <= targetOrder) {
          updates.push({ layer, newOrder: layer.order - 1 });
        }
      });
    } else {
      // Moving down (decreasing order)
      // Shift layers between target and current up
      allLayers.forEach(layer => {
        if (layer.id === args.layerId) {
          updates.push({ layer, newOrder: targetOrder });
        } else if (layer.order >= targetOrder && layer.order < currentOrder) {
          updates.push({ layer, newOrder: layer.order + 1 });
        }
      });
    }
    
    // Apply updates
    await Promise.all(
      updates.map(async ({ layer, newOrder }) => {
        if (layer.type === 'paint') {
          await ctx.db.patch(args.sessionId, {
            paintLayerOrder: newOrder,
          });
        } else if (layer.type === 'uploaded' && layer.dbId) {
          await ctx.db.patch(layer.dbId, { layerOrder: newOrder });
        } else if (layer.type === 'ai' && layer.dbId) {
          await ctx.db.patch(layer.dbId, { layerOrder: newOrder });
        }
      })
    );
  },
});