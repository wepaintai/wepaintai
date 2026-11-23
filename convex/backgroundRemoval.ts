import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

export const removeBackground = action({
  args: {
    sessionId: v.id("paintingSessions"),
    imageData: v.string(),
    targetLayerId: v.optional(v.string()),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[BG-REMOVAL] Starting background removal process");

    const access = await ctx.runQuery(internal.sessionAuth.verifySessionAccess, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      requireAuth: true,
    });

    if (access.status === "not_found") {
      throw new Error("Session not found");
    }
    if (access.status === "unauthenticated") {
      throw new Error("Authentication required for background removal");
    }
    if (access.status !== "ok") {
      throw new Error("You don't have permission to edit this painting");
    }

    // Get Replicate API token from environment before reserving tokens
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) {
      throw new Error("Replicate API token not configured");
    }

    // Reserve 1 token atomically BEFORE any external provider spending
    const operationId = `bg-${Date.now()}-${crypto.randomUUID()}`;
    let tokenReserved: boolean;
    try {
      const reservation = await ctx.runMutation(internal.tokens.consumeTokensForOperation, {
        operationId,
        operationType: "background-removal",
        sessionId: args.sessionId,
        targetLayerId: args.targetLayerId,
      });
      tokenReserved = reservation.charged;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Insufficient tokens")) {
        throw new Error("Insufficient tokens. Background removal costs 1 token.");
      }
      throw error;
    }

    try {
      console.log("[BG-REMOVAL] Running Replicate model...");
      
      // Create prediction using Replicate API
      const requestBody = {
        version: "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
        input: {
          image: args.imageData,
        }
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
        console.error("[BG-REMOVAL] Replicate API error:", error);
        throw new Error("Failed to start background removal");
      }

      const prediction = await response.json();
      console.log("[BG-REMOVAL] Created prediction:", prediction);

      // Poll for completion
      let attempts = 0;
      const parsedTimeout = parseInt(process.env.REPLICATE_TIMEOUT_SECONDS || "180", 10);
      const maxAttempts = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 180;
      let output: any;

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
          throw new Error("Failed to check prediction status");
        }

        const status = await statusResponse.json();
        console.log(`[BG-REMOVAL] Status after ${attempts} attempts:`, status.status);

        if (status.status === "succeeded") {
          output = status.output;
          console.log("[BG-REMOVAL] Model output:", output);
          break;
        } else if (status.status === "failed" || status.status === "canceled") {
          throw new Error(status.error || "Background removal failed");
        }

        // Wait 1 second before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      if (!output) {
        throw new Error("Background removal timed out");
      }

      // Handle the output URL (similar to AI generation)
      let outputUrl: string;
      if (Array.isArray(output)) {
        if (output.length > 10 && output.every(char => typeof char === 'string' && char.length === 1)) {
          // Handle character array bug
          outputUrl = output.join('');
          console.log("[BG-REMOVAL] Fixed character array URL:", outputUrl);
        } else if (typeof output[0] === 'string') {
          outputUrl = output[0];
        } else {
          throw new Error("Unexpected output format from Replicate");
        }
      } else if (typeof output === 'string') {
        outputUrl = output;
      } else {
        throw new Error("Unexpected output format from Replicate");
      }

      // Store the image in Convex storage
      console.log("[BG-REMOVAL] Fetching image from URL:", outputUrl);
      const imageResponse = await fetch(outputUrl);
      
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch generated image: ${imageResponse.statusText}`);
      }

      const imageBlob = await imageResponse.blob();
      const storageId = await ctx.storage.store(imageBlob);
      const storageUrl = await ctx.storage.getUrl(storageId);

      if (!storageUrl) {
        throw new Error("Failed to get storage URL");
      }

      console.log("[BG-REMOVAL] Background removal successful");
      
      return {
        success: true as const,
        imageUrl: storageUrl,
        storageId,
      };
    } catch (error) {
      if (tokenReserved) {
        await ctx.runMutation(internal.tokens.refundTokensForOperation, {
          operationId,
          operationType: "background-removal",
          reason: error instanceof Error ? error.message : "Background removal failed",
        });
      }
      console.error("[BG-REMOVAL] Error:", error);
      
      if (error instanceof Error) {
        if (error.message.includes("E005")) {
          throw new Error("Content moderation flagged this image. Please try a different image.");
        }
        throw error;
      }
      
      throw new Error("Failed to remove background");
    }
  },
});
