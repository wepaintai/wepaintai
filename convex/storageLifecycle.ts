import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";

// Pending/processing AI operations older than this are settled by the
// stale-operation sweep (the action that owned them has died).
export const STALE_OPERATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const STALE_OPERATIONS_BATCH_SIZE = 100;

// AI outputs that are not placed on the canvas within this window are deleted.
export const UNPLACED_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const OUTPUT_SWEEP_BATCH_SIZE = 100;

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

type AIOutputOwner =
  | { kind: "generation"; row: Doc<"aiGenerations"> }
  | { kind: "merge"; row: Doc<"imageMerges"> }
  | { kind: "removal"; row: Doc<"backgroundRemovals"> }
  // Already placed in this session: a further layer may share the blob (e.g.
  // re-placing a result from the history strip); reference counting frees it
  // when the last layer goes.
  | { kind: "layer" };

/**
 * Resolve who may hand `storageId` to a new AI layer of `sessionId`:
 * - the unplaced output of a completed generation, merge or background
 *   removal of this session (ownership then moves to the new layer); or
 * - a blob already owned by an AI layer of this session.
 * Anything else is rejected: other sessions' outputs, uploads, upload
 * intents, canvas snapshots, unattached blobs, and outputs whose layer was
 * deleted (the blob was freed with it).
 */
export async function resolveAIOutputOwner(
  ctx: QueryCtx,
  sessionId: Id<"paintingSessions">,
  storageId: Id<"_storage">,
): Promise<AIOutputOwner> {
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
  const layers = await ctx.db
    .query("aiGeneratedImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .collect();

  const all = [...generations, ...merges, ...removals, ...layers];
  if (all.length === 0 || all.some((owner) => owner.sessionId !== sessionId)) throw denied();

  const generation = generations.find((g) => g.status === "completed");
  if (generation) return { kind: "generation", row: generation };
  const merge = merges.find((m) => m.status === "completed");
  if (merge) return { kind: "merge", row: merge };
  const removal = removals.find((r) => r.status === "completed");
  if (removal) return { kind: "removal", row: removal };
  if (layers.length > 0) return { kind: "layer" };
  throw denied();
}

/**
 * Move ownership of a placed output from its operation row to the new layer:
 * clear the row's output reference (and expiry) and keep only a placement
 * marker, so the history row no longer pins the blob.
 */
export async function transferAIOutputToLayer(
  ctx: MutationCtx,
  owner: AIOutputOwner,
  imageId: Id<"aiGeneratedImages">,
): Promise<void> {
  const placed = { placedImageId: imageId, placedAt: Date.now(), outputExpiresAt: undefined };
  if (owner.kind === "generation") {
    await ctx.db.patch(owner.row._id, { ...placed, generatedImageId: undefined });
  } else if (owner.kind === "merge") {
    await ctx.db.patch(owner.row._id, { ...placed, mergedImageStorageId: undefined });
  } else if (owner.kind === "removal") {
    await ctx.db.patch(owner.row._id, { ...placed, resultStorageId: undefined });
  }
}

/**
 * Cron: delete AI outputs that were never placed on the canvas (the client
 * discarded them, failed to place them, or went away) once their TTL passed.
 * Clears the output reference and deletes the blob in one transaction.
 * Bounded per run; reschedules itself while a batch comes back full.
 */
export const expireUnplacedOutputs = internalMutation({
  args: {},
  returns: v.object({ expired: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let expired = 0;
    let more = false;
    const generations = await ctx.db
      .query("aiGenerations")
      .withIndex("by_output_expires", (q) => q.gt("outputExpiresAt", 0).lt("outputExpiresAt", now))
      .take(OUTPUT_SWEEP_BATCH_SIZE);
    for (const row of generations) {
      await ctx.db.patch(row._id, { generatedImageId: undefined, outputExpiresAt: undefined });
      await deleteStorageIfUnreferenced(ctx, row.generatedImageId);
    }
    const merges = await ctx.db
      .query("imageMerges")
      .withIndex("by_output_expires", (q) => q.gt("outputExpiresAt", 0).lt("outputExpiresAt", now))
      .take(OUTPUT_SWEEP_BATCH_SIZE);
    for (const row of merges) {
      await ctx.db.patch(row._id, { mergedImageStorageId: undefined, outputExpiresAt: undefined });
      await deleteStorageIfUnreferenced(ctx, row.mergedImageStorageId);
    }
    const removals = await ctx.db
      .query("backgroundRemovals")
      .withIndex("by_output_expires", (q) => q.gt("outputExpiresAt", 0).lt("outputExpiresAt", now))
      .take(OUTPUT_SWEEP_BATCH_SIZE);
    for (const row of removals) {
      await ctx.db.patch(row._id, { resultStorageId: undefined, outputExpiresAt: undefined });
      await deleteStorageIfUnreferenced(ctx, row.resultStorageId);
    }
    for (const batch of [generations, merges, removals]) {
      expired += batch.length;
      if (batch.length === OUTPUT_SWEEP_BATCH_SIZE) more = true;
    }
    if (more) {
      await ctx.scheduler.runAfter(0, internal.storageLifecycle.expireUnplacedOutputs, {});
    }
    return { expired };
  },
});
