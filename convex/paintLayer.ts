import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Get paint layer settings for a session
export const getPaintLayerSettings = query({
  args: { sessionId: v.id("paintingSessions"), guestKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
          .first();
        if (!user || session.createdBy !== user._id) {
          if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return null;
        }
      } else {
        if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return null;
      }
    }
    
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
    
    const [uploadedImages, aiImages, textBlocks] = await Promise.all([
      ctx.db
        .query("uploadedImages")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect(),
      ctx.db
        .query("aiGeneratedImages")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect(),
      ctx.db
        .query("textBlocks")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect(),
    ]);

    type LayerEntry =
      | { type: 'paint'; id: Id<'paintingSessions'>; order: number }
      | { type: 'uploaded'; id: Id<'uploadedImages'>; order: number }
      | { type: 'ai'; id: Id<'aiGeneratedImages'>; order: number }
      | { type: 'text'; id: Id<'textBlocks'>; order: number };

    const allLayers: LayerEntry[] = [
      { type: 'paint', id: session._id, order: session.paintLayerOrder ?? 0 },
      ...uploadedImages.map((img) => ({ type: 'uploaded' as const, id: img._id, order: img.layerOrder })),
      ...aiImages.map((img) => ({ type: 'ai' as const, id: img._id, order: img.layerOrder })),
      ...textBlocks.map((block) => ({ type: 'text' as const, id: block._id, order: block.layerOrder })),
    ].sort((a, b) => a.order - b.order);

    const paintLayer = allLayers.find((layer) => layer.type === 'paint');
    if (!paintLayer) throw new Error("Paint layer not found");

    const currentOrder = paintLayer.order;
    const maxOrder = allLayers.length - 1;
    const targetOrder = Math.max(0, Math.min(args.newLayerOrder, maxOrder));

    if (currentOrder === targetOrder) return;

    const updates: Array<{ layer: LayerEntry; newOrder: number }> = [];

    if (currentOrder < targetOrder) {
      allLayers.forEach((layer) => {
        if (layer.type === 'paint') {
          updates.push({ layer, newOrder: targetOrder });
        } else if (layer.order > currentOrder && layer.order <= targetOrder) {
          updates.push({ layer, newOrder: layer.order - 1 });
        }
      });
    } else {
      allLayers.forEach((layer) => {
        if (layer.type === 'paint') {
          updates.push({ layer, newOrder: targetOrder });
        } else if (layer.order >= targetOrder && layer.order < currentOrder) {
          updates.push({ layer, newOrder: layer.order + 1 });
        }
      });
    }

    await Promise.all(
      updates.map(async ({ layer, newOrder }) => {
        if (layer.order === newOrder) return;
        if (layer.type === 'paint') {
          await ctx.db.patch(layer.id, { paintLayerOrder: newOrder } as any);
        } else if (layer.type === 'uploaded') {
          await ctx.db.patch(layer.id, { layerOrder: newOrder });
        } else if (layer.type === 'ai') {
          await ctx.db.patch(layer.id, { layerOrder: newOrder });
        } else {
          await ctx.db.patch(layer.id, { layerOrder: newOrder });
        }
      })
    );
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
    
    const [uploadedImages, aiImages, textBlocks] = await Promise.all([
      ctx.db
        .query("uploadedImages")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect(),
      ctx.db
        .query("aiGeneratedImages")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect(),
      ctx.db
        .query("textBlocks")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect(),
    ]);

    const paintLayerOrder = session.paintLayerOrder ?? 0;

    const allLayers = [
      { id: 'paint', type: 'paint' as const, layerOrder: paintLayerOrder },
      ...uploadedImages.map((img) => ({ ...img, type: 'uploaded' as const })),
      ...aiImages.map((img) => ({ ...img, type: 'ai' as const })),
      ...textBlocks.map((block) => ({ ...block, type: 'text' as const }))
    ].sort((a, b) => a.layerOrder - b.layerOrder);

    await Promise.all(
      allLayers.map(async (layer, index) => {
        if (layer.type === 'paint') {
          await ctx.db.patch(args.sessionId, {
            paintLayerOrder: index,
          });
        } else if (layer.type === 'uploaded') {
          await ctx.db.patch(layer._id, { layerOrder: index });
        } else if (layer.type === 'ai') {
          await ctx.db.patch(layer._id, { layerOrder: index });
        } else {
          await ctx.db.patch(layer._id as Id<'textBlocks'>, { layerOrder: index });
        }
      })
    );
  },
});
