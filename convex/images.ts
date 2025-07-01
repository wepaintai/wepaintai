import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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
  },
  handler: async (ctx, args) => {
    // Get the current max layer order for this session
    const existingImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const maxLayerOrder = existingImages.reduce((max, img) => 
      Math.max(max, img.layerOrder), -1
    );

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
      scale: 1,
      rotation: 0,
      opacity: 1,
      layerOrder: maxLayerOrder + 1,
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
    // Get the current max layer order for this session
    const existingImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    
    const maxLayerOrder = existingImages.reduce((max, img) => 
      Math.max(max, img.layerOrder), -1
    );

    // Get canvas dimensions from the painting session if not provided
    let canvasWidth = args.canvasWidth || 800;
    let canvasHeight = args.canvasHeight || 600;
    
    const session = await ctx.db.get(args.sessionId);
    if (session) {
      canvasWidth = args.canvasWidth || session.canvasWidth;
      canvasHeight = args.canvasHeight || session.canvasHeight;
    }

    // Calculate scale to fit the AI image within canvas while maintaining aspect ratio
    const scaleX = canvasWidth / args.width;
    const scaleY = canvasHeight / args.height;
    const scale = Math.min(scaleX, scaleY); // Use min to fit within canvas
    
    // Calculate position to center the image if it doesn't fill the entire canvas
    const scaledWidth = args.width * scale;
    const scaledHeight = args.height * scale;
    const x = (canvasWidth - scaledWidth) / 2;
    const y = (canvasHeight - scaledHeight) / 2;
    
    // Store the original AI image dimensions and calculate scale/position
    const imageId = await ctx.db.insert("aiGeneratedImages", {
      sessionId: args.sessionId,
      imageUrl: args.imageUrl,
      width: args.width, // Store actual image width
      height: args.height, // Store actual image height
      x: x, // Center horizontally if needed
      y: y, // Center vertically if needed
      scale: scale, // Scale to fit canvas
      rotation: 0,
      opacity: 1,
      layerOrder: maxLayerOrder + 1,
      createdAt: Date.now(),
    });

    return imageId;
  },
});

// Get all images for a session (both uploaded and AI-generated)
export const getSessionImages = query({
  args: { sessionId: v.id("paintingSessions") },
  handler: async (ctx, args) => {
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
    scale: v.optional(v.number()),
    rotation: v.optional(v.number()),
    opacity: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { imageId, ...updates } = args;
    
    // Only update provided fields
    const updateFields: any = {};
    if (updates.x !== undefined) updateFields.x = updates.x;
    if (updates.y !== undefined) updateFields.y = updates.y;
    if (updates.scale !== undefined) updateFields.scale = updates.scale;
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
    scale: v.optional(v.number()),
    rotation: v.optional(v.number()),
    opacity: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { imageId, ...updates } = args;
    
    // Only update provided fields
    const updateFields: any = {};
    if (updates.x !== undefined) updateFields.x = updates.x;
    if (updates.y !== undefined) updateFields.y = updates.y;
    if (updates.scale !== undefined) updateFields.scale = updates.scale;
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

    const sessionImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    // Reorder other images if necessary
    const imagesToUpdate = sessionImages.filter(
      (img) => img._id !== args.imageId && img.layerOrder >= args.newLayerOrder
    );

    // Shift other images up
    await Promise.all(
      imagesToUpdate.map((img) =>
        ctx.db.patch(img._id, { layerOrder: img.layerOrder + 1 })
      )
    );

    // Update the target image
    await ctx.db.patch(args.imageId, { layerOrder: args.newLayerOrder });
  },
});

// Delete an image
export const deleteImage = mutation({
  args: { imageId: v.id("uploadedImages") },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("Image not found");

    // Delete from storage
    await ctx.storage.delete(image.storageId);

    // Delete the record
    await ctx.db.delete(args.imageId);

    // Reorder remaining images
    const remainingImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    const imagesToUpdate = remainingImages.filter(
      (img) => img.layerOrder > image.layerOrder
    );

    await Promise.all(
      imagesToUpdate.map((img) =>
        ctx.db.patch(img._id, { layerOrder: img.layerOrder - 1 })
      )
    );
  },
});

// Generate upload URL for client-side upload
export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

// Get AI-generated images for a session
export const getAIGeneratedImages = query({
  args: { sessionId: v.id("paintingSessions") },
  handler: async (ctx, args) => {
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

    const sessionImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    // Reorder other images if necessary
    const imagesToUpdate = sessionImages.filter(
      (img) => img._id !== args.imageId && img.layerOrder >= args.newLayerOrder
    );

    // Shift other images up
    await Promise.all(
      imagesToUpdate.map((img) =>
        ctx.db.patch(img._id, { layerOrder: img.layerOrder + 1 })
      )
    );

    // Update the target image
    await ctx.db.patch(args.imageId, { layerOrder: args.newLayerOrder });
  },
});

// Delete an AI-generated image
export const deleteAIImage = mutation({
  args: { imageId: v.id("aiGeneratedImages") },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("AI image not found");

    // Delete the record
    await ctx.db.delete(args.imageId);

    // Reorder remaining images
    const remainingImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", image.sessionId))
      .collect();

    const imagesToUpdate = remainingImages.filter(
      (img) => img.layerOrder > image.layerOrder
    );

    await Promise.all(
      imagesToUpdate.map((img) =>
        ctx.db.patch(img._id, { layerOrder: img.layerOrder - 1 })
      )
    );
  },
});