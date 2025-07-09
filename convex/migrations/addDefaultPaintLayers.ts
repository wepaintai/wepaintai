import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Migration to add default paint layers to existing sessions
 * This ensures backward compatibility for sessions created before the multi-layer feature
 */
export const addDefaultPaintLayersToExistingSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all painting sessions
    const sessions = await ctx.db.query("paintingSessions").collect();
    
    let migratedCount = 0;
    
    for (const session of sessions) {
      // Check if this session already has any paint layers
      const existingLayers = await ctx.db
        .query("paintLayers")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .first();
      
      if (!existingLayers) {
        // Create a default paint layer for this session
        await ctx.db.insert("paintLayers", {
          sessionId: session._id,
          name: "Layer 1",
          layerOrder: 0,
          visible: true,
          opacity: 1,
          createdBy: session.createdBy,
          createdAt: Date.now(),
        });
        
        migratedCount++;
      }
    }
    
    console.log(`[Migration] Added default paint layers to ${migratedCount} sessions`);
    return { migratedCount };
  },
});

/**
 * Migration to update existing strokes to reference the default paint layer
 * This ensures all strokes belong to a layer
 */
export const updateStrokesToReferenceDefaultLayer = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all strokes without a layerId
    const strokesWithoutLayer = await ctx.db
      .query("strokes")
      .filter((q) => q.eq(q.field("layerId"), undefined))
      .collect();
    
    let updatedCount = 0;
    
    for (const stroke of strokesWithoutLayer) {
      // Find the default paint layer for this session
      const defaultLayer = await ctx.db
        .query("paintLayers")
        .withIndex("by_session", (q) => q.eq("sessionId", stroke.sessionId))
        .first();
      
      if (defaultLayer) {
        // Update the stroke to reference the default layer
        await ctx.db.patch(stroke._id, {
          layerId: defaultLayer._id,
        });
        
        updatedCount++;
      }
    }
    
    console.log(`[Migration] Updated ${updatedCount} strokes to reference default paint layers`);
    return { updatedCount };
  },
});