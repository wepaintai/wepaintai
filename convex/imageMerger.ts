import { v } from "convex/values";
import { mutation, action, query } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Mutation to store image merge requests and results
export const createMergeRequest = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    firstLayerId: v.string(),
    secondLayerId: v.string(),
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
      mergeMode: args.mergeMode,
      status: args.status,
      error: args.error,
      resultImageUrl: args.resultImageUrl,
      replicateId: args.replicateId,
      createdAt: Date.now(),
    });
  },
});

// Update merge status
export const updateMergeStatus = mutation({
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

// Query to get layer image URL
export const getLayerImageUrl = query({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.string(),
  },
  handler: async (ctx, args) => {
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
    mergeMode: v.union(v.literal("full"), v.literal("left_right"), v.literal("top_bottom")),
  },
  handler: async (ctx, args) => {
    console.log('[IMAGE-MERGE] mergeImages action called with:', {
      firstLayerId: args.firstLayerId,
      secondLayerId: args.secondLayerId,
      mergeMode: args.mergeMode
    });
    
    const identity = await ctx.auth.getUserIdentity();
    
    // Check if user is authenticated
    if (!identity) {
      console.error('[IMAGE-MERGE] User not authenticated');
      return { success: false, error: "Please sign in to use image merging." };
    }

    // Check if user has enough tokens (1 token per merge)
    const tokenCost = 1;
    const hasTokens = await ctx.runQuery(api.tokens.hasEnoughTokens, {
      requiredTokens: tokenCost,
    });
    
    if (!hasTokens) {
      console.error('[IMAGE-MERGE] User does not have enough tokens');
      return { success: false, error: "Insufficient tokens. Please purchase more tokens to continue." };
    }

    // Get Replicate API token from environment
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) {
      console.error("REPLICATE_API_TOKEN not configured");
      return { success: false, error: "Image merging not configured" };
    }

    try {
      // Create a merge request record
      const mergeId = await ctx.runMutation(api.imageMerger.createMergeRequest, {
        sessionId: args.sessionId,
        firstLayerId: args.firstLayerId,
        secondLayerId: args.secondLayerId,
        mergeMode: args.mergeMode,
        status: "pending",
      });

      // Get the image URLs for both layers
      let firstImageUrl: string;
      let secondImageUrl: string;
      
      try {
        const firstLayerResult = await ctx.runQuery(api.imageMerger.getLayerImageUrl, {
          sessionId: args.sessionId,
          layerId: args.firstLayerId,
        });
        
        const secondLayerResult = await ctx.runQuery(api.imageMerger.getLayerImageUrl, {
          sessionId: args.sessionId,
          layerId: args.secondLayerId,
        });
        
        if (!firstLayerResult || !firstLayerResult.url) {
          throw new Error(`First layer ${args.firstLayerId} not found or has no URL`);
        }
        
        if (!secondLayerResult || !secondLayerResult.url) {
          throw new Error(`Second layer ${args.secondLayerId} not found or has no URL`);
        }
        
        firstImageUrl = firstLayerResult.url;
        secondImageUrl = secondLayerResult.url;
        
        console.log('[IMAGE-MERGE] Retrieved image URLs:', {
          firstImageUrl: firstImageUrl?.substring(0, 100) + '...',
          secondImageUrl: secondImageUrl?.substring(0, 100) + '...',
          firstType: firstLayerResult.type,
          secondType: secondLayerResult.type,
        });
      } catch (error) {
        console.error('[IMAGE-MERGE] Failed to get layer image URLs:', error);
        await ctx.runMutation(api.imageMerger.updateMergeStatus, {
          mergeId,
          status: "failed",
          error: "Failed to get layer images",
        });
        return { success: false, error: "Failed to get layer images" };
      }

      // Create prediction using Replicate API
      const requestBody = {
        version: "db2c826b6a7215fd31695acb73b5b2c91a077f88a2a264c003745e62901e2867", // fofr/image-merger latest version
        input: {
          image_1: firstImageUrl,
          image_2: secondImageUrl,
          merge_option: args.mergeMode,
          output_format: "png",
        },
      };
      
      console.log('[IMAGE-MERGE] Sending to Replicate:', {
        ...requestBody,
        input: {
          ...requestBody.input,
          image_1: requestBody.input.image_1.substring(0, 100) + '...',
          image_2: requestBody.input.image_2.substring(0, 100) + '...'
        }
      });

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
        await ctx.runMutation(api.imageMerger.updateMergeStatus, {
          mergeId,
          status: "failed",
          error: "Failed to start merge",
        });
        return { success: false, error: "Failed to start image merge" };
      }

      const prediction = await response.json();
      console.log('[IMAGE-MERGE] Created prediction:', prediction);
      
      // Update with Replicate ID
      await ctx.runMutation(api.imageMerger.updateMergeStatus, {
        mergeId,
        status: "processing",
        replicateId: prediction.id,
      });

      // Poll for completion
      let attempts = 0;
      const maxAttempts = parseInt(process.env.REPLICATE_TIMEOUT_SECONDS || "180"); // Default 180 seconds timeout
      
      console.log('[IMAGE-MERGE] Starting to poll for prediction:', prediction.id);
      
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
        console.log('[IMAGE-MERGE] Poll attempt', attempts, 'status:', status.status);

        if (status.status === "succeeded") {
          console.log('[IMAGE-MERGE] Prediction succeeded');
          console.log('[IMAGE-MERGE] Raw status.output:', JSON.stringify(status.output));
          
          let imageUrl;
          if (Array.isArray(status.output)) {
            // Check if it's an array of characters (Replicate bug)
            if (status.output.length > 10 && status.output.every((item: any) => typeof item === 'string' && item.length === 1)) {
              // It's an array of characters, join them
              imageUrl = status.output.join('');
              console.log('[IMAGE-MERGE] Joined character array into URL:', imageUrl);
            } else {
              // Normal array, take first element
              imageUrl = status.output[0];
              console.log('[IMAGE-MERGE] Extracted from array[0]:', imageUrl);
            }
          } else if (typeof status.output === 'string') {
            imageUrl = status.output;
            console.log('[IMAGE-MERGE] Using string directly:', imageUrl);
          } else if (status.output && typeof status.output === 'object') {
            // Check if output is an object with a property
            console.log('[IMAGE-MERGE] Output is object, keys:', Object.keys(status.output));
            imageUrl = status.output.url || status.output.image || status.output[0];
          } else {
            console.error('[IMAGE-MERGE] Unexpected output format:', status.output);
          }
          
          console.log('[IMAGE-MERGE] Final extracted image URL:', imageUrl);
          if (imageUrl) {
            try {
              // Download the image from Replicate
              const imageResponse = await fetch(imageUrl);
              if (!imageResponse.ok) {
                throw new Error(`Failed to download image: ${imageResponse.statusText}`);
              }
              
              // Get the image as a blob
              const imageBlob = await imageResponse.blob();
              console.log('[IMAGE-MERGE] Image blob size:', imageBlob.size);
              console.log('[IMAGE-MERGE] Image blob type:', imageBlob.type);
              
              // Store the image in Convex storage
              const storageId = await ctx.storage.store(imageBlob);
              console.log('[IMAGE-MERGE] Storage ID:', storageId);
              
              const storageUrl = await ctx.storage.getUrl(storageId);
              console.log('[IMAGE-MERGE] Storage URL:', storageUrl);
              
              if (!storageUrl) {
                console.warn('[IMAGE-MERGE] Storage URL is null, using original URL');
              }
              
              const finalUrl = storageUrl || imageUrl;
              console.log('[IMAGE-MERGE] Final URL to return:', finalUrl);
              
              await ctx.runMutation(api.imageMerger.updateMergeStatus, {
                mergeId,
                status: "completed",
                resultImageUrl: finalUrl,
              });
              
              // Consume tokens after successful merge
              await ctx.runMutation(api.tokens.useTokensForOperation, {
                operationId: mergeId,
                operationType: "image-merge",
                tokenCost,
              });
              
              const result = { success: true, imageUrl: finalUrl };
              console.log('[IMAGE-MERGE] Returning result:', JSON.stringify(result));
              return result;
            } catch (error) {
              console.error("[IMAGE-MERGE] Error storing image:", error);
              console.error("[IMAGE-MERGE] Image URL that failed:", imageUrl);
              
              // Check if imageUrl is just a single character (Replicate bug)
              if (imageUrl?.length === 1) {
                console.error("[IMAGE-MERGE] DETECTED REPLICATE BUG: URL is single character");
                return { success: false, error: "Replicate returned invalid URL. Please try again." };
              }
              
              // Fallback to using the Replicate URL directly
              await ctx.runMutation(api.imageMerger.updateMergeStatus, {
                mergeId,
                status: "completed",
                resultImageUrl: imageUrl,
              });
              
              // Consume tokens after successful merge
              await ctx.runMutation(api.tokens.useTokensForOperation, {
                operationId: mergeId,
                operationType: "image-merge",
                tokenCost,
              });
              
              console.log('[IMAGE-MERGE] Using fallback due to storage error');
              const result = { success: true, imageUrl: imageUrl || "error-no-url" };
              console.log('[IMAGE-MERGE] Returning fallback result:', JSON.stringify(result));
              return result;
            }
          }
        } else if (status.status === "failed" || status.status === "canceled") {
          await ctx.runMutation(api.imageMerger.updateMergeStatus, {
            mergeId,
            status: "failed",
            error: status.error || "Merge failed",
          });
          return { success: false, error: status.error || "Merge failed" };
        }

        // Wait 1 second before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      // Timeout
      await ctx.runMutation(api.imageMerger.updateMergeStatus, {
        mergeId,
        status: "failed",
        error: "Merge timed out",
      });
      return { success: false, error: "Merge timed out" };

    } catch (error) {
      console.error("[IMAGE-MERGE] Image merge error:", error);
      console.error("[IMAGE-MERGE] Error details:", error instanceof Error ? error.message : String(error));
      return { success: false, error: "An error occurred during merge" };
    }
  },
});

// Query to get image merges for a session
export const getSessionMerges = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("imageMerges")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(10);
  },
});