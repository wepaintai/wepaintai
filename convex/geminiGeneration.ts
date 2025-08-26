import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";

// Generate an image using Gemini 2.5 Flash Image (preview)
export const generateImage = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    imageData: v.string(), // data URL or base64 PNG
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log('[GEMINI] generateImage called with prompt:', args.prompt);

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.error('[GEMINI] User not authenticated');
      return { success: false, error: "Please sign in to use AI generation." };
    }

    // Token gating: 1 token per generation to match Replicate
    const tokenCost = 1;
    const hasTokens = await ctx.runQuery(api.tokens.hasEnoughTokens, { requiredTokens: tokenCost });
    if (!hasTokens) {
      console.error('[GEMINI] Insufficient tokens');
      return { success: false, error: "Insufficient tokens. Please purchase more tokens to continue." };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[GEMINI] GEMINI_API_KEY not configured');
      return { success: false, error: "AI generation not configured" };
    }

    // Create a generation request record
    const generationId = await ctx.runMutation(api.aiGeneration.createGenerationRequest, {
      sessionId: args.sessionId,
      prompt: args.prompt,
      status: "pending",
      provider: "gemini",
    });

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

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=${apiKey}`;

      console.log('[GEMINI] Sending request to Gemini endpoint');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GEMINI] API error:', errorText);
        await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
          generationId,
          status: 'failed',
          error: 'Failed to start generation',
        });
        return { success: false, error: 'Failed to start AI generation' };
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
        await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
          generationId,
          status: 'failed',
          error: 'No image data returned from Gemini',
        });
        return { success: false, error: 'No image data returned from Gemini' };
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

      await ctx.runMutation(api.aiGeneration.updateGenerationStatus, {
        generationId,
        status: 'completed',
        resultImageUrl: storageUrl || '',
      });

      // Consume tokens on success
      await ctx.runMutation(api.tokens.useTokensForGeneration, {
        generationId,
        tokenCost,
      });

      return { success: true, imageUrl: storageUrl };
    } catch (error) {
      console.error('[GEMINI] Generation error:', error);
      return { success: false, error: 'An error occurred during generation' };
    }
  },
});

