import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  BILLED_FAILURE_NOTE,
  REFUNDED_FAILURE_NOTE,
  cancelPrediction,
  createPrediction,
  extractOutputUrl,
  isModerationError,
  pollPrediction,
} from "./replicate";

// User-facing failures are thrown as ConvexError so their message reaches the
// client even where plain server errors are redacted to "Server Error".
export const removeBackground = action({
  args: {
    sessionId: v.id("paintingSessions"),
    imageData: v.string(),
    targetLayerId: v.optional(v.string()),
    guestKey: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: true; imageUrl: string; storageId: Id<"_storage"> }> => {
    console.log("[BG-REMOVAL] Starting background removal process");

    const access = await ctx.runQuery(internal.sessionAuth.verifySessionAccess, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      requireAuth: true,
    });

    if (access.status === "not_found") {
      throw new ConvexError("Session not found");
    }
    if (access.status === "unauthenticated") {
      throw new ConvexError("Authentication required for background removal");
    }
    if (access.status !== "ok") {
      throw new ConvexError("You don't have permission to edit this painting");
    }

    // Get Replicate API token from environment before reserving tokens
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) {
      throw new ConvexError("Replicate API token not configured");
    }

    // Insert the operation row and reserve 1 token atomically BEFORE any
    // provider spending. Users without tokens never get a row.
    const begin = await ctx.runMutation(internal.aiOperations.beginOperation, {
      sessionId: args.sessionId,
      guestKey: args.guestKey,
      operation: { type: "background-removal", targetLayerId: args.targetLayerId },
    });
    if (begin.status === "insufficient_tokens") {
      throw new ConvexError("Insufficient tokens. Background removal costs 1 token.");
    }
    if (begin.status === "unauthenticated") {
      throw new ConvexError("Authentication required for background removal");
    }
    if (begin.status !== "ok") {
      throw new ConvexError("You don't have permission to edit this painting");
    }
    const operationId = begin.operationId;

    const fail = async (error: string, outcome: "refund" | "billed"): Promise<never> => {
      await ctx.runMutation(internal.aiOperations.failOperation, {
        operationType: "background-removal",
        operationId,
        outcome,
        error,
      });
      const note = outcome === "billed" ? BILLED_FAILURE_NOTE : REFUNDED_FAILURE_NOTE;
      throw new ConvexError(`${error} ${note}`);
    };

    console.log("[BG-REMOVAL] Running Replicate model...");
    const created = await createPrediction(replicateToken, {
      version: "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
      input: {
        image: args.imageData,
      },
    });
    if (created.kind === "rejected") {
      console.error("[BG-REMOVAL] Replicate rejected the request:", created.httpStatus, created.message);
      return await fail("Failed to start background removal.", "refund");
    }
    const predictionId = created.id;

    let storedId: Id<"_storage"> | null = null;
    try {
      // From here on the provider has accepted (and bills) the request.
      await ctx.runMutation(internal.aiOperations.markOperationProcessing, {
        operationType: "background-removal",
        operationId,
        replicateId: predictionId,
      });

      const result = await pollPrediction(replicateToken, predictionId);
      if (result.kind === "timeout" || result.kind === "poll_error") {
        if (result.kind === "poll_error") console.error("[BG-REMOVAL] Status polling failed:", result.message);
        await cancelPrediction(replicateToken, predictionId);
        return await fail("Background removal timed out and was canceled.", "billed");
      }
      if (result.kind === "failed") {
        const message = isModerationError(result.error)
          ? "Content moderation flagged this image. Please try a different image."
          : `Background removal failed: ${result.error}.`;
        return await fail(message, "billed");
      }

      const outputUrl = extractOutputUrl(result.output);
      if (!outputUrl) {
        return await fail("Unexpected output format from Replicate.", "billed");
      }

      // The provider succeeded; failing to fetch/store its output is billed.
      let storageUrl: string | null = null;
      try {
        const imageResponse = await fetch(outputUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch generated image: ${imageResponse.statusText}`);
        }
        storedId = await ctx.storage.store(await imageResponse.blob());
        storageUrl = await ctx.storage.getUrl(storedId);
      } catch (error) {
        console.error("[BG-REMOVAL] Failed to store result:", error);
      }
      if (!storedId || !storageUrl) {
        if (storedId) await ctx.storage.delete(storedId).catch(() => {});
        return await fail("Failed to save the background-removed image.", "billed");
      }

      const completion = await ctx.runMutation(internal.aiOperations.completeOperation, {
        operationType: "background-removal",
        operationId,
        resultImageUrl: storageUrl,
        guestKey: args.guestKey,
      });
      if (completion !== "completed") {
        await ctx.storage.delete(storedId).catch(() => {});
        throw new ConvexError(
          completion === "access_lost"
            ? "You no longer have access to this painting, so the result was discarded."
            : "This background removal was already finalized.",
        );
      }

      console.log("[BG-REMOVAL] Background removal successful");
      return {
        success: true as const,
        imageUrl: storageUrl,
        storageId: storedId,
      };
    } catch (error) {
      // fail() and the completion branch throw user-facing errors after
      // settling the row; anything else is unexpected and post-acceptance.
      const settled = await ctx.runMutation(internal.aiOperations.failOperation, {
        operationType: "background-removal",
        operationId,
        outcome: "billed",
        error: error instanceof Error ? error.message : "Background removal failed",
      });
      if (settled.status === "failed_billed") {
        await cancelPrediction(replicateToken, predictionId);
        console.error("[BG-REMOVAL] Error:", error);
        throw new ConvexError(`Failed to remove background. ${BILLED_FAILURE_NOTE}`);
      }
      throw error;
    }
  },
});
