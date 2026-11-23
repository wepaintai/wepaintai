import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertCanModifySession, canReadSession } from "./sessionAuth";

/*
 * Undo/redo model (linear history shared by everyone editing the session):
 *
 * - `strokeCounter` is monotonic: every stroke and every clear takes the next
 *   order slot, so a new stroke's order is above every existing order,
 *   including cleared and undone (soft-deleted) strokes.
 * - Live strokes are the `strokes` table. Applied clears are
 *   `session.clearHistory` (their strokes sit in `deletedStrokes` tagged with
 *   the clear's batch id).
 * - Undo reverts whichever history entry is newest: the top live stroke, or
 *   the latest applied clear (restoring its batch). The reverted entry is
 *   pushed onto `session.redoStack`.
 * - Redo pops `redoStack` and re-applies that entry (restore the stroke, or
 *   re-clear). Drawing a new stroke or clearing empties the redo stack.
 */

const MAX_REDO_ENTRIES = 100;
const MAX_UNDOABLE_CLEARS = 20;

type ClearEntry = { batchId: string; order: number };
type RedoEntry = { kind: "stroke" | "clear"; ref: string; order: number };

function getClearHistory(session: Doc<"paintingSessions">): ClearEntry[] {
  if (session.clearHistory) return session.clearHistory;
  // Legacy sessions recorded only the most recent clear. Order 0 means it is
  // undoable once no live strokes remain (the previous behavior).
  if (session.lastAction === "clear" && session.lastClearBatchId) {
    return [{ batchId: session.lastClearBatchId, order: 0 }];
  }
  return [];
}

function getRedoStack(session: Doc<"paintingSessions">): RedoEntry[] {
  return session.redoStack ?? [];
}

async function topLiveStroke(ctx: QueryCtx, sessionId: Id<"paintingSessions">) {
  return await ctx.db
    .query("strokes")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .first();
}

/** Next order slot: above the counter and every live or soft-deleted stroke. */
async function nextStrokeOrder(ctx: QueryCtx, session: Doc<"paintingSessions">) {
  const topLive = await topLiveStroke(ctx, session._id);
  const topDeleted = await ctx.db
    .query("deletedStrokes")
    .withIndex("by_session_stroke", (q) => q.eq("sessionId", session._id))
    .order("desc")
    .first();
  const clearMax = getClearHistory(session).reduce((max, c) => Math.max(max, c.order), 0);
  return (
    Math.max(
      session.strokeCounter,
      topLive?.strokeOrder ?? 0,
      topDeleted?.strokeOrder ?? 0,
      clearMax,
    ) + 1
  );
}

function strokeFields(s: Doc<"strokes"> | Doc<"deletedStrokes">) {
  return {
    sessionId: s.sessionId,
    layerId: s.layerId,
    userId: s.userId,
    userColor: s.userColor,
    points: s.points,
    brushColor: s.brushColor,
    brushSize: s.brushSize,
    opacity: s.opacity,
    strokeOrder: s.strokeOrder,
    isEraser: s.isEraser,
    colorMode: s.colorMode,
  };
}

/** Redo bookkeeping mirrored into the legacy fields older clients read. */
function redoFields(redoStack: RedoEntry[]) {
  return {
    redoStack,
    deletedStrokeCount: redoStack.length,
    lastDeletedStrokeOrder: redoStack.length > 0 ? redoStack[redoStack.length - 1].order : undefined,
  };
}

/** Delete the soft-deleted rows behind redo entries that can no longer be redone. */
async function scheduleDiscard(
  ctx: MutationCtx,
  sessionId: Id<"paintingSessions">,
  entries: RedoEntry[],
) {
  if (entries.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.strokes.discardHistoryEntries, {
    sessionId,
    entries,
  });
}

/** Move every live stroke into `deletedStrokes` under a clear batch id. */
async function moveLiveStrokesToBatch(
  ctx: MutationCtx,
  sessionId: Id<"paintingSessions">,
  batchId: string,
) {
  const strokes = await ctx.db
    .query("strokes")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  const deletedAt = Date.now();
  for (const s of strokes) {
    await ctx.db.insert("deletedStrokes", { ...strokeFields(s), deletedAt, clearBatchId: batchId });
    await ctx.db.delete(s._id);
  }
  return strokes.length;
}

/**
 * Add a new stroke to a painting session
 */
export const addStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))), // Layer to add stroke to (paint, uploaded image, or AI image)
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    isEraser: v.optional(v.boolean()),
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.id("strokes"),
  handler: async (ctx, args) => {
    // Get the session to increment stroke counter and enforce access
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Authorization: allow owner, guest owner, or valid editKey collaborator
    const { user } = await assertCanModifySession(ctx, session, args.guestKey, {
      editKey: args.editKey,
    });

    // Derive authenticated attribution strictly from ctx.auth
    if (args.userId && (!user || user._id !== args.userId)) {
      throw new Error("Unauthorized");
    }
    const effectiveUserId = user?._id;

    // Monotonic ordering: above every live, undone, or cleared stroke
    const strokeOrder = await nextStrokeOrder(ctx, session);

    // If layerId provided, verify it belongs to this session
    let layerId = args.layerId;
    if (layerId) {
      const targetLayer = await ctx.db.get(layerId);
      if (!targetLayer || targetLayer.sessionId !== args.sessionId) {
        throw new Error("Layer does not belong to this session");
      }
    } else {
      // Check for existing paint layers
      const defaultLayer = await ctx.db
        .query("paintLayers")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .first();
      
      if (defaultLayer) {
        layerId = defaultLayer._id;
      } else {
        // Create a default layer if none exists
        layerId = await ctx.db.insert("paintLayers", {
          sessionId: args.sessionId,
          name: "Layer 1",
          layerOrder: 0,
          visible: true,
          opacity: 1,
          createdBy: effectiveUserId,
          createdAt: Date.now(),
        });
      }
    }

    // Insert the stroke
    const strokeId = await ctx.db.insert("strokes", {
      sessionId: args.sessionId,
      layerId,
      userId: effectiveUserId,
      userColor: args.userColor,
      points: args.points,
      brushColor: args.brushColor,
      brushSize: args.brushSize,
      opacity: args.opacity,
      strokeOrder,
      isEraser: args.isEraser,
      colorMode: args.colorMode,
    });

    // A new stroke starts a new branch of history: the redo stack is gone.
    // Applied clears stay in clearHistory so they remain undoable.
    const discarded = getRedoStack(session);
    await ctx.db.patch(args.sessionId, {
      strokeCounter: strokeOrder,
      clearHistory: getClearHistory(session),
      ...redoFields([]),
      lastAction: undefined,
      lastClearBatchId: undefined,
      lastModified: Date.now(),
    });
    await scheduleDiscard(ctx, args.sessionId, discarded);

    return strokeId;
  },
});

/**
 * Get all strokes for a session
 */
export const getSessionStrokes = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(),
    isEraser: v.optional(v.boolean()),
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
  })),
  handler: async (ctx, args) => {
    // First, ensure session cache is populated for fast undo/redo
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
    }
    
    // Use the index with order to get strokes already sorted
    const strokes = await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc") // Get strokes in strokeOrder
      .collect();
    
    // Check if session needs cache population
    if (strokes.length > 0 && session) {
      const needsCacheUpdate = !session.recentStrokeIds || session.recentStrokeIds.length === 0;
      
      if (needsCacheUpdate) {
        // Cache warming removed from query to avoid writes in query context
        // const lastStrokes = strokes.slice(-10);
        // (No-op)
      }
    }
    
    return strokes;
  },
});

/**
 * Get strokes for a specific layer
 */
export const getLayerStrokes = query({
  args: {
    sessionId: v.id("paintingSessions"),
    layerId: v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages")),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(),
    isEraser: v.optional(v.boolean()),
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
  })),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
    }
    return await ctx.db
      .query("strokes")
      .withIndex("by_layer", (q) => 
        q.eq("sessionId", args.sessionId).eq("layerId", args.layerId)
      )
      .collect();
  },
});

/**
 * Get strokes after a certain order number (for incremental updates)
 */
export const getStrokesAfter = query({
  args: {
    sessionId: v.id("paintingSessions"),
    afterStrokeOrder: v.number(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("strokes"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.union(v.id("paintLayers"), v.id("uploadedImages"), v.id("aiGeneratedImages"))),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(),
    isEraser: v.optional(v.boolean()),
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))),
  })),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
    }
    return await ctx.db
      .query("strokes")
      .withIndex("by_session", (q) => 
        q.eq("sessionId", args.sessionId)
         .gt("strokeOrder", args.afterStrokeOrder)
      )
      .collect();
  },
});

/**
 * Undo the newest history entry: the top live stroke, or the latest applied
 * clear (restoring its strokes).
 */
export const removeLastStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });

    const top = await topLiveStroke(ctx, args.sessionId);
    const clears = getClearHistory(session);
    const lastClear = clears.length > 0 ? clears[clears.length - 1] : undefined;
    let redoStack = getRedoStack(session);

    let entry: RedoEntry;
    let remainingClears = clears;
    if (lastClear && (!top || lastClear.order > top.strokeOrder)) {
      // Undo the clear: restore its batch with the original orders
      const batch = await ctx.db
        .query("deletedStrokes")
        .withIndex("by_session_clear_batch", (q) =>
          q.eq("sessionId", args.sessionId).eq("clearBatchId", lastClear.batchId)
        )
        .collect();
      for (const s of batch) {
        await ctx.db.insert("strokes", strokeFields(s));
        await ctx.db.delete(s._id);
      }
      entry = { kind: "clear", ref: lastClear.batchId, order: lastClear.order };
      remainingClears = clears.slice(0, -1);
    } else if (top) {
      const deletedId = await ctx.db.insert("deletedStrokes", {
        ...strokeFields(top),
        deletedAt: Date.now(),
      });
      await ctx.db.delete(top._id);
      entry = { kind: "stroke", ref: deletedId, order: top.strokeOrder };
    } else {
      return false;
    }

    redoStack = [...redoStack, entry];
    const overflow = redoStack.length > MAX_REDO_ENTRIES
      ? redoStack.slice(0, redoStack.length - MAX_REDO_ENTRIES)
      : [];
    redoStack = redoStack.slice(-MAX_REDO_ENTRIES);

    await ctx.db.patch(args.sessionId, {
      clearHistory: remainingClears,
      ...redoFields(redoStack),
      recentStrokeOrders: undefined,
      recentStrokeIds: undefined,
      lastAction: undefined,
      lastClearBatchId: undefined,
      lastModified: Date.now(),
    });
    await scheduleDiscard(ctx, args.sessionId, overflow);

    return true;
  },
});

/**
 * Redo: re-apply the most recently undone history entry.
 */
export const restoreLastDeletedStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });

    const redoStack = getRedoStack(session);
    if (redoStack.length === 0) {
      return false;
    }
    const entry = redoStack[redoStack.length - 1];
    const remaining = redoStack.slice(0, -1);

    if (entry.kind === "stroke") {
      const deletedId = ctx.db.normalizeId("deletedStrokes", entry.ref);
      const row = deletedId ? await ctx.db.get(deletedId) : null;
      if (!row || row.sessionId !== args.sessionId) {
        // The undone stroke is gone; drop the stale entry.
        await ctx.db.patch(args.sessionId, redoFields(remaining));
        return false;
      }
      await ctx.db.insert("strokes", strokeFields(row));
      await ctx.db.delete(row._id);
      await ctx.db.patch(args.sessionId, {
        ...redoFields(remaining),
        strokeCounter: Math.max(session.strokeCounter, row.strokeOrder),
        lastModified: Date.now(),
      });
      return true;
    }

    // Re-apply the clear with its original batch id and order slot
    await moveLiveStrokesToBatch(ctx, args.sessionId, entry.ref);
    const clears = [...getClearHistory(session), { batchId: entry.ref, order: entry.order }];
    const droppedClears = clears.slice(0, Math.max(0, clears.length - MAX_UNDOABLE_CLEARS));
    await ctx.db.patch(args.sessionId, {
      ...redoFields(remaining),
      clearHistory: clears.slice(-MAX_UNDOABLE_CLEARS),
      strokeCounter: Math.max(session.strokeCounter, entry.order),
      lastAction: "clear",
      lastClearBatchId: entry.ref,
      lastModified: Date.now(),
    });
    await scheduleDiscard(
      ctx,
      args.sessionId,
      droppedClears.map((c) => ({ kind: "clear" as const, ref: c.batchId, order: c.order })),
    );
    return true;
  },
});

/**
 * Permanently delete the soft-deleted rows behind history entries that can no
 * longer be undone or redone (discarded redo branch, clears that fell off the
 * undo window). Skips anything that is reachable again.
 */
export const discardHistoryEntries = internalMutation({
  args: {
    sessionId: v.id("paintingSessions"),
    entries: v.array(v.object({
      kind: v.union(v.literal("stroke"), v.literal("clear")),
      ref: v.string(),
      order: v.number(),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const reachable = new Set([
      ...getRedoStack(session).map((e) => `${e.kind}:${e.ref}`),
      ...getClearHistory(session).map((c) => `clear:${c.batchId}`),
    ]);
    for (const entry of args.entries) {
      if (reachable.has(`${entry.kind}:${entry.ref}`)) continue;
      if (entry.kind === "stroke") {
        const id = ctx.db.normalizeId("deletedStrokes", entry.ref);
        const row = id ? await ctx.db.get(id) : null;
        if (row && row.sessionId === args.sessionId) await ctx.db.delete(row._id);
      } else {
        const rows = await ctx.db
          .query("deletedStrokes")
          .withIndex("by_session_clear_batch", (q) =>
            q.eq("sessionId", args.sessionId).eq("clearBatchId", entry.ref)
          )
          .collect();
        for (const row of rows) await ctx.db.delete(row._id);
      }
    }
    return null;
  },
});

/**
 * Delete a specific stroke
 */
export const deleteStroke = mutation({
  args: {
    strokeId: v.id("strokes"),
    guestKey: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Get the stroke to verify it exists
    const stroke = await ctx.db.get(args.strokeId);
    if (!stroke) {
      return false; // Stroke not found
    }

    const session = await ctx.db.get(stroke.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    // Deleting arbitrary strokes is owner-only, even on public sessions
    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

    // Save the stroke to deletedStrokes before deleting
    await ctx.db.insert("deletedStrokes", {
      sessionId: stroke.sessionId,
      layerId: stroke.layerId,
      userId: stroke.userId,
      userColor: stroke.userColor,
      points: stroke.points,
      brushColor: stroke.brushColor,
      brushSize: stroke.brushSize,
      opacity: stroke.opacity,
      strokeOrder: stroke.strokeOrder,
      isEraser: stroke.isEraser,
      colorMode: stroke.colorMode,
      deletedAt: Date.now(),
    });

    // Delete the stroke
    await ctx.db.delete(stroke._id);

    return true;
  },
});

/**
 * Clear all strokes from a painting session (undoable)
 */
export const clearSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get the session to verify it exists
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Clearing the whole canvas is owner-only, even on public sessions
    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

    const anyStroke = await topLiveStroke(ctx, args.sessionId);
    if (!anyStroke) {
      // Nothing to clear: not a history entry
      return null;
    }

    // The clear occupies its own order slot so later strokes sort above it
    const order = await nextStrokeOrder(ctx, session);
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await moveLiveStrokesToBatch(ctx, args.sessionId, batchId);

    const clears = [...getClearHistory(session), { batchId, order }];
    const droppedClears = clears.slice(0, Math.max(0, clears.length - MAX_UNDOABLE_CLEARS));
    const discarded: RedoEntry[] = [
      ...getRedoStack(session),
      ...droppedClears.map((c) => ({ kind: "clear" as const, ref: c.batchId, order: c.order })),
    ];
    await ctx.db.patch(args.sessionId, {
      strokeCounter: order,
      clearHistory: clears.slice(-MAX_UNDOABLE_CLEARS),
      ...redoFields([]),
      recentStrokeOrders: undefined,
      recentStrokeIds: undefined,
      lastAction: 'clear',
      lastClearBatchId: batchId,
      lastModified: Date.now(),
    });
    await scheduleDiscard(ctx, args.sessionId, discarded);

    return null;
  },
});

/**
 * Get undo/redo availability for a session. Derived from the same state the
 * undo/redo mutations act on, so the buttons never promise a no-op.
 */
export const getUndoRedoAvailability = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.object({
    canUndo: v.boolean(),
    canRedo: v.boolean(),
    strokeCount: v.number(),
    deletedCount: v.number(),
    lastStrokeId: v.optional(v.id("strokes")),
    cacheWarmed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return {
        canUndo: false,
        canRedo: false,
        strokeCount: 0,
        deletedCount: 0,
        cacheWarmed: false,
      };
    }

    const top = await topLiveStroke(ctx, args.sessionId);
    const redoStack = getRedoStack(session);
    return {
      canUndo: top !== null || getClearHistory(session).length > 0,
      canRedo: redoStack.length > 0,
      strokeCount: session.strokeCounter,
      deletedCount: redoStack.length,
      lastStrokeId: top?._id,
      cacheWarmed: true,
    };
  },
});
