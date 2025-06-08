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

// Get all images for a session
export const getSessionImages = query({
  args: { sessionId: v.id("paintingSessions") },
  handler: async (ctx, args) => {
    const images = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // Get storage URLs for each image
    const imagesWithUrls = await Promise.all(
      images.map(async (image) => {
        const url = await ctx.storage.getUrl(image.storageId);
        return {
          ...image,
          url,
        };
      })
    );

    return imagesWithUrls.sort((a, b) => a.layerOrder - b.layerOrder);
  },
});

// Update image transform (position, scale, rotation)
export const updateImageTransform = mutation({
  args: {
    imageId: v.id("uploadedImages"),
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