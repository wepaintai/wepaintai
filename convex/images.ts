import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertCanModifySession, canReadSession, keysMatch } from "./sessionAuth";
import {
  assertAllowedAiImageUrl,
  assertFiniteNumber,
  assertValidImageDimensions,
  MAX_AI_IMAGE_DIMENSION,
  MAX_IMAGE_DIMENSION,
  MAX_OPEN_UPLOAD_INTENTS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_INTENTS_PER_WINDOW,
  sanitizeCanvasDimension,
  sanitizeFilename,
  UPLOAD_INTENT_TTL_MS,
  UPLOAD_RATE_WINDOW_MS,
} from "./imageValidation";
import { generateUploadToken, sha256Hex } from "./uploadToken";

// ---------------------------------------------------------------------------
// Image upload flow (AUD-009)
//
// 1. createUploadIntent (mutation): session edit access + rate limit; returns
//    {intentId, uploadToken}. Only the token's SHA-256 is stored.
// 2. POST /uploads/image (HTTP action, convex/imageUploadHttp.ts): checks the
//    intent + token, reads the body under a hard byte cap, validates the image
//    bytes, stores the blob and calls attachUploadToIntent, which records the
//    storageId and decoded metadata on the intent in one mutation.
// 3. commitImageUpload (mutation): re-checks session access and the token and
//    creates the uploadedImages row from the intent's recorded storageId. No
//    client-supplied storageId is accepted anywhere in this flow.
// Expired, uncommitted intents have their blob deleted by
// cleanupExpiredUploadIntents.
// ---------------------------------------------------------------------------

/** Message for clients still running the pre-intent upload code. */
export const RELOAD_TO_UPLOAD_MESSAGE = "Please reload the page to upload images";

type UploadCheckFailure = { ok: false; status: number; error: string };

/**
 * Rate-limit bucket for upload intents. Signed-in users are limited across all
 * sessions; a guest owner is identified by the session's owner key; anonymous
 * edit-link holders share one bucket per session (a random, non-matching
 * guestKey grants nothing, so it can't be rotated to evade).
 */
function uploadRateKey(
  session: Doc<"paintingSessions">,
  user: Doc<"users"> | null,
  guestKey: string | undefined,
): string {
  if (user) return `user:${user._id}`;
  if (session.guestOwnerKey && guestKey && keysMatch(session.guestOwnerKey, guestKey)) {
    return `guest:${session._id}`;
  }
  return `anon:${session._id}`;
}

/**
 * Shared upload-time checks for an intent (used before reading the request
 * body and again, transactionally, when recording the stored blob).
 */
async function checkIntentForUpload(
  ctx: QueryCtx,
  intent: Doc<"imageUploadIntents"> | null,
  uploadTokenHash: string,
  now: number,
): Promise<UploadCheckFailure | null> {
  if (
    !intent ||
    !intent.uploadTokenHash ||
    !keysMatch(intent.uploadTokenHash, uploadTokenHash)
  ) {
    return { ok: false, status: 403, error: "Invalid upload token" };
  }
  if (intent.consumedAt !== undefined) {
    return { ok: false, status: 409, error: "Upload intent already used" };
  }
  if (intent.storageId !== undefined) {
    return { ok: false, status: 409, error: "An image was already uploaded for this intent" };
  }
  if (now > intent.expiresAt) {
    return { ok: false, status: 410, error: "Upload intent expired" };
  }
  const session = await ctx.db.get(intent.sessionId);
  if (!session || session.deletedAt !== undefined) {
    return { ok: false, status: 404, error: "Session not found" };
  }
  return null;
}

/** Delete a blob unless an image record references it. */
async function deleteUnreferencedBlob(
  ctx: { db: QueryCtx["db"]; storage: { delete: (id: Id<"_storage">) => Promise<void> } },
  storageId: Id<"_storage">,
) {
  const attached = await ctx.db
    .query("uploadedImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (attached) return;
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // Already deleted
  }
}

// Create a single-use upload intent for the caller. The returned uploadToken
// is the only credential for POST /uploads/image and commitImageUpload.
export const createUploadIntent = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.object({
    intentId: v.id("imageUploadIntents"),
    uploadToken: v.string(),
    expiresAt: v.number(),
    maxBytes: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new ConvexError("Session not found");
    const { user } = await assertCanModifySession(ctx, session, args.guestKey, {
      editKey: args.editKey,
    });

    const now = Date.now();
    const rateKey = uploadRateKey(session, user, args.guestKey);
    const recent = await ctx.db
      .query("imageUploadIntents")
      .withIndex("by_rate_key", (q) =>
        q.eq("rateKey", rateKey).gt("createdAt", now - UPLOAD_RATE_WINDOW_MS),
      )
      .take(MAX_UPLOAD_INTENTS_PER_WINDOW);
    if (recent.length >= MAX_UPLOAD_INTENTS_PER_WINDOW) {
      throw new ConvexError("Too many image uploads. Please try again later.");
    }
    const open = recent.filter(
      (intent) => intent.consumedAt === undefined && intent.expiresAt >= now,
    ).length;
    if (open >= MAX_OPEN_UPLOAD_INTENTS) {
      throw new ConvexError(
        "Too many uploads in progress. Please wait for them to finish and try again.",
      );
    }

    const uploadToken = generateUploadToken();
    const expiresAt = now + UPLOAD_INTENT_TTL_MS;
    const intentId = await ctx.db.insert("imageUploadIntents", {
      sessionId: args.sessionId,
      userId: user?._id,
      createdAt: now,
      expiresAt,
      uploadTokenHash: sha256Hex(uploadToken),
      rateKey,
    });
    return { intentId, uploadToken, expiresAt, maxBytes: MAX_UPLOAD_BYTES };
  },
});

// Pre-body check for the upload HTTP action, so unauthenticated bodies are
// never read or stored.
export const checkUploadIntent = internalQuery({
  args: {
    intentId: v.string(),
    uploadTokenHash: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true } | UploadCheckFailure> => {
    const intentId = ctx.db.normalizeId("imageUploadIntents", args.intentId);
    const intent = intentId ? await ctx.db.get(intentId) : null;
    const failure = await checkIntentForUpload(ctx, intent, args.uploadTokenHash, Date.now());
    return failure ?? { ok: true };
  },
});

// Record a validated, freshly stored blob on its intent. Exactly one blob can
// ever be attached to an intent: if the intent is no longer uploadable (token
// mismatch, already uploaded by a concurrent request, consumed or expired),
// the just-stored blob is deleted in this same transaction.
export const attachUploadToIntent = internalMutation({
  args: {
    intentId: v.string(),
    uploadTokenHash: v.string(),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    width: v.number(),
    height: v.number(),
  },
  handler: async (ctx, args): Promise<{ ok: true } | UploadCheckFailure> => {
    const intentId = ctx.db.normalizeId("imageUploadIntents", args.intentId);
    const intent = intentId ? await ctx.db.get(intentId) : null;
    const now = Date.now();
    const failure = await checkIntentForUpload(ctx, intent, args.uploadTokenHash, now);
    if (failure || !intent) {
      await deleteUnreferencedBlob(ctx, args.storageId);
      return failure ?? { ok: false, status: 403, error: "Invalid upload token" };
    }
    await ctx.db.patch(intent._id, {
      storageId: args.storageId,
      uploadedAt: now,
      mimeType: args.mimeType,
      width: args.width,
      height: args.height,
    });
    return { ok: true };
  },
});

// Create the image layer from an intent whose bytes were uploaded and
// validated by POST /uploads/image. The blob, MIME type and dimensions come
// only from the intent. If this throws, the blob stays attached to the
// unconsumed intent and is deleted by the cleanup cron once it expires.
export const commitImageUpload = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    intentId: v.id("imageUploadIntents"),
    uploadToken: v.string(),
    filename: v.string(),
    x: v.number(),
    y: v.number(),
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.id("uploadedImages"),
  handler: async (ctx, args): Promise<Id<"uploadedImages">> => {
    const uploadSession = await ctx.db.get(args.sessionId);
    if (!uploadSession) throw new ConvexError("Session not found");
    const { user } = await assertCanModifySession(ctx, uploadSession, args.guestKey, {
      editKey: args.editKey,
    });

    const intent = await ctx.db.get(args.intentId);
    if (
      !intent ||
      intent.sessionId !== args.sessionId ||
      !intent.uploadTokenHash ||
      !keysMatch(intent.uploadTokenHash, sha256Hex(args.uploadToken))
    ) {
      throw new ConvexError("Invalid upload intent");
    }
    if (intent.userId !== user?._id) {
      throw new Error("Unauthorized");
    }
    if (intent.consumedAt !== undefined) {
      throw new ConvexError("Upload intent already used");
    }
    if (Date.now() > intent.expiresAt) {
      throw new ConvexError("Upload intent expired");
    }
    if (
      intent.storageId === undefined ||
      intent.mimeType === undefined ||
      intent.width === undefined ||
      intent.height === undefined
    ) {
      throw new ConvexError("The image upload has not finished");
    }

    const { width, height } = assertValidImageDimensions(
      intent.width,
      intent.height,
      MAX_IMAGE_DIMENSION
    );
    const x = assertFiniteNumber(args.x, "x");
    const y = assertFiniteNumber(args.y, "y");
    const filename = sanitizeFilename(args.filename);

    // Get the current max layer order from ALL images (uploaded and AI)
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    const paintLayerOrder = uploadSession.paintLayerOrder ?? 0;
    const canvasWidth = sanitizeCanvasDimension(
      args.canvasWidth ?? uploadSession.canvasWidth,
      width
    );
    const canvasHeight = sanitizeCanvasDimension(
      args.canvasHeight ?? uploadSession.canvasHeight,
      height
    );

    const scaleX = canvasWidth / width;
    const scaleY = canvasHeight / height;
    // Use "cover" fit (fill canvas; may crop) but never upscale above 1
    const computedScale = Math.min(Math.max(scaleX, scaleY), 1);

    let maxLayerOrder = paintLayerOrder;
    uploadedImages.forEach((img) => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });
    aiImages.forEach((img) => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });

    const newLayerOrder = maxLayerOrder + 1;

    await ctx.db.patch(args.intentId, { consumedAt: Date.now() });

    const imageId = await ctx.db.insert("uploadedImages", {
      sessionId: args.sessionId,
      userId: user?._id,
      storageId: intent.storageId,
      filename,
      mimeType: intent.mimeType,
      width,
      height,
      x,
      y,
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

// Retired upload API. Clients loaded before the intent-based flow call these;
// they fail loudly with a reload prompt instead of misbehaving. The argument
// validators match the old signatures so the message is what callers see.
export const generateUploadUrl = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  handler: async () => {
    throw new ConvexError(RELOAD_TO_UPLOAD_MESSAGE);
  },
});

export const uploadImage = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    width: v.number(),
    height: v.number(),
    x: v.number(),
    y: v.number(),
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async () => {
    throw new ConvexError(RELOAD_TO_UPLOAD_MESSAGE);
  },
});

// Add an AI-generated image record (stores URL directly).
// The URL must point at this deployment's file storage (or a known provider
// CDN) and the client-supplied dimensions are bounded. PR #106 replaces this
// with a storageId binding so the server derives the URL itself.
export const addAIGeneratedImage = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    imageUrl: v.string(),
    width: v.number(),
    height: v.number(),
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });

    const safeImageUrl = assertAllowedAiImageUrl(args.imageUrl, [
      process.env.CONVEX_CLOUD_URL,
      process.env.CONVEX_SITE_URL,
    ]);
    const { width, height } = assertValidImageDimensions(
      args.width,
      args.height,
      MAX_AI_IMAGE_DIMENSION
    );

    // Get the current max layer order from ALL images (uploaded and AI)
    const uploadedImages = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    const aiImages = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    // Canvas size: client hint (bounded), else the session's, else a default
    const canvasWidth = sanitizeCanvasDimension(
      args.canvasWidth || session.canvasWidth,
      800
    );
    const canvasHeight = sanitizeCanvasDimension(
      args.canvasHeight || session.canvasHeight,
      600
    );

    // Find max layer order across all images, starting with the paint layer
    let maxLayerOrder = session.paintLayerOrder ?? 0;
    uploadedImages.forEach(img => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });
    aiImages.forEach(img => {
      maxLayerOrder = Math.max(maxLayerOrder, img.layerOrder);
    });

    // Set new image to top layer
    const newLayerOrder = maxLayerOrder + 1;

    // Calculate scale to fit the AI image within canvas while maintaining aspect ratio
    const scaleX = canvasWidth / width;
    const scaleY = canvasHeight / height;
    const scale = Math.min(scaleX, scaleY); // Use min to fit within canvas

    // Center the image on the canvas
    const x = canvasWidth / 2;
    const y = canvasHeight / 2;

    // Store the original AI image dimensions and calculate scale/position
    const imageId = await ctx.db.insert("aiGeneratedImages", {
      sessionId: args.sessionId,
      imageUrl: safeImageUrl,
      width,
      height,
      x: x,
      y: y,
      scale: scale,
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
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Authorization: allow if public, owner, guest owner, or valid editKey
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [] as any[];
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
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { imageId, guestKey, editKey, ...updates } = args;
    const image = await ctx.db.get(imageId);
    if (!image) throw new Error("Image not found");
    const session = await ctx.db.get(image.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, guestKey, { editKey });
    
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
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { imageId, guestKey, editKey, ...updates } = args;
    const image = await ctx.db.get(imageId);
    if (!image) throw new Error("AI image not found");
    const session = await ctx.db.get(image.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, guestKey, { editKey });
    
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
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("Image not found");
    const session = await ctx.db.get(image.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });

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
  args: {
    imageId: v.id("uploadedImages"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("Image not found");
    const session = await ctx.db.get(image.sessionId);
    if (!session) throw new Error("Session not found");
    // Hard delete (layer, attached strokes and the stored file): owner only,
    // even for edit-link collaborators.
    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

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

const CLEANUP_BATCH_SIZE = 100;

// Cron cleanup for upload intents, in bounded batches (reschedules itself
// while work remains):
// 1. Expired, unconsumed intents: delete the uploaded blob (if any) and mark
//    the intent abandoned, in one transaction. The row itself is kept until
//    the rate-limit window has passed so it still counts toward the limit.
// 2. Intents older than the rate-limit window: delete the row (and, as a
//    fallback, any blob a still-unconsumed intent holds).
// Committed intents' blobs belong to their uploadedImages row and are never
// touched here.
export const cleanupExpiredUploadIntents = internalMutation({
  args: {},
  returns: v.object({ abandoned: v.number(), purged: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();

    const expiredOpen = await ctx.db
      .query("imageUploadIntents")
      .withIndex("by_open_expires", (q) =>
        q.eq("consumedAt", undefined).lt("expiresAt", now),
      )
      .take(CLEANUP_BATCH_SIZE);
    for (const intent of expiredOpen) {
      if (intent.storageId) {
        await deleteUnreferencedBlob(ctx, intent.storageId);
      }
      await ctx.db.patch(intent._id, {
        consumedAt: now,
        abandonedAt: now,
        storageId: undefined,
      });
    }

    const stale = await ctx.db
      .query("imageUploadIntents")
      .withIndex("by_expires", (q) =>
        q.lt("expiresAt", now - UPLOAD_RATE_WINDOW_MS),
      )
      .take(CLEANUP_BATCH_SIZE);
    for (const intent of stale) {
      if (intent.consumedAt === undefined && intent.storageId) {
        await deleteUnreferencedBlob(ctx, intent.storageId);
      }
      await ctx.db.delete(intent._id);
    }

    if (
      expiredOpen.length === CLEANUP_BATCH_SIZE ||
      stale.length === CLEANUP_BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(0, internal.images.cleanupExpiredUploadIntents, {});
    }

    return { abandoned: expiredOpen.length, purged: stale.length };
  },
});

// Get AI-generated images for a session
export const getAIGeneratedImages = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
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
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const image = await ctx.db.get(args.imageId);
    if (!image) throw new Error("AI image not found");
    const session = await ctx.db.get(image.sessionId);
    if (!session) throw new Error("Session not found");
    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });

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
  args: {
    imageId: v.id("aiGeneratedImages"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log('[deleteAIImage] Attempting to delete AI image:', args.imageId);
    
    const image = await ctx.db.get(args.imageId);
    if (!image) {
      console.error('[deleteAIImage] AI image not found:', args.imageId);
      throw new Error("AI image not found");
    }

    const session = await ctx.db.get(image.sessionId);
    if (!session) throw new Error("Session not found");
    // Hard delete (layer, attached strokes and the stored file): owner only,
    // even for edit-link collaborators.
    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });
    
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
