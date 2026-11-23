import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { beginErrorMessage } from "./aiOperations";
import { isPromptTooLong, MAX_PROMPT_LENGTH } from "./tokenPolicy";
import { BILLED_FAILURE_NOTE, REFUNDED_FAILURE_NOTE } from "./replicate";

// Generate an image using Gemini 2.5 Flash Image (preview)
export const generateImage = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    imageData: v.string(), // data URL or base64 PNG
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; imageUrl?: string; error?: string }> => {
    if (isPromptTooLong(args.prompt)) {
      return { success: false, error: `Prompt is too long (max ${MAX_PROMPT_LENGTH} characters).` };
    }

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

    // Insert the operation row and reserve 1 token atomically BEFORE calling Gemini
    const begin = await ctx.runMutation(internal.aiOperations.beginOperation, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      editKey: args.editKey,
      operation: { type: "ai-generation", prompt: args.prompt, provider: "gemini" },
    });
    if (begin.status !== "ok") {
      return { success: false, error: beginErrorMessage(begin.status) };
    }
    const generationId = begin.operationId;

    const fail = async (error: string, outcome: "refund" | "billed") => {
      await ctx.runMutation(internal.aiOperations.failOperation, {
        operationType: "ai-generation",
        operationId: generationId,
        outcome,
        error,
      });
      const note = outcome === "billed" ? BILLED_FAILURE_NOTE : REFUNDED_FAILURE_NOTE;
      return { success: false as const, error: `${error} ${note}` };
    };

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

    // Mark the row in flight before the provider call: if this action dies
    // mid-request, a stale-operation sweep must treat it as possibly billed.
    // Explicit rejections below still refund (failOperation works from here).
    await ctx.runMutation(internal.aiOperations.markOperationProcessing, {
      operationType: "ai-generation",
      operationId: generationId,
    });

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Network failure before Gemini accepted the request: not billed.
      console.error('[GEMINI] Network error:', error);
      return await fail('Failed to reach the AI provider.', "refund");
    }

    if (!response.ok) {
      // Gemini rejected the request (4xx validation/quota, 5xx): not billed.
      const errorText = await response.text().catch(() => "");
      console.error('[GEMINI] API error:', response.status, errorText.slice(0, 500));
      return await fail('Failed to start AI generation.', "refund");
    }

    // Gemini answered 200: the call was billed from here on.
    try {
      let imageBase64: string | null = null;
      const json = await response.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        const inlineData = part?.inlineData || part?.inline_data;
        if (inlineData?.data) {
          imageBase64 = inlineData.data as string;
          break;
        }
      }

      if (!imageBase64) {
        console.error('[GEMINI] No image data in response');
        return await fail(
          'Gemini did not return an image (it may have replied with text only). Try rephrasing your prompt as an image edit.',
          "billed",
        );
      }

      // Convert base64 to Blob and store in Convex storage
      const binaryString = atob(imageBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const storageId: Id<"_storage"> = await ctx.storage.store(new Blob([bytes], { type: 'image/png' }));
      const storageUrl = await ctx.storage.getUrl(storageId);

      if (!storageUrl) {
        await ctx.storage.delete(storageId).catch(() => {});
        return await fail('Failed to store generated image.', "billed");
      }

      const completion = await ctx.runMutation(internal.aiOperations.completeOperation, {
        operationType: "ai-generation",
        operationId: generationId,
        resultImageUrl: storageUrl,
        guestKey: args.guestKey,
        editKey: args.editKey,
      });
      if (completion !== "completed") {
        await ctx.storage.delete(storageId).catch(() => {});
        return {
          success: false,
          error:
            completion === "access_lost"
              ? "You no longer have access to this painting, so the result was discarded."
              : "This generation was already finalized.",
        };
      }

      return { success: true, imageUrl: storageUrl };
    } catch (error) {
      console.error('[GEMINI] Generation error:', error);
      return await fail('An error occurred while processing the AI result.', "billed");
    }
  },
});
