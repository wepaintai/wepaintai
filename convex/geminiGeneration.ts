import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

// Generate an image using Gemini 2.5 Flash Image (preview)
export const generateImage = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    imageData: v.string(), // data URL or base64 PNG
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log('[GEMINI] generateImage called with prompt:', args.prompt);

    const access = await ctx.runQuery(internal.sessionAuth.verifySessionAccess, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      requireAuth: true,
    });
    if (access.status === "not_found") {
      return { success: false, error: "Session not found" };
    }
    if (access.status === "unauthenticated") {
      console.error('[GEMINI] User not authenticated');
      return { success: false, error: "Please sign in to use AI generation." };
    }
    if (access.status !== "ok") {
      return { success: false, error: "Unauthorized" };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[GEMINI] GEMINI_API_KEY not configured');
      return { success: false, error: "AI generation not configured" };
    }

    // Create a generation request record as the immutable operation ID
    const generationId = await ctx.runMutation(internal.aiGeneration.createGenerationRequest, {
      sessionId: args.sessionId,
      prompt: args.prompt,
      status: "pending",
      provider: "gemini",
    });

    // Atomically reserve 1 token BEFORE calling Gemini
    let tokenReserved = false;
    try {
      const reservation = await ctx.runMutation(internal.tokens.consumeTokensForOperation, {
        operationId: generationId,
        operationType: "ai-generation",
      });
      tokenReserved = reservation.charged;
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes("Insufficient tokens")
          ? "Insufficient tokens. Please purchase more tokens to continue."
          : "Unable to reserve token for AI generation.";
      await ctx.runMutation(internal.aiGeneration.updateGenerationStatus, {
        generationId,
        status: "failed",
        error: message,
      });
      return { success: false, error: message };
    }

    const failAndRefund = async (errorMessage: string) => {
      await ctx.runMutation(internal.aiGeneration.updateGenerationStatus, {
        generationId,
        status: 'failed',
        error: errorMessage,
      });
      if (tokenReserved) {
        tokenReserved = false;
        await ctx.runMutation(internal.tokens.refundTokensForOperation, {
          operationId: generationId,
          operationType: "ai-generation",
          reason: errorMessage,
        });
      }
      return { success: false as const, error: errorMessage };
    };

    try {
      // Normalize to base64 without data URL prefix
      const imageDataUrl = args.imageData.startsWith('data:') ? args.imageData : `data:image/png;base64,${args.imageData}`;
      const base64Data = imageDataUrl.split(',')[1] || args.imageData;

      // Build request body for native image editing (image + text parts)
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inline_data: {
                  mime_type: 'image/png',
                  data: base64Data,
                },
              },
              { text: args.prompt },
            ],
          },
        ],
      };

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GEMINI] API error:', errorText);
        return await failAndRefund('Failed to start AI generation');
      }

      const json = await response.json();
      // Extract inline image data from candidates
      let imageBase64: string | null = null;
      try {
        const parts = json?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          const inlineData = part?.inlineData || part?.inline_data;
          if (inlineData?.data) {
            imageBase64 = inlineData.data as string;
            break;
          }
        }
      } catch (e) {
        console.error('[GEMINI] Failed parsing response parts', e);
      }

      if (!imageBase64) {
        console.error('[GEMINI] No image data in response');
        return await failAndRefund('No image data returned from Gemini');
      }

      // Convert base64 to Blob and store in Convex storage
      const binaryString = atob(imageBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'image/png' });
      const storageId = await ctx.storage.store(blob);
      const storageUrl = await ctx.storage.getUrl(storageId);

      if (!storageUrl) {
        return await failAndRefund('Failed to store generated image');
      }

      await ctx.runMutation(internal.aiGeneration.updateGenerationStatus, {
        generationId,
        status: 'completed',
        resultImageUrl: storageUrl,
      });

      return { success: true, imageUrl: storageUrl };
    } catch (error) {
      console.error('[GEMINI] Generation error:', error);
      return await failAndRefund('An error occurred during generation');
    }
  },
});
