import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// Pending/processing AI operations older than this are settled by the
// stale-operation sweep (the action that owned them has died).
export const STALE_OPERATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const STALE_OPERATIONS_BATCH_SIZE = 100;

interface StorageDeleter {
  storage: {
    delete: (storageId: Id<"_storage">) => Promise<void>;
  };
}

/**
 * Idempotently delete a Convex storage blob, ignoring already-deleted errors.
 */
export async function safeDeleteStorage(
  ctx: StorageDeleter,
  storageId: Id<"_storage"> | undefined | null,
): Promise<boolean> {
  if (!storageId) return false;
  try {
    await ctx.storage.delete(storageId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if any live asset or operation document still references
 * `storageId`:
 * - uploaded image layers and AI image layers;
 * - upload intents that were uploaded to but not yet committed (a consumed
 *   intent's blob belongs to its uploadedImages row);
 * - AI operation outputs and temporary canvas snapshots.
 */
export async function isStorageReferenced(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
): Promise<boolean> {
  const uploaded = await ctx.db
    .query("uploadedImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (uploaded) return true;

  const intent = await ctx.db
    .query("imageUploadIntents")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (intent && intent.consumedAt === undefined) return true;

  const aiImage = await ctx.db
    .query("aiGeneratedImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (aiImage) return true;

  const generatedOutput = await ctx.db
    .query("aiGenerations")
    .withIndex("by_generated_image", (q) => q.eq("generatedImageId", storageId))
    .first();
  if (generatedOutput) return true;

  const canvasSnapshot = await ctx.db
    .query("aiGenerations")
    .withIndex("by_canvas_snapshot", (q) => q.eq("canvasSnapshotId", storageId))
    .first();
  if (canvasSnapshot) return true;

  const mergeOutput = await ctx.db
    .query("imageMerges")
    .withIndex("by_merged_storage", (q) => q.eq("mergedImageStorageId", storageId))
    .first();
  if (mergeOutput) return true;

  const removalOutput = await ctx.db
    .query("backgroundRemovals")
    .withIndex("by_result_storage", (q) => q.eq("resultStorageId", storageId))
    .first();
  if (removalOutput) return true;

  return false;
}

/**
 * Delete a storage blob only when no live database document references it.
 * Callers must delete or clear the referencing document first (in the same
 * mutation) so reference counting excludes the row being removed.
 */
export async function deleteStorageIfUnreferenced(
  ctx: MutationCtx,
  storageId: Id<"_storage"> | undefined | null,
): Promise<boolean> {
  if (!storageId) return false;
  if (await isStorageReferenced(ctx, storageId)) {
    return false;
  }
  return await safeDeleteStorage(ctx, storageId);
}

/**
 * Verify that `storageId` exists in Convex storage and was legitimately
 * produced by an AI generation, background removal, or image merge belonging
 * to `sessionId` (never another session, an arbitrary unattached blob, an
 * upload intent, a user-uploaded image, or a temporary canvas snapshot).
 */
export async function assertStorageAuthorizedForSessionAIImage(
  ctx: QueryCtx,
  sessionId: Id<"paintingSessions">,
  storageId: Id<"_storage">,
): Promise<void> {
  const denied = () => new Error("Storage object does not belong to this session");

  const storageMetadata = await ctx.db.system.get("_storage", storageId);
  if (!storageMetadata) {
    throw new Error("Storage object not found");
  }

  // Never allow attaching raw uploads, upload intents, or temporary snapshots
  const uploaded = await ctx.db
    .query("uploadedImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (uploaded) throw denied();

  const intent = await ctx.db
    .query("imageUploadIntents")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (intent) throw denied();

  const snapshot = await ctx.db
    .query("aiGenerations")
    .withIndex("by_canvas_snapshot", (q) => q.eq("canvasSnapshotId", storageId))
    .first();
  if (snapshot) throw denied();

  const generations = await ctx.db
    .query("aiGenerations")
    .withIndex("by_generated_image", (q) => q.eq("generatedImageId", storageId))
    .collect();
  const merges = await ctx.db
    .query("imageMerges")
    .withIndex("by_merged_storage", (q) => q.eq("mergedImageStorageId", storageId))
    .collect();
  const removals = await ctx.db
    .query("backgroundRemovals")
    .withIndex("by_result_storage", (q) => q.eq("resultStorageId", storageId))
    .collect();
  const existingAIImages = await ctx.db
    .query("aiGeneratedImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .collect();

  const owners = [...generations, ...merges, ...removals, ...existingAIImages];
  if (owners.some((owner) => owner.sessionId !== sessionId)) throw denied();

  const ownedBySession =
    generations.some((g) => g.status === "completed") ||
    merges.some((m) => m.status === "completed") ||
    removals.some((r) => r.status === "completed") ||
    existingAIImages.length > 0;
  if (!ownedBySession) throw denied();
}
