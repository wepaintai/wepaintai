import { v } from "convex/values";
import { mutation, action, query } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Mutation to store AI generation requests and results
export const createGenerationRequest = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    resultImageUrl: v.optional(v.string()),
    replicateId: v.optional(v.string()),
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
    console.log('[AI-GEN] generateImage action called with prompt:', args.prompt);
    console.log('[AI-GEN] Weight parameter (UI):', args.weight ?? 0.85);
    console.log('[AI-GEN] Weight parameter (Replicate):', (args.weight ?? 0.85) * 2);
    console.log('[AI-GEN] Image data length:', args.imageData.length);
    console.log('[AI-GEN] Image data starts with:', args.imageData.substring(0, 50));
    console.log('[AI-GEN] Image data type:', typeof args.imageData);
    
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
    const tokenCost = 1;
    const hasTokens = await ctx.runQuery(api.tokens.hasEnoughTokens, {
      requiredTokens: tokenCost,
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
      });

      // Convert base64 to data URL if needed
      const imageDataUrl = args.imageData.startsWith('data:') 
        ? args.imageData 
        : `data:image/png;base64,${args.imageData}`;
      
      console.log('[AI-GEN] Image data URL starts with:', imageDataUrl.substring(0, 100));
      console.log('[AI-GEN] Image data URL length:', imageDataUrl.length);
      
      // Check if the image is blank/empty by examining the base64 data
      const base64Part = imageDataUrl.split(',')[1] || args.imageData;
      // A blank canvas typically has a very small base64 string
      if (base64Part.length < 1000) {
        console.warn('[AI-GEN] WARNING: Image data seems very small, might be blank canvas');
        console.log('[AI-GEN] Base64 data sample:', base64Part.substring(0, 200));
      }
      
      // Check if it's a large image that might still be blank (all white/transparent)
      // Large blank PNGs can still have significant size due to PNG headers and compression
      console.log('[AI-GEN] Base64 length check:', {
        totalLength: base64Part.length,
        isLikelyBlank: base64Part.length < 5000,
        sample: base64Part.substring(1000, 1100) // Sample from middle to check pattern
      })

      // Convert base64 to URL by storing in Convex
      let imageUrl: string;
      try {
        console.log('[AI-GEN] Converting base64 to URL for Replicate...');
        
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
        
        console.log('[AI-GEN] Canvas image stored, URL:', imageUrl);
        console.log('[AI-GEN] Convex public URL being sent to Replicate:', imageUrl);
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
        
        console.log('[AI-GEN] Canvas dimensions:', args.canvasWidth, 'x', args.canvasHeight);
        console.log('[AI-GEN] Calculated ratio:', ratio, '-> aspect_ratio:', aspectRatio);
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
      
      console.log('[AI-GEN] Sending to Replicate:', {
        ...requestBody,
        input: {
          ...requestBody.input,
          input_image: requestBody.input.input_image.substring(0, 100) + '...' // Log only first 100 chars
        }
      });
      
      // Verify the URL is a valid Convex URL
      console.log('[AI-GEN] Image URL validation:', {
        isConvexUrl: imageUrl.includes('convex.cloud'),
        urlLength: imageUrl.length,
        hasHttps: imageUrl.startsWith('https://')
      });
      
      // Log the full API call for debugging
      console.log('[AI-GEN] Full Replicate API call:', JSON.stringify({
        url: 'https://api.replicate.com/v1/predictions',
        method: 'POST',
        headers: {
          'Authorization': 'Token [REDACTED]',
          'Content-Type': 'application/json',
        },
        body: requestBody
      }, null, 2));

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
      console.log('[AI-GEN] Created prediction:', prediction);
      
      // Update with Replicate ID
      await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
        generationId,
        status: "processing",
        replicateId: prediction.id,
      });

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 180; // 180 seconds timeout
      
      console.log('[AI-GEN] Starting to poll for prediction:', prediction.id);
      
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
        console.log('[AI-GEN] Poll attempt', attempts, 'status:', status.status);

        if (status.status === "succeeded") {
          console.log('[AI-GEN] Prediction succeeded');
          // Log the raw output to debug
          console.log('[AI-GEN] Raw status.output:', JSON.stringify(status.output));
          console.log('[AI-GEN] Status output type:', typeof status.output);
          console.log('[AI-GEN] Is output an array?', Array.isArray(status.output));
          
          // If output is array, log first few elements
          if (Array.isArray(status.output)) {
            console.log('[AI-GEN] First 10 elements:', status.output.slice(0, 10));
            console.log('[AI-GEN] Array length:', status.output.length);
          }
          
          let imageUrl;
          if (Array.isArray(status.output)) {
            // Check if it's an array of characters (Replicate bug)
            if (status.output.length > 10 && status.output.every((item: any) => typeof item === 'string' && item.length === 1)) {
              // It's an array of characters, join them
              imageUrl = status.output.join('');
              console.log('Joined character array into URL:', imageUrl);
            } else {
              // Normal array, take first element
              imageUrl = status.output[0];
              console.log('Extracted from array[0]:', imageUrl);
            }
          } else if (typeof status.output === 'string') {
            imageUrl = status.output;
            console.log('Using string directly:', imageUrl);
          } else if (status.output && typeof status.output === 'object') {
            // Check if output is an object with a property
            console.log('Output is object, keys:', Object.keys(status.output));
            imageUrl = status.output.url || status.output.image || status.output[0];
          } else {
            console.error('Unexpected output format:', status.output);
          }
          
          console.log('Final extracted image URL:', imageUrl);
          if (imageUrl) {
            try {
              // Download the image from Replicate
              const imageResponse = await fetch(imageUrl);
              if (!imageResponse.ok) {
                throw new Error(`Failed to download image: ${imageResponse.statusText}`);
              }
              
              // Get the image as a blob
              const imageBlob = await imageResponse.blob();
              console.log('Image blob size:', imageBlob.size);
              console.log('Image blob type:', imageBlob.type);
              
              // Store the image in Convex storage
              const storageId = await ctx.storage.store(imageBlob);
              console.log('Storage ID:', storageId);
              
              const storageUrl = await ctx.storage.getUrl(storageId);
              console.log('Storage URL:', storageUrl);
              console.log('Storage URL type:', typeof storageUrl);
              console.log('Original URL:', imageUrl);
              
              if (!storageUrl) {
                console.warn('Storage URL is null, using original URL');
              }
              
              const finalUrl = storageUrl || imageUrl;
              console.log('Final URL to return:', finalUrl);
              console.log('Final URL type:', typeof finalUrl);
              console.log('Final URL length:', finalUrl?.length);
              
              await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
                generationId,
                status: "completed",
                resultImageUrl: finalUrl,
              });
              
              // Consume tokens after successful generation
              await ctx.runMutation(api.tokens.useTokensForGeneration, {
                generationId,
                tokenCost,
              });
              
              const result = { success: true, imageUrl: finalUrl };
              console.log('Returning result:', JSON.stringify(result));
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
              await ctx.runMutation(api.tokens.useTokensForGeneration, {
                generationId,
                tokenCost,
              });
              
              console.log('ERROR: Using fallback due to storage error');
              console.log('Fallback imageUrl value:', imageUrl);
              console.log('Fallback imageUrl type:', typeof imageUrl);
              console.log('Fallback imageUrl length:', imageUrl?.length);
              const result = { success: true, imageUrl: imageUrl || "error-no-url" };
              console.log('Returning fallback result:', JSON.stringify(result));
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

// Action to combine two layers using Luma Photon
export const combineTwoLayers = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    layer1Id: v.string(),
    layer2Id: v.string(),
    layer1Type: v.union(v.literal("paint"), v.literal("image"), v.literal("ai-image")),
    layer2Type: v.union(v.literal("paint"), v.literal("image"), v.literal("ai-image")),
  },
  handler: async (ctx, args) => {
    console.log('[COMBINE-LAYERS] combineTwoLayers action called with:', {
      sessionId: args.sessionId,
      prompt: args.prompt,
      layer1Id: args.layer1Id,
      layer2Id: args.layer2Id,
      layer1Type: args.layer1Type,
      layer2Type: args.layer2Type
    });
    
    const identity = await ctx.auth.getUserIdentity();
    
    // Check if user is authenticated
    if (!identity) {
      console.error('[COMBINE-LAYERS] User not authenticated');
      return { success: false, error: "Please sign in to use AI generation." };
    }

    // Check if user has enough tokens (1 token per generation)
    const tokenCost = 1;
    const hasTokens = await ctx.runQuery(api.tokens.hasEnoughTokens, {
      requiredTokens: tokenCost,
    });
    
    if (!hasTokens) {
      console.error('[COMBINE-LAYERS] User does not have enough tokens');
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
      });

      // Extract images from the two layers
      const layer1ImageUrl = await extractLayerImage(ctx, args.sessionId, args.layer1Id, args.layer1Type);
      const layer2ImageUrl = await extractLayerImage(ctx, args.sessionId, args.layer2Id, args.layer2Type);
      
      if (!layer1ImageUrl || !layer2ImageUrl) {
        console.error('[COMBINE-LAYERS] Failed to extract layer images');
        await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
          generationId,
          status: "failed",
          error: "Failed to extract layer images",
        });
        return { success: false, error: "Failed to extract layer images" };
      }

      console.log('[COMBINE-LAYERS] Layer images extracted:', {
        layer1ImageUrl: layer1ImageUrl.substring(0, 100) + '...',
        layer2ImageUrl: layer2ImageUrl.substring(0, 100) + '...'
      });

      // Use fofr/image-merger model for combining layers  
      const requestBody = {
        version: "db2c826b6a7215fd31695acb73b5b2c91a077f88a2a264c003745e62901e2867", // fofr/image-merger latest version
        input: {
          image_1: layer1ImageUrl,
          image_2: layer2ImageUrl,
          prompt: args.prompt,
          image_1_strength: 1.0,
          image_2_strength: 1.0,
          merge_mode: "full",
          width: 768,
          height: 768,
          steps: 20,
          negative_prompt: "ugly, broken, distorted",
          upscale_2x: false,
          animate: false,
          return_temp_files: false
        },
      };
      
      console.log('[COMBINE-LAYERS] Sending to image-merger:', {
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
        await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
          generationId,
          status: "failed",
          error: "Failed to start generation",
        });
        return { success: false, error: "Failed to start AI generation" };
      }

      const prediction = await response.json();
      console.log('[COMBINE-LAYERS] Created prediction:', prediction);
      
      // Update with Replicate ID
      await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
        generationId,
        status: "processing",
        replicateId: prediction.id,
      });

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 180; // 180 seconds timeout
      
      console.log('[COMBINE-LAYERS] Starting to poll for prediction:', prediction.id);
      
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
        console.log('[COMBINE-LAYERS] Poll attempt', attempts, 'status:', status.status);

        if (status.status === "succeeded") {
          console.log('[COMBINE-LAYERS] Prediction succeeded');
          console.log('[COMBINE-LAYERS] Raw status.output:', JSON.stringify(status.output));
          
          let imageUrl;
          if (Array.isArray(status.output)) {
            // image-merger returns an array of file paths, take the first one
            imageUrl = status.output[0];
            console.log('[COMBINE-LAYERS] Extracted from array[0]:', imageUrl);
          } else if (typeof status.output === 'string') {
            imageUrl = status.output;
            console.log('[COMBINE-LAYERS] Using string directly:', imageUrl);
          } else if (status.output && typeof status.output === 'object') {
            // Check if output is an object with a property
            console.log('[COMBINE-LAYERS] Output is object, keys:', Object.keys(status.output));
            imageUrl = status.output.url || status.output.image || status.output[0];
          } else {
            console.error('[COMBINE-LAYERS] Unexpected output format:', status.output);
          }
          
          console.log('[COMBINE-LAYERS] Final extracted image URL:', imageUrl);
          if (imageUrl) {
            try {
              // Download the image from Replicate
              const imageResponse = await fetch(imageUrl);
              if (!imageResponse.ok) {
                throw new Error(`Failed to download image: ${imageResponse.statusText}`);
              }
              
              // Get the image as a blob
              const imageBlob = await imageResponse.blob();
              console.log('[COMBINE-LAYERS] Image blob size:', imageBlob.size);
              
              // Store the image in Convex storage
              const storageId = await ctx.storage.store(imageBlob);
              console.log('[COMBINE-LAYERS] Storage ID:', storageId);
              
              const storageUrl = await ctx.storage.getUrl(storageId);
              console.log('[COMBINE-LAYERS] Storage URL:', storageUrl);
              
              if (!storageUrl) {
                console.warn('[COMBINE-LAYERS] Storage URL is null, using original URL');
              }
              
              const finalUrl = storageUrl || imageUrl;
              console.log('[COMBINE-LAYERS] Final URL to return:', finalUrl);
              
              await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
                generationId,
                status: "completed",
                resultImageUrl: finalUrl,
              });
              
              // Consume tokens after successful generation
              await ctx.runMutation(api.tokens.useTokensForGeneration, {
                generationId,
                tokenCost,
              });
              
              const result = { success: true, imageUrl: finalUrl };
              console.log('[COMBINE-LAYERS] Returning result:', JSON.stringify(result));
              return result;
            } catch (error) {
              console.error("[COMBINE-LAYERS] Error storing image:", error);
              
              // Check if imageUrl is just "h" (Replicate bug)
              if (imageUrl === "h" || imageUrl?.length === 1) {
                console.error("[COMBINE-LAYERS] DETECTED REPLICATE BUG: URL is single character");
                return { success: false, error: "Replicate returned invalid URL. Please try again." };
              }
              
              // Fallback to using the Replicate URL directly
              await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
                generationId,
                status: "completed",
                resultImageUrl: imageUrl,
              });
              
              // Consume tokens after successful generation
              await ctx.runMutation(api.tokens.useTokensForGeneration, {
                generationId,
                tokenCost,
              });
              
              console.log('[COMBINE-LAYERS] Using fallback due to storage error');
              const result = { success: true, imageUrl: imageUrl || "error-no-url" };
              console.log('[COMBINE-LAYERS] Returning fallback result:', JSON.stringify(result));
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
      console.error("[COMBINE-LAYERS] AI generation error:", error);
      console.error("[COMBINE-LAYERS] Error details:", error instanceof Error ? error.message : String(error));
      return { success: false, error: "An error occurred during generation" };
    }
  },
});

// Helper function to extract image from a layer
async function extractLayerImage(
  ctx: any,
  sessionId: Id<"paintingSessions">,
  layerId: string,
  layerType: "paint" | "image" | "ai-image"
): Promise<string | null> {
  console.log('[COMBINE-LAYERS] Extracting image for layer:', { layerId, layerType });
  
  if (layerType === "paint") {
    // For paint layers, we need to render the strokes as an image
    // This is a simplified approach - for now we'll return an error
    console.log('[COMBINE-LAYERS] Paint layer extraction not implemented - would need canvas rendering');
    return null; // TODO: Implement paint layer rendering by capturing canvas content
  } else if (layerType === "image") {
    // For uploaded image layers, get from session images
    const sessionImages = await ctx.runQuery(api.images.getSessionImages, { sessionId });
    
    // Find the uploaded image by ID
    const image = sessionImages.find((img: any) => img._id === layerId && img.type === 'uploaded');
    
    if (image && image.url) {
      console.log('[COMBINE-LAYERS] Found uploaded image URL:', image.url.substring(0, 100) + '...');
      return image.url;
    }
  } else if (layerType === "ai-image") {
    // For AI-generated image layers, get from session images
    const sessionImages = await ctx.runQuery(api.images.getSessionImages, { sessionId });
    
    // Find the AI image by ID
    const aiImage = sessionImages.find((img: any) => img._id === layerId && img.type === 'ai-generated');
    
    if (aiImage && aiImage.url) {
      console.log('[COMBINE-LAYERS] Found AI image URL:', aiImage.url.substring(0, 100) + '...');
      return aiImage.url;
    }
  }
  
  console.log('[COMBINE-LAYERS] Could not extract image for layer:', layerId);
  return null;
}

// Query to get AI generations for a session
export const getSessionGenerations = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("aiGenerations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(10);
  },
});