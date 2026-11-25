import { v } from "convex/values";
import { action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { canReadSession } from "./sessionAuth";
import { isPromptTooLong, MAX_PROMPT_LENGTH } from "./tokenPolicy";
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

// Verbose logging of prompts and image-data samples is a privacy concern in
// shared logs; opt in with AI_GEN_DEBUG=true on the deployment.
const AI_GEN_DEBUG = process.env.AI_GEN_DEBUG === "true";
function debugLog(...args: unknown[]) {
  if (AI_GEN_DEBUG) console.log(...args);
}

// Main action to generate image using Replicate
export const generateImage = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    imageData: v.string(), // base64 encoded image
    weight: v.optional(v.number()), // Optional weight parameter (0-1)
    canvasWidth: v.optional(v.number()),
    canvasHeight: v.optional(v.number()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; imageUrl?: string; storageId?: Id<"_storage">; error?: string }> => {
    debugLog('[AI-GEN] generateImage action called with prompt:', args.prompt);
    debugLog('[AI-GEN] Weight parameter (UI):', args.weight ?? 0.85);
    debugLog('[AI-GEN] Image data length:', args.imageData.length);

    // Check if imageData is empty or too small
    if (!args.imageData || args.imageData.length < 100) {
      console.error('[AI-GEN] ERROR: Image data is empty or too small!');
      return { success: false, error: "Canvas data is empty" };
    }
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
      console.error('[AI-GEN] User not authenticated');
      return { success: false, error: "Please sign in to use AI generation." };
    }
    if (access.status !== "ok") {
      return { success: false, error: "Unauthorized" };
    }

    // Get Replicate API token from environment before reserving tokens
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) {
      console.error("REPLICATE_API_TOKEN not configured");
      return { success: false, error: "AI generation not configured" };
    }

    // Insert the operation row and reserve 1 token atomically BEFORE any
    // provider spending. Users without tokens never get a row.
    const begin = await ctx.runMutation(internal.aiOperations.beginOperation, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      editKey: args.editKey,
      operation: { type: "ai-generation", prompt: args.prompt, provider: "replicate" },
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

    let predictionId: string | null = null;
    try {
      // Convert base64 to data URL if needed
      const imageDataUrl = args.imageData.startsWith('data:')
        ? args.imageData
        : `data:image/png;base64,${args.imageData}`;

      // Store the canvas so Replicate can fetch it by URL
      let imageUrl: string;
      try {
        const base64Data = imageDataUrl.split(',')[1] || args.imageData;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const snapshotId = await ctx.storage.store(new Blob([bytes], { type: 'image/png' }));
        // Track the snapshot on the row before anything else can fail: the
        // row's terminal transition (or the stale sweep) deletes it.
        const recorded = await ctx.runMutation(internal.aiOperations.recordCanvasSnapshot, {
          operationId: generationId,
          storageId: snapshotId,
        });
        if (!recorded) throw new Error('Operation is no longer pending');
        const url = await ctx.storage.getUrl(snapshotId);
        if (!url) throw new Error('Failed to get storage URL');
        imageUrl = url;
        debugLog('[AI-GEN] Canvas image stored, URL:', imageUrl);
      } catch (error) {
        console.error('[AI-GEN] Failed to store canvas image:', error);
        return await fail('Failed to store canvas image.', "refund");
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
      }

      // Get model version from environment or use default
      const modelVersion = process.env.REPLICATE_MODEL_VERSION || "15589a1a9e6b240d246752fc688267b847db4858910cc390794703384b6a5443";

      const created = await createPrediction(replicateToken, {
        version: modelVersion, // Flux Kontext Pro version
        input: {
          prompt: args.prompt,
          input_image: imageUrl, // Use input_image as per Replicate API
          aspect_ratio: aspectRatio,
          output_format: "png",
          safety_tolerance: 2, // Limited to 2 when using input images
          weight: (args.weight ?? 0.85) * 2, // Map 0-1 range to 0-2 for Replicate
        },
      });
      if (created.kind === "rejected") {
        console.error("[AI-GEN] Replicate rejected the request:", created.httpStatus, created.message);
        return await fail("Failed to start AI generation.", "refund");
      }
      predictionId = created.id;
      debugLog('[AI-GEN] Created prediction:', predictionId);

      // From here on the provider has accepted (and bills) the request.
      await ctx.runMutation(internal.aiOperations.markOperationProcessing, {
        operationType: "ai-generation",
        operationId: generationId,
        replicateId: predictionId,
      });

      const result = await pollPrediction(replicateToken, predictionId);
      if (result.kind === "timeout" || result.kind === "poll_error") {
        if (result.kind === "poll_error") console.error('[AI-GEN] Status polling failed:', result.message);
        await cancelPrediction(replicateToken, predictionId);
        return await fail("Generation timed out and was canceled.", "billed");
      }
      if (result.kind === "failed") {
        const message = isModerationError(result.error)
          ? "Content moderation flagged this request. Please try a different prompt."
          : `Generation failed: ${result.error}.`;
        return await fail(message, "billed");
      }

      const outputImageUrl = extractOutputUrl(result.output);
      if (!outputImageUrl) {
        console.error('[AI-GEN] Unexpected output format:', JSON.stringify(result.output)?.substring(0, 200));
        return await fail("Replicate returned an invalid result.", "billed");
      }

      // Download into Convex storage so the result URL doesn't expire (the
      // provider URL is short-lived). The provider already billed this
      // request, so a storage failure is failed_billed rather than refunded.
      let finalUrl: string | null = null;
      let storedId: Id<"_storage"> | null = null;
      try {
        const imageResponse = await fetch(outputImageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to download image: ${imageResponse.statusText}`);
        }
        storedId = await ctx.storage.store(await imageResponse.blob());
        finalUrl = await ctx.storage.getUrl(storedId);
      } catch (error) {
        console.error("Error storing image:", error);
      }
      if (!storedId || !finalUrl) {
        if (storedId) await ctx.storage.delete(storedId).catch(() => {});
        return await fail("Failed to save the generated image.", "billed");
      }

      // Records the output blob and releases the canvas snapshot in one
      // transaction; deletes the output itself if the result isn't written.
      const completion = await ctx.runMutation(internal.aiOperations.completeOperation, {
        operationType: "ai-generation",
        operationId: generationId,
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
              : "This generation was already finalized.",
        };
      }

      return { success: true, imageUrl: finalUrl, storageId: storedId };
    } catch (error) {
      console.error("AI generation error:", error instanceof Error ? error.message : String(error));
      if (predictionId) await cancelPrediction(replicateToken, predictionId);
      return await fail(
        "An error occurred during generation.",
        predictionId ? "billed" : "refund",
      );
    }
  },
});

// Query to get recent completed AI generations for a session (newest first)
export const getSessionGenerations = query({
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
    // Take a larger window then filter, so a run of failed/moderated rows
    // doesn't shrink the strip; then keep the 10 most recent usable results.
    // A result is usable while its blob lives: the unplaced output itself, or
    // (once placed) the blob of the layer it became. Outputs whose layer was
    // deleted, or that expired unplaced, were freed and drop out. The URL is
    // always derived from the blob (this also covers legacy rows that have
    // generatedImageId but no resultImageUrl).
    const generations = await ctx.db
      .query("aiGenerations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(50);
    const results = [];
    for (const g of generations) {
      if (results.length >= 10) break;
      if (g.status !== "completed") continue;
      let storageId = g.generatedImageId;
      if (!storageId && g.placedImageId) {
        const layer = await ctx.db.get(g.placedImageId);
        if (layer && layer.sessionId === args.sessionId) storageId = layer.storageId;
      }
      if (!storageId) continue;
      const url = await ctx.storage.getUrl(storageId);
      if (!url) continue;
      results.push({
        _id: g._id,
        prompt: g.prompt,
        resultImageUrl: url,
        // The blob to hand to addAIGeneratedImage when re-placing this result
        generatedImageId: storageId,
        provider: g.provider,
        createdAt: g.createdAt,
      });
    }
    return results;
  },
});
