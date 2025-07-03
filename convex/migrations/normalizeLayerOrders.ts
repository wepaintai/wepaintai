import { internalMutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";

// Run this migration to normalize layer orders for all sessions
export const normalizeAllSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all painting sessions
    const sessions = await ctx.db.query("paintingSessions").collect();
    
    console.log(`[Migration] Normalizing layer orders for ${sessions.length} sessions`);
    
    for (const session of sessions) {
      try {
        // Get all images for this session
        const uploadedImages = await ctx.db
          .query("uploadedImages")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect();
        
        const aiImages = await ctx.db
          .query("aiGeneratedImages")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect();
        
        // Get or set paint layer order
        const paintLayerOrder = (session as any).paintLayerOrder ?? 1;
        
        // Combine all layers including paint
        const allLayers = [
          { id: 'paint', type: 'paint' as const, layerOrder: paintLayerOrder },
          ...uploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
          ...aiImages.map(img => ({ ...img, type: 'ai' as const }))
        ].sort((a, b) => a.layerOrder - b.layerOrder);
        
        // Reassign sequential orders starting from 0
        let hasChanges = false;
        
        for (let i = 0; i < allLayers.length; i++) {
          const layer = allLayers[i];
          
          if (layer.layerOrder !== i) {
            hasChanges = true;
            
            if (layer.type === 'paint') {
              await ctx.db.patch(session._id, {
                paintLayerOrder: i,
              } as any);
            } else if (layer.type === 'uploaded') {
              await ctx.db.patch(layer._id as Id<"uploadedImages">, { layerOrder: i });
            } else {
              await ctx.db.patch(layer._id as Id<"aiGeneratedImages">, { layerOrder: i });
            }
          }
        }
        
        if (hasChanges) {
          console.log(`[Migration] Normalized layer orders for session ${session._id}`);
        }
      } catch (error) {
        console.error(`[Migration] Error normalizing session ${session._id}:`, error);
      }
    }
    
    console.log(`[Migration] Layer order normalization complete`);
  },
});