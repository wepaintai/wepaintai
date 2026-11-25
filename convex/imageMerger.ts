import { v } from "convex/values";
import { action, query, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { canReadSession } from "./sessionAuth";
import { beginErrorMessage } from "./aiOperations";
import {
  BILLED_FAILURE_NOTE,
  REFUNDED_FAILURE_NOTE,
  cancelPrediction,
  createPrediction,
  extractOutputUrl,
  isModerationError,
  pollPrediction,
} from "./replicate";

// Internal-only query to resolve layer storage URLs for the mergeImages action.
// Never exposed publicly because it returns signed Convex _storage URLs.
export const getLayerImageUrl = internalQuery({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.string(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return null;
    }
    // First check if it's an AI-generated image
    const aiImage = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.eq(q.field("_id"), args.layerId))
      .first();
      
    if (aiImage) {
      // Prefer a fresh URL from the backing blob; legacy layers only have a URL
      const url = aiImage.storageId
        ? (await ctx.storage.getUrl(aiImage.storageId)) ?? aiImage.imageUrl
        : aiImage.imageUrl;
      return { url, type: "ai-generated" };
    }
    
    // Check if it's a regular uploaded image
    const uploadedImage = await ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.eq(q.field("_id"), args.layerId))
      .first();
      
    if (uploadedImage) {
      // Get the storage URL for uploaded images
      const url = await ctx.storage.getUrl(uploadedImage.storageId);
      return { url, type: "uploaded" };
    }
    
    // Layer not found
    return null;
  },
});

// Main action to merge images using Replicate
export const mergeImages = action({
  args: {
    sessionId: v.id("paintingSessions"),
    firstLayerId: v.string(),
    secondLayerId: v.string(),
    controlLayerId: v.optional(v.string()),
    mergeMode: v.union(v.literal("full"), v.literal("left_right"), v.literal("top_bottom")),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; imageUrl?: string; storageId?: Id<"_storage">; error?: string }> => {
    console.log('[IMAGE-MERGE] mergeImages action called with:', {
      firstLayerId: args.firstLayerId,
      secondLayerId: args.secondLayerId,
      mergeMode: args.mergeMode
    });

    const access = await ctx.runQuery(internal.sessionAuth.verifySessionAccess, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      editKey: args.editKey,
      requireAuth: true,
    });
    if (access.status === "not_found") {
      return { success: false, error: "Session not found" };
    }
    if (access.status === "unauthenticated") {
      console.error('[IMAGE-MERGE] User not authenticated');
      return { success: false, error: "Please sign in to use image merging." };
    }
    if (access.status !== "ok") {
      return { success: false, error: "Unauthorized" };
    }

    // Get Replicate API token from environment before reserving tokens
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) {
      console.error("REPLICATE_API_TOKEN not configured");
      return { success: false, error: "Image merging not configured" };
    }

    // Insert the operation row and reserve 1 token atomically BEFORE any
    // provider spending. Users without tokens never get a row.
    const begin = await ctx.runMutation(internal.aiOperations.beginOperation, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      editKey: args.editKey,
      operation: {
        type: "image-merge",
        firstLayerId: args.firstLayerId,
        secondLayerId: args.secondLayerId,
        controlLayerId: args.controlLayerId,
        mergeMode: args.mergeMode,
      },
    });
    if (begin.status !== "ok") {
      return { success: false, error: beginErrorMessage(begin.status) };
    }
    const mergeId = begin.operationId;

    const fail = async (error: string, outcome: "refund" | "billed") => {
      await ctx.runMutation(internal.aiOperations.failOperation, {
        operationType: "image-merge",
        operationId: mergeId,
        outcome,
        error,
      });
      const note = outcome === "billed" ? BILLED_FAILURE_NOTE : REFUNDED_FAILURE_NOTE;
      return { success: false as const, error: `${error} ${note}` };
    };

    let predictionId: string | null = null;
    try {
      // Get the image URLs for both layers and optional control layer
      let firstImageUrl: string;
      let secondImageUrl: string;
      let controlImageUrl: string | undefined;

      try {
        const firstLayerResult = await ctx.runQuery(internal.imageMerger.getLayerImageUrl, {
          sessionId: args.sessionId,
          layerId: args.firstLayerId,
          guestKey: args.guestKey,
          editKey: args.editKey,
        });

        const secondLayerResult = await ctx.runQuery(internal.imageMerger.getLayerImageUrl, {
          sessionId: args.sessionId,
          layerId: args.secondLayerId,
          guestKey: args.guestKey,
          editKey: args.editKey,
        });

        if (!firstLayerResult || !firstLayerResult.url) {
          throw new Error(`First layer ${args.firstLayerId} not found or has no URL`);
        }

        if (!secondLayerResult || !secondLayerResult.url) {
          throw new Error(`Second layer ${args.secondLayerId} not found or has no URL`);
        }

        firstImageUrl = firstLayerResult.url;
        secondImageUrl = secondLayerResult.url;

        // Get control image URL if provided
        if (args.controlLayerId) {
          const controlLayerResult = await ctx.runQuery(internal.imageMerger.getLayerImageUrl, {
            sessionId: args.sessionId,
            layerId: args.controlLayerId,
            guestKey: args.guestKey,
            editKey: args.editKey,
          });

          if (controlLayerResult && controlLayerResult.url) {
            controlImageUrl = controlLayerResult.url;
          }
        }
      } catch (error) {
        console.error('[IMAGE-MERGE] Failed to get layer image URLs:', error);
        return await fail("Failed to get layer images.", "refund");
      }

      const input: Record<string, unknown> = {
        image_1: firstImageUrl,
        image_2: secondImageUrl,
        merge_option: args.mergeMode,
        output_format: "png",
      };
      if (controlImageUrl) {
        input.control_image = controlImageUrl;
      }

      const created = await createPrediction(replicateToken, {
        version: "db2c826b6a7215fd31695acb73b5b2c91a077f88a2a264c003745e62901e2867", // fofr/image-merger latest version
        input,
      });
      if (created.kind === "rejected") {
        console.error("[IMAGE-MERGE] Replicate rejected the request:", created.httpStatus, created.message);
        return await fail("Failed to start image merge.", "refund");
      }
      predictionId = created.id;

      // From here on the provider has accepted (and bills) the request.
      await ctx.runMutation(internal.aiOperations.markOperationProcessing, {
        operationType: "image-merge",
        operationId: mergeId,
        replicateId: predictionId,
      });

      const result = await pollPrediction(replicateToken, predictionId);
      if (result.kind === "timeout" || result.kind === "poll_error") {
        if (result.kind === "poll_error") console.error('[IMAGE-MERGE] Status polling failed:', result.message);
        await cancelPrediction(replicateToken, predictionId);
        return await fail("Merge timed out and was canceled.", "billed");
      }
      if (result.kind === "failed") {
        const message = isModerationError(result.error)
          ? "Content moderation flagged these images. Please try different images."
          : `Merge failed: ${result.error}.`;
        return await fail(message, "billed");
      }

      const imageUrl = extractOutputUrl(result.output);
      if (!imageUrl) {
        return await fail("Replicate returned an invalid result.", "billed");
      }

      // Download into Convex storage so the result URL doesn't expire (the
      // provider URL is short-lived). The provider already billed this
      // request, so a storage failure is failed_billed rather than refunded.
      let finalUrl: string | null = null;
      let storedId: Id<"_storage"> | null = null;
      try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to download image: ${imageResponse.statusText}`);
        }
        storedId = await ctx.storage.store(await imageResponse.blob());
        finalUrl = await ctx.storage.getUrl(storedId);
      } catch (error) {
        console.error("[IMAGE-MERGE] Error storing image:", error);
      }
      if (!storedId || !finalUrl) {
        if (storedId) await ctx.storage.delete(storedId).catch(() => {});
        return await fail("Failed to save the merged image.", "billed");
      }

      // Records the output blob with the status, or deletes it if the result
      // can't be written.
      const completion = await ctx.runMutation(internal.aiOperations.completeOperation, {
        operationType: "image-merge",
        operationId: mergeId,
        resultImageUrl: finalUrl,
        resultStorageId: storedId,
        guestKey: args.guestKey,
        editKey: args.editKey,
      });
      if (completion !== "completed") {
        return {
          success: false,
          error:
            completion === "access_lost"
              ? "You no longer have access to this painting, so the result was discarded."
              : "This merge was already finalized.",
        };
      }

      return { success: true, imageUrl: finalUrl, storageId: storedId };
    } catch (error) {
      console.error("[IMAGE-MERGE] Image merge error:", error instanceof Error ? error.message : String(error));
      if (predictionId) await cancelPrediction(replicateToken, predictionId);
      return await fail("An error occurred during merge.", predictionId ? "billed" : "refund");
    }
  },
});

// Query to get image merges for a session
export const getSessionMerges = query({
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
    return await ctx.db
      .query("imageMerges")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(10);
  },
});
