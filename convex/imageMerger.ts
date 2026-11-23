import { v } from "convex/values";
import { action, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { canReadSession } from "./sessionAuth";

// Mutation to store image merge requests and results.
// Internal-only: invoked from the mergeImages action via ctx.runMutation.
export const createMergeRequest = internalMutation({
  args: {
    sessionId: v.id("paintingSessions"),
    firstLayerId: v.string(),
    secondLayerId: v.string(),
    controlLayerId: v.optional(v.string()),
    mergeMode: v.union(v.literal("full"), v.literal("left_right"), v.literal("top_bottom")),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    resultImageUrl: v.optional(v.string()),
    replicateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    
    return await ctx.db.insert("imageMerges", {
      sessionId: args.sessionId,
      userId: identity?.subject,
      firstLayerId: args.firstLayerId,
      secondLayerId: args.secondLayerId,
      controlLayerId: args.controlLayerId,
      mergeMode: args.mergeMode,
      status: args.status,
      error: args.error,
      resultImageUrl: args.resultImageUrl,
      replicateId: args.replicateId,
      createdAt: Date.now(),
    });
  },
});

// Update merge status. Internal-only: patches any imageMerges doc by id with no
// auth, so it must never be client-callable.
export const updateMergeStatus = internalMutation({
  args: {
    mergeId: v.id("imageMerges"),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    resultImageUrl: v.optional(v.string()),
    replicateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.mergeId, {
      status: args.status,
      error: args.error,
      resultImageUrl: args.resultImageUrl,
      replicateId: args.replicateId,
    });
  },
});

// Internal-only query to resolve layer storage URLs for the mergeImages action.
// Never exposed publicly because it returns signed Convex _storage URLs.
export const getLayerImageUrl = internalQuery({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.string(),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey))) {
      return null;
    }
    // First check if it's an AI-generated image
    const aiImage = await ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.eq(q.field("_id"), args.layerId))
      .first();
      
    if (aiImage) {
      return { url: aiImage.imageUrl, type: "ai-generated" };
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
  },
  handler: async (ctx, args) => {
    console.log('[IMAGE-MERGE] mergeImages action called with:', {
      firstLayerId: args.firstLayerId,
      secondLayerId: args.secondLayerId,
      mergeMode: args.mergeMode
    });

    const access = await ctx.runQuery(internal.sessionAuth.verifySessionAccess, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
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

    // Create a merge request record as the immutable operation ID
    const mergeId = await ctx.runMutation(internal.imageMerger.createMergeRequest, {
      sessionId: args.sessionId,
      firstLayerId: args.firstLayerId,
      secondLayerId: args.secondLayerId,
      controlLayerId: args.controlLayerId,
      mergeMode: args.mergeMode,
      status: "pending",
    });

    // Atomically reserve 1 token BEFORE external provider spending
    let tokenReserved = false;
    try {
      const reservation = await ctx.runMutation(internal.tokens.consumeTokensForOperation, {
        operationId: mergeId,
        operationType: "image-merge",
      });
      tokenReserved = reservation.charged;
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes("Insufficient tokens")
          ? "Insufficient tokens. Please purchase more tokens to continue."
          : "Unable to reserve token for image merging.";
      await ctx.runMutation(internal.imageMerger.updateMergeStatus, {
        mergeId,
        status: "failed",
        error: message,
      });
      return { success: false, error: message };
    }

    const failAndRefund = async (errorMessage: string) => {
      await ctx.runMutation(internal.imageMerger.updateMergeStatus, {
        mergeId,
        status: "failed",
        error: errorMessage,
      });
      if (tokenReserved) {
        tokenReserved = false;
        await ctx.runMutation(internal.tokens.refundTokensForOperation, {
          operationId: mergeId,
          operationType: "image-merge",
          reason: errorMessage,
        });
      }
      return { success: false as const, error: errorMessage };
    };

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
        });
        
        const secondLayerResult = await ctx.runQuery(internal.imageMerger.getLayerImageUrl, {
          sessionId: args.sessionId,
          layerId: args.secondLayerId,
          guestKey: args.guestKey,
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
          });
          
          if (controlLayerResult && controlLayerResult.url) {
            controlImageUrl = controlLayerResult.url;
          }
        }
      } catch (error) {
        console.error('[IMAGE-MERGE] Failed to get layer image URLs:', error);
        return await failAndRefund("Failed to get layer images");
      }

      // Create prediction using Replicate API
      const input: any = {
        image_1: firstImageUrl,
        image_2: secondImageUrl,
        merge_option: args.mergeMode,
        output_format: "png",
      };
      
      // Add control image if provided
      if (controlImageUrl) {
        input.control_image = controlImageUrl;
      }
      
      const requestBody = {
        version: "db2c826b6a7215fd31695acb73b5b2c91a077f88a2a264c003745e62901e2867", // fofr/image-merger latest version
        input,
      };

      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Token ${replicateToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Replicate API error:", error);
        return await failAndRefund("Failed to start image merge");
      }

      const prediction = await response.json();
      
      // Update with Replicate ID
      await ctx.runMutation(internal.imageMerger.updateMergeStatus, {
        mergeId,
        status: "processing",
        replicateId: prediction.id,
      });

      // Poll for completion
      let attempts = 0;
      const parsedTimeout = parseInt(process.env.REPLICATE_TIMEOUT_SECONDS || "180", 10);
      const maxAttempts = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 180;
      
      while (attempts < maxAttempts) {
        const statusResponse = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          {
            headers: {
              "Authorization": `Token ${replicateToken}`,
            },
          }
        );

        if (!statusResponse.ok) {
          console.error('Failed to check status, response:', await statusResponse.text());
          throw new Error("Failed to check prediction status");
        }

        const status = await statusResponse.json();

        if (status.status === "succeeded") {
          let imageUrl: string | undefined;
          if (Array.isArray(status.output)) {
            if (status.output.length > 10 && status.output.every((item: any) => typeof item === 'string' && item.length === 1)) {
              imageUrl = status.output.join('');
            } else {
              imageUrl = status.output[0];
            }
          } else if (typeof status.output === 'string') {
            imageUrl = status.output;
          } else if (status.output && typeof status.output === 'object') {
            imageUrl = status.output.url || status.output.image || status.output[0];
          }
          
          if (!imageUrl || imageUrl.length === 1) {
            return await failAndRefund("Replicate returned invalid URL. Please try again.");
          }

          let finalUrl = imageUrl;
          try {
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
              throw new Error(`Failed to download image: ${imageResponse.statusText}`);
            }
            const imageBlob = await imageResponse.blob();
            const storageId = await ctx.storage.store(imageBlob);
            const storageUrl = await ctx.storage.getUrl(storageId);
            if (storageUrl) {
              finalUrl = storageUrl;
            }
          } catch (error) {
            console.error("[IMAGE-MERGE] Error storing image:", error);
          }

          await ctx.runMutation(internal.imageMerger.updateMergeStatus, {
            mergeId,
            status: "completed",
            resultImageUrl: finalUrl,
          });
          
          return { success: true, imageUrl: finalUrl };
        } else if (status.status === "failed" || status.status === "canceled") {
          return await failAndRefund(status.error || "Merge failed");
        }

        // Wait 1 second before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      // Timeout
      return await failAndRefund("Merge timed out");

    } catch (error) {
      console.error("[IMAGE-MERGE] Image merge error:", error);
      console.error("[IMAGE-MERGE] Error details:", error instanceof Error ? error.message : String(error));
      return await failAndRefund("An error occurred during merge");
    }
  },
});

// Query to get image merges for a session
export const getSessionMerges = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey))) {
      return [];
    }
    return await ctx.db
      .query("imageMerges")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(10);
  },
});
