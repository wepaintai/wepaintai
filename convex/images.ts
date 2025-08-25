import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Upload an image to storage and create a record
export const uploadImage = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    width: v.number(),
    height: v.number(),
    x: v.number(),
    y: v.number(),
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Get the current max layer order from ALL images (uploaded and AI)
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    // Get painting session to check paint layer order
    const uploadSession = await ctx.db.get(args.sessionId);
    const paintLayerOrder = uploadSession?.paintLayerOrder ?? 0;
    // Compute scale to fit original image within canvas without altering the stored pixels
    const canvasWidth = args.canvasWidth ?? uploadSession?.canvasWidth ?? args.width;
    const canvasHeight = args.canvasHeight ?? uploadSession?.canvasHeight ?? args.height;
    const scaleX = canvasWidth / args.width;
    const scaleY = canvasHeight / args.height;
    // Use "cover" fit (fill canvas; may crop) but never upscale above 1
    const computedScale = Math.min(Math.max(scaleX, scaleY), 1);
    
    // Find max layer order across all images
    let maxLayerOrder = paintLayerOrder; // Start with paint layer order
    
    uploadedImages.forEach(img => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });
    
    aiImages.forEach(img => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });
    
    // Set new image to top layer
    const newLayerOrder = maxLayerOrder + 1;

    // Create the image record
    const imageId = await ctx.db.insert("uploadedImages", {
      sessionId: args.sessionId,
      userId: args.userId,
      storageId: args.storageId,
      filename: args.filename,
      mimeType: args.mimeType,
      width: args.width,
      height: args.height,
      x: args.x,
      y: args.y,
      scale: computedScale,
      scaleX: computedScale,
      scaleY: computedScale,
      rotation: 0,
      opacity: 1,
      layerOrder: newLayerOrder,
    });

    return imageId;
  },
});

// Add an AI-generated image record (stores URL directly)
export const addAIGeneratedImage = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    imageUrl: v.string(),
    width: v.number(),
    height: v.number(),
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Get the current max layer order from ALL images (uploaded and AI)
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    // Get canvas dimensions from the painting session if not provided
    let canvasWidth = args.canvasWidth || 800;
    let canvasHeight = args.canvasHeight || 600;
    
    const session = await ctx.db.get(args.sessionId);
    const paintLayerOrder = session?.paintLayerOrder ?? 0;
    
    // Find max layer order across all images
    let maxLayerOrder = paintLayerOrder; // Start with paint layer order
    
    uploadedImages.forEach(img => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });
    
    aiImages.forEach(img => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });
    
    // Set new image to top layer
    const newLayerOrder = maxLayerOrder + 1;
    if (session) {
      canvasWidth = args.canvasWidth || session.canvasWidth;
      canvasHeight = args.canvasHeight || session.canvasHeight;
    }

    // Calculate scale to fit the AI image within canvas while maintaining aspect ratio
    const scaleX = canvasWidth / args.width;
    const scaleY = canvasHeight / args.height;
    const scale = Math.min(scaleX, scaleY); // Use min to fit within canvas
    
    // Center the image on the canvas
    // Since KonvaImage uses offsetX/offsetY to center the image anchor,
    // we position at the canvas center directly
    const x = canvasWidth / 2;
    const y = canvasHeight / 2;
    
    console.log('[addAIGeneratedImage] Positioning calculation:', {
      imageWidth: args.width,
      imageHeight: args.height,
      canvasWidth,
      canvasHeight,
      scaleX,
      scaleY,
      finalScale: scale,
      centerX: x,
      centerY: y,
    });
    
    // Store the original AI image dimensions and calculate scale/position
    const imageId = await ctx.db.insert("aiGeneratedImages", {
      sessionId: args.sessionId,
      imageUrl: args.imageUrl,
      width: args.width, // Store actual image width
      height: args.height, // Store actual image height
      x: x, // Center horizontally if needed
      y: y, // Center vertically if needed
      scale: scale, // Scale to fit canvas
      scaleX: scale,
      scaleY: scale,
      rotation: 0,
      opacity: 1,
      layerOrder: newLayerOrder,
      createdAt: Date.now(),
    });

    return imageId;
  },
});

// Get all images for a session (both uploaded and AI-generated)
export const getSessionImages = query({
  args: { sessionId: v.id("paintingSessions"), guestKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Authorization: allow if public or owner
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
          if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return [] as any[];
        }
      } else {
        if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) return [] as any[];
      }
    }
    // Get uploaded images
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // Get storage URLs for uploaded images
    const uploadedWithUrls = await Promise.all(
      uploadedImages.map(async (image) => {
        const url = await ctx.storage.getUrl(image.storageId);
        return {
          ...image,
          url,
          type: "uploaded" as const,
        };
      })
    );

    // Get AI-generated images
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // AI images already have URLs
    const aiWithType = aiImages.map(image => ({
      ...image,
      _id: image._id as any, // Keep the original AI image ID
      url: image.imageUrl,
      type: "ai-generated" as const,
      // Map to match uploaded image structure
      storageId: null as any,
      filename: "ai-generated.png",
      mimeType: "image/png",
      userId: undefined,
    }));

    // Combine and sort by layer order
    const allImages = [...uploadedWithUrls, ...aiWithType];
    return allImages.sort((a, b) => a.layerOrder - b.layerOrder);
  },
});

// Update image transform (position, scale, rotation)
export const updateImageTransform = mutation({
  args: {
    imageId: v.union(v.id("uploadedImages"), v.id("aiGeneratedImages")),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    // Legacy uniform scale (will also set scaleX/scaleY if provided)
    scale: v.optional(v.number()),
    // New non-uniform scales
    scaleX: v.optional(v.number()),
    scaleY: v.optional(v.number()),
    rotation: v.optional(v.number()),
    opacity: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { imageId, ...updates } = args;
    
    // Only update provided fields
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

    await ctx.db.patch(imageId, updateFields);
  },
});

// Update AI-generated image transform (position, scale, rotation, opacity)
export const updateAIImageTransform = mutation({
  args: {
    imageId: v.id("aiGeneratedImages"),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    // Legacy uniform scale (will also set scaleX/scaleY if provided)
    scale: v.optional(v.number()),
    // New non-uniform scales
    scaleX: v.optional(v.number()),
    scaleY: v.optional(v.number()),
    rotation: v.optional(v.number()),
    opacity: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { imageId, ...updates } = args;
    
    // Only update provided fields
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

    await ctx.db.patch(imageId, updateFields);
  },
});

// Update image layer order
export const updateImageLayerOrder = mutation({
  args: {
    imageId: v.id("uploadedImages"),
    newLayerOrder: v.number(),
  },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("Image not found");

    // Get all images (uploaded and AI) for the session to maintain unique ordering
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    // Combine all images and sort by current order
    const allImages = [
      ...uploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
      ...aiImages.map(img => ({ ...img, type: 'ai' as const }))
    ].sort((a, b) => a.layerOrder - b.layerOrder);

    // Find current position
    const currentIndex = allImages.findIndex(img => 
      img.type === 'uploaded' && img._id === args.imageId
    );
    
    if (currentIndex === -1) throw new Error("Image not found in layer order");
    
    // Calculate target index based on newLayerOrder
    let targetIndex = 0;
    for (let i = 0; i < allImages.length; i++) {
      if (allImages[i].layerOrder >= args.newLayerOrder && i !== currentIndex) {
        targetIndex = i;
        break;
      }
      targetIndex = i + 1;
    }
    
    // If moving down, adjust target index
    if (targetIndex > currentIndex) {
      targetIndex--;
    }
    
    // Reorder array
    const reorderedImages = [...allImages];
    const [movedImage] = reorderedImages.splice(currentIndex, 1);
    reorderedImages.splice(targetIndex, 0, movedImage);
    
    // Update all images with new sequential order values
    await Promise.all(
      reorderedImages.map((img, index) => {
        if (img.type === 'uploaded') {
          return ctx.db.patch(img._id as Id<"uploadedImages">, { layerOrder: index });
        } else {
          return ctx.db.patch(img._id as Id<"aiGeneratedImages">, { layerOrder: index });
        }
      })
    );
  },
});

// Delete an image
export const deleteImage = mutation({
  args: { imageId: v.id("uploadedImages") },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("Image not found");

    // Delete any strokes attached to this image layer
    const attachedStrokes = await ctx.db
      .query("strokes")
      .withIndex("by_layer", (q) =>
        q.eq("sessionId", image.sessionId).eq("layerId", args.imageId)
      )
      .collect();
    for (const s of attachedStrokes) {
      await ctx.db.delete(s._id);
    }

    // Delete any deletedStrokes cached for this image layer
    const attachedDeleted = await ctx.db
      .query("deletedStrokes")
      .withIndex("by_session_layer_deleted", (q) =>
        q.eq("sessionId", image.sessionId).eq("layerId", args.imageId)
      )
      .collect();
    for (const ds of attachedDeleted) {
      await ctx.db.delete(ds._id);
    }

    // Delete from storage
    await ctx.storage.delete(image.storageId);

    // Delete the record
    await ctx.db.delete(args.imageId);

    // Get all remaining images (both uploaded and AI) to properly reorder
    const remainingUploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();
    
    // Get paint layer order
    const session = await ctx.db.get(image.sessionId);
    const paintLayerOrder = session?.paintLayerOrder ?? 0;
    
    // Combine all layers and filter out the deleted one
    const allLayers = [
      { id: 'paint', type: 'paint' as const, layerOrder: paintLayerOrder },
      ...remainingUploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
      ...aiImages.map(img => ({ ...img, type: 'ai' as const }))
    ].sort((a, b) => a.layerOrder - b.layerOrder);
    
    // Reassign sequential orders
    await Promise.all(
      allLayers.map(async (layer, index) => {
        if (layer.layerOrder !== index) {
          if (layer.type === 'paint') {
            await ctx.db.patch(image.sessionId, {
              paintLayerOrder: index,
            });
          } else if (layer.type === 'uploaded') {
            await ctx.db.patch(layer._id as Id<"uploadedImages">, { layerOrder: index });
          } else {
            await ctx.db.patch(layer._id as Id<"aiGeneratedImages">, { layerOrder: index });
          }
        }
      })
    );
  },
});

// Generate upload URL for client-side upload
export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

// Get AI-generated images for a session
export const getAIGeneratedImages = query({
  args: { sessionId: v.id("paintingSessions"), guestKey: v.optional(v.string()) },
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
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    return aiImages.sort((a, b) => a.layerOrder - b.layerOrder);
  },
});

// Update AI image layer order
export const updateAIImageLayerOrder = mutation({
  args: {
    imageId: v.id("aiGeneratedImages"),
    newLayerOrder: v.number(),
  },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("AI image not found");

    // Get all images (uploaded and AI) for the session to maintain unique ordering
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();
    
    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    // Combine all images and sort by current order
    const allImages = [
      ...uploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
      ...aiImages.map(img => ({ ...img, type: 'ai' as const }))
    ].sort((a, b) => a.layerOrder - b.layerOrder);

    // Find current position
    const currentIndex = allImages.findIndex(img => 
      img.type === 'ai' && img._id === args.imageId
    );
    
    if (currentIndex === -1) throw new Error("AI image not found in layer order");
    
    // Calculate target index based on newLayerOrder
    let targetIndex = 0;
    for (let i = 0; i < allImages.length; i++) {
      if (allImages[i].layerOrder >= args.newLayerOrder && i !== currentIndex) {
        targetIndex = i;
        break;
      }
      targetIndex = i + 1;
    }
    
    // If moving down, adjust target index
    if (targetIndex > currentIndex) {
      targetIndex--;
    }
    
    // Reorder array
    const reorderedImages = [...allImages];
    const [movedImage] = reorderedImages.splice(currentIndex, 1);
    reorderedImages.splice(targetIndex, 0, movedImage);
    
    // Update all images with new sequential order values
    await Promise.all(
      reorderedImages.map((img, index) => {
        if (img.type === 'uploaded') {
          return ctx.db.patch(img._id as Id<"uploadedImages">, { layerOrder: index });
        } else {
          return ctx.db.patch(img._id as Id<"aiGeneratedImages">, { layerOrder: index });
        }
      })
    );
  },
});

// Delete an AI-generated image
export const deleteAIImage = mutation({
  args: { imageId: v.id("aiGeneratedImages") },
  handler: async (ctx, args) => {
    console.log('[deleteAIImage] Attempting to delete AI image:', args.imageId);
    
    const image = await ctx.db.get(args.imageId);
    if (!image) {
      console.error('[deleteAIImage] AI image not found:', args.imageId);
      throw new Error("AI image not found");
    }
    
    console.log('[deleteAIImage] Found image to delete:', image);

    // Delete any strokes attached to this AI image layer
    const attachedStrokes = await ctx.db
      .query("strokes")
      .withIndex("by_layer", (q) =>
        q.eq("sessionId", image.sessionId).eq("layerId", args.imageId)
      )
      .collect();
    for (const s of attachedStrokes) {
      await ctx.db.delete(s._id);
    }

    // Delete any deletedStrokes cached for this AI image layer
    const attachedDeleted = await ctx.db
      .query("deletedStrokes")
      .withIndex("by_session_layer_deleted", (q) =>
        q.eq("sessionId", image.sessionId).eq("layerId", args.imageId)
      )
      .collect();
    for (const ds of attachedDeleted) {
      await ctx.db.delete(ds._id);
    }

    // Delete the record
    await ctx.db.delete(args.imageId);
    console.log('[deleteAIImage] AI image deleted successfully');

    // Get all remaining images (both uploaded and AI) to properly reorder
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    const remainingAIImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();
    
    // Get paint layer order
    const session = await ctx.db.get(image.sessionId);
    const paintLayerOrder = session?.paintLayerOrder ?? 0;
    
    // Combine all layers and filter out the deleted one
    const allLayers = [
      { id: 'paint', type: 'paint' as const, layerOrder: paintLayerOrder },
      ...uploadedImages.map(img => ({ ...img, type: 'uploaded' as const })),
      ...remainingAIImages.map(img => ({ ...img, type: 'ai' as const }))
    ].sort((a, b) => a.layerOrder - b.layerOrder);
    
    // Reassign sequential orders
    await Promise.all(
      allLayers.map(async (layer, index) => {
        if (layer.layerOrder !== index) {
          if (layer.type === 'paint') {
            await ctx.db.patch(image.sessionId, {
              paintLayerOrder: index,
            });
          } else if (layer.type === 'uploaded') {
            await ctx.db.patch(layer._id as Id<"uploadedImages">, { layerOrder: index });
          } else {
            await ctx.db.patch(layer._id as Id<"aiGeneratedImages">, { layerOrder: index });
          }
        }
      })
    );
  },
});
