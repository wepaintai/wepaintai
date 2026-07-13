import { v } from "convex/values";
import { mutation, action, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Verbose logging of prompts and image-data samples is a privacy concern in
// shared logs; opt in with AI_GEN_DEBUG=true on the deployment.
const AI_GEN_DEBUG = process.env.AI_GEN_DEBUG === "true";
function debugLog(...args: unknown[]) {
  if (AI_GEN_DEBUG) console.log(...args);
}

// Mutation to store AI generation requests and results
export const createGenerationRequest = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    resultImageUrl: v.optional(v.string()),
    replicateId: v.optional(v.string()),
    provider: v.optional(v.union(v.literal("replicate"), v.literal("gemini"))),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    
    return await ctx.db.insert("aiGenerations", {
      sessionId: args.sessionId,
      userId: identity?.subject,
      prompt: args.prompt,
      status: args.status,
      error: args.error,
      resultImageUrl: args.resultImageUrl,
      replicateId: args.replicateId,
      provider: args.provider,
      createdAt: Date.now(),
    });
  },
});

// Update generation status
export const updateGenerationStatus = mutation({
  args: {
    generationId: v.id("aiGenerations"),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    resultImageUrl: v.optional(v.string()),
    replicateId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.generationId, {
      status: args.status,
      error: args.error,
      resultImageUrl: args.resultImageUrl,
      replicateId: args.replicateId,
    });
  },
});

// Main action to generate image using Replicate
export const generateImage = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    imageData: v.string(), // base64 encoded image
    weight: v.optional(v.number()), // Optional weight parameter (0-1)
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    debugLog('[AI-GEN] generateImage action called with prompt:', args.prompt);
    debugLog('[AI-GEN] Weight parameter (UI):', args.weight ?? 0.85);
    debugLog('[AI-GEN] Weight parameter (Replicate):', (args.weight ?? 0.85) * 2);
    debugLog('[AI-GEN] Image data length:', args.imageData.length);
    
    // Check if imageData is empty or too small
    if (!args.imageData || args.imageData.length < 100) {
      console.error('[AI-GEN] ERROR: Image data is empty or too small!');
      return { success: false, error: "Canvas data is empty" };
    }
    
    // Test return to isolate the issue
    // return { success: true, imageUrl: "https://example.com/test.jpg" };
    
    const identity = await ctx.auth.getUserIdentity();
    
    // Check if user is authenticated
    if (!identity) {
      console.error('[AI-GEN] User not authenticated');
      return { success: false, error: "Please sign in to use AI generation." };
    }

    // Check if user has enough tokens (1 token per generation)
    const hasTokens = await ctx.runQuery(internal.tokens.hasEnoughTokensForOperation, {
      operationType: "ai-generation",
    });
    
    if (!hasTokens) {
      console.error('[AI-GEN] User does not have enough tokens');
      return { success: false, error: "Insufficient tokens. Please purchase more tokens to continue." };
    }

    // Get Replicate API token from environment
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) {
      console.error("REPLICATE_API_TOKEN not configured");
      return { success: false, error: "AI generation not configured" };
    }

    try {
      // Create a generation request record
      const generationId = await ctx.runMutation(api.aiGeneration.createGenerationRequest, {
        sessionId: args.sessionId,
        prompt: args.prompt,
        status: "pending",
        provider: "replicate",
      });

      // Convert base64 to data URL if needed
      const imageDataUrl = args.imageData.startsWith('data:') 
        ? args.imageData 
        : `data:image/png;base64,${args.imageData}`;
      
      // A blank canvas typically has a very small base64 string
      const base64Part = imageDataUrl.split(',')[1] || args.imageData;
      if (base64Part.length < 1000) {
        console.warn('[AI-GEN] WARNING: Image data seems very small, might be blank canvas');
      }

      // Convert base64 to URL by storing in Convex
      let imageUrl: string;
      try {
        debugLog('[AI-GEN] Converting base64 to URL for Replicate...');

        // Extract base64 data
        const base64Data = imageDataUrl.startsWith('data:') 
          ? imageDataUrl.split(',')[1] 
          : args.imageData;
        
        // Convert base64 to blob
        // First, convert base64 to binary
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Create blob from bytes
        const blob = new Blob([bytes], { type: 'image/png' });
        
        // Store in Convex storage
        const storageId = await ctx.storage.store(blob);
        const url = await ctx.storage.getUrl(storageId);
        
        if (!url) {
          throw new Error('Failed to get storage URL');
        }
        
        imageUrl = url;
        
        debugLog('[AI-GEN] Canvas image stored, URL:', imageUrl);
      } catch (error) {
        console.error('[AI-GEN] Failed to store canvas image:', error);
        return { success: false, error: 'Failed to store canvas image' };
      }

      // Calculate aspect ratio from canvas dimensions
      let aspectRatio = "1:1"; // default
      if (args.canvasWidth && args.canvasHeight) {
        const ratio = args.canvasWidth / args.canvasHeight;
        // Map to closest supported aspect ratio
        if (ratio < 0.6) aspectRatio = "9:16";
        else if (ratio < 0.8) aspectRatio = "2:3";
        else if (ratio < 1.2) aspectRatio = "1:1";
        else if (ratio < 1.5) aspectRatio = "3:2";
        else aspectRatio = "16:9";
        
        debugLog('[AI-GEN] Canvas dimensions:', args.canvasWidth, 'x', args.canvasHeight, '-> aspect_ratio:', aspectRatio);
      }

      // Get model version from environment or use default
      const modelVersion = process.env.REPLICATE_MODEL_VERSION || "15589a1a9e6b240d246752fc688267b847db4858910cc390794703384b6a5443";
      
      // Create prediction using Replicate API with URL
      const requestBody = {
        version: modelVersion, // Flux Kontext Pro version
        input: {
          prompt: args.prompt,
          input_image: imageUrl, // Use input_image as per Replicate API
          aspect_ratio: aspectRatio,
          output_format: "png",
          safety_tolerance: 2, // Limited to 2 when using input images
          weight: (args.weight ?? 0.85) * 2, // Map 0-1 range to 0-2 for Replicate
        },
      };
      
      debugLog('[AI-GEN] Sending to Replicate:', {
        ...requestBody,
        input: {
          ...requestBody.input,
          input_image: requestBody.input.input_image.substring(0, 100) + '...' // Log only first 100 chars
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
        await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
          generationId,
          status: "failed",
          error: "Failed to start generation",
        });
        return { success: false, error: "Failed to start AI generation" };
      }

      const prediction = await response.json();
      debugLog('[AI-GEN] Created prediction:', prediction.id);
      
      // Update with Replicate ID
      await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
        generationId,
        status: "processing",
        replicateId: prediction.id,
      });

      // Poll for completion
      let attempts = 0;
      const maxAttempts = parseInt(process.env.REPLICATE_TIMEOUT_SECONDS || "180"); // Default 180 seconds timeout
      
      debugLog('[AI-GEN] Starting to poll for prediction:', prediction.id);
      
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
        debugLog('[AI-GEN] Poll attempt', attempts, 'status:', status.status);

        if (status.status === "succeeded") {
          debugLog('[AI-GEN] Prediction succeeded, raw output:', JSON.stringify(status.output)?.substring(0, 200));

          let imageUrl;
          if (Array.isArray(status.output)) {
            // Check if it's an array of characters (Replicate bug)
            if (status.output.length > 10 && status.output.every((item: any) => typeof item === 'string' && item.length === 1)) {
              // It's an array of characters, join them
              imageUrl = status.output.join('');
              debugLog('Joined character array into URL:', imageUrl);
            } else {
              // Normal array, take first element
              imageUrl = status.output[0];
              debugLog('Extracted from array[0]:', imageUrl);
            }
          } else if (typeof status.output === 'string') {
            imageUrl = status.output;
            debugLog('Using string directly:', imageUrl);
          } else if (status.output && typeof status.output === 'object') {
            // Check if output is an object with a property
            debugLog('Output is object, keys:', Object.keys(status.output));
            imageUrl = status.output.url || status.output.image || status.output[0];
          } else {
            console.error('Unexpected output format:', status.output);
          }
          
          debugLog('Final extracted image URL:', imageUrl);
          if (imageUrl) {
            try {
              // Download the image from Replicate
              const imageResponse = await fetch(imageUrl);
              if (!imageResponse.ok) {
                throw new Error(`Failed to download image: ${imageResponse.statusText}`);
              }
              
              // Get the image as a blob
              const imageBlob = await imageResponse.blob();
              debugLog('Image blob size:', imageBlob.size);
              debugLog('Image blob type:', imageBlob.type);
              
              // Store the image in Convex storage
              const storageId = await ctx.storage.store(imageBlob);
              debugLog('Storage ID:', storageId);
              
              const storageUrl = await ctx.storage.getUrl(storageId);
              debugLog('Storage URL:', storageUrl);
              debugLog('Storage URL type:', typeof storageUrl);
              debugLog('Original URL:', imageUrl);
              
              if (!storageUrl) {
                console.warn('Storage URL is null, using original URL');
              }
              
              const finalUrl = storageUrl || imageUrl;
              debugLog('Final URL to return:', finalUrl);
              debugLog('Final URL type:', typeof finalUrl);
              debugLog('Final URL length:', finalUrl?.length);
              
              await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
                generationId,
                status: "completed",
                resultImageUrl: finalUrl,
              });
              
              // Consume tokens after successful generation
              await ctx.runMutation(internal.tokens.consumeTokensForOperation, {
                operationId: generationId,
                operationType: "ai-generation",
              });
              
              const result = { success: true, imageUrl: finalUrl };
              debugLog('Returning result:', JSON.stringify(result));
              return result;
            } catch (error) {
              console.error("Error storing image:", error);
              console.error("Image URL that failed:", imageUrl);
              
              // Check if imageUrl is just "h" (Replicate bug)
              if (imageUrl === "h" || imageUrl?.length === 1) {
                console.error("DETECTED REPLICATE BUG: URL is single character");
                // This is likely the Replicate bug, return error
                return { success: false, error: "Replicate returned invalid URL. Please try again." };
              }
              
              // Fallback to using the Replicate URL directly
              await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
                generationId,
                status: "completed",
                resultImageUrl: imageUrl,
              });
              
              // Consume tokens after successful generation
              await ctx.runMutation(internal.tokens.consumeTokensForOperation, {
                operationId: generationId,
                operationType: "ai-generation",
              });
              
              debugLog('ERROR: Using fallback due to storage error');
              debugLog('Fallback imageUrl value:', imageUrl);
              debugLog('Fallback imageUrl type:', typeof imageUrl);
              debugLog('Fallback imageUrl length:', imageUrl?.length);
              const result = { success: true, imageUrl: imageUrl || "error-no-url" };
              debugLog('Returning fallback result:', JSON.stringify(result));
              return result;
            }
          }
        } else if (status.status === "failed" || status.status === "canceled") {
          await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
            generationId,
            status: "failed",
            error: status.error || "Generation failed",
          });
          return { success: false, error: status.error || "Generation failed" };
        }

        // Wait 1 second before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      // Timeout
      await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
        generationId,
        status: "failed",
        error: "Generation timed out",
      });
      return { success: false, error: "Generation timed out" };

    } catch (error) {
      console.error("AI generation error:", error);
      console.error("Error details:", error instanceof Error ? error.message : String(error));
      return { success: false, error: "An error occurred during generation" };
    }
  },
});

// Query to get recent completed AI generations for a session (newest first)
export const getSessionGenerations = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return [];
    }
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      let authorized = false;
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
          .first();
        authorized = !!user && session.createdBy === user._id;
      }
      if (!authorized) {
        if (!(session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey)) {
          return [];
        }
      }
    }
    // Take a larger window then filter, so a run of failed/moderated rows
    // doesn't shrink the strip; then keep the 10 most recent usable results.
    // Only Convex-storage URLs are usable — direct Replicate URLs (the
    // storage-failure fallback) expire and would render as broken thumbnails.
    const generations = await ctx.db
      .query("aiGenerations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(50);
    return generations
      .filter(
        (g) =>
          g.status === "completed" &&
          g.resultImageUrl &&
          g.resultImageUrl.includes("/api/storage/")
      )
      .slice(0, 10)
      .map((g) => ({
        _id: g._id,
        prompt: g.prompt,
        resultImageUrl: g.resultImageUrl as string,
        provider: g.provider,
        createdAt: g.createdAt,
      }));
  },
});
