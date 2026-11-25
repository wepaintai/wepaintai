import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Doc, Id, type TableNames } from "./_generated/dataModel";
import { createUserWithWelcomeTokens } from "./users";
import {
  assertCanModifySession,
  canReadSession,
  getSessionAccess,
  isSessionOwner,
  keysMatch,
} from "./sessionAuth";
import { deleteStorageIfUnreferenced } from "./storageLifecycle";
import { isPromptTooLong, MAX_PROMPT_LENGTH } from "./tokenPolicy";

function generateEditKey(excludeKeys: Array<string | undefined> = []): string {
  const excluded = excludeKeys.filter((k): k is string => Boolean(k));
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const candidate = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!excluded.some((k) => keysMatch(k, candidate))) {
      return candidate;
    }
  }
  throw new Error("Failed to generate unique edit key");
}

const EVICT_BATCH = 500;

/**
 * Rotating or revoking the edit link invalidates every collaborator at once.
 * Drop their presence rows, live strokes and pending WebRTC signals so the
 * editor set other clients derive from presence (used to ignore P2P packets
 * from peers who are no longer editors) updates immediately instead of after
 * the presence staleness window. The signed-in owner's own rows are kept; a
 * guest owner's row is recreated by its next presence heartbeat. Revoked
 * clients can't write new rows: presence and live strokes require edit access.
 */
async function evictCollaborators(ctx: MutationCtx, session: Doc<"paintingSessions">) {
  const isOwnerRow = (row: { userId?: Id<"users"> }) =>
    session.createdBy !== undefined && row.userId === session.createdBy;
  const presence = await ctx.db
    .query("userPresence")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .take(EVICT_BATCH);
  for (const row of presence) {
    if (!isOwnerRow(row)) await ctx.db.delete(row._id);
  }
  const live = await ctx.db
    .query("liveStrokes")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .take(EVICT_BATCH);
  for (const row of live) {
    if (!isOwnerRow(row)) await ctx.db.delete(row._id);
  }
  const signals = await ctx.db
    .query("webrtcSignals")
    .withIndex("by_session_to", (q) => q.eq("sessionId", session._id))
    .take(EVICT_BATCH);
  for (const row of signals) {
    await ctx.db.delete(row._id);
  }
}

/**
 * Create a new painting session
 */
export const createSession = mutation({
  args: {
    name: v.optional(v.string()),
    canvasWidth: v.number(),
    canvasHeight: v.number(),
    isPublic: v.optional(v.boolean()),
    guestKey: v.optional(v.string()),
  },
  returns: v.id("paintingSessions"),
  handler: async (ctx, args) => {
    let userId: Id<"users"> | undefined = undefined;
    
    try {
      // Get the authenticated user ID if available
      const identity = await ctx.auth.getUserIdentity();
      console.log("[createSession] Identity:", identity ? { subject: identity.subject, email: identity.email } : null);
      
      if (identity) {
        // Find the user by their Better Auth ID
        const user = await ctx.db
          .query("users")
          .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
          .first();

        console.log("[createSession] Found user:", user ? { _id: user._id, email: user.email } : null);

        if (user) {
          userId = user._id;
        } else {
          // Fallback: the signup trigger normally creates the user row
          console.log("[createSession] Creating new user for:", identity.email);
          userId = await createUserWithWelcomeTokens(ctx, {
            authId: identity.subject,
            email: identity.email,
            name: identity.name || identity.givenName,
          });
          console.log("[createSession] Created user with ID:", userId);
        }
      } else {
        console.log("[createSession] No identity found - creating guest session");
      }
    } catch (error) {
      // Log error but continue - allow guest users to create sessions
      console.error("[createSession] Error getting/creating user:", error);
    }
    
    const sessionId = await ctx.db.insert("paintingSessions", {
      name: args.name,
      createdBy: userId,
      // Private by default; guests use guestOwnerKey to access
      isPublic: args.isPublic ?? false,
      guestOwnerKey: userId ? undefined : args.guestKey,
      canvasWidth: args.canvasWidth,
      canvasHeight: args.canvasHeight,
      strokeCounter: 0,
      paintLayerOrder: 0, // Initialize paint layer at the bottom
      paintLayerVisible: true, // Paint layer visible by default
    });
    
    // Always create an initial paint layer for the session
    await ctx.db.insert("paintLayers", {
      sessionId,
      name: "Layer 1",
      layerOrder: 0,
      visible: true,
      opacity: 1,
      createdBy: userId,
      createdAt: Date.now(),
    });
    
    console.log("[createSession] Created session:", sessionId, "with userId:", userId);
    
    return sessionId;
  },
});

const sessionObjectValidator = v.object({
  _id: v.id("paintingSessions"),
  _creationTime: v.number(),
  name: v.optional(v.string()),
  createdBy: v.optional(v.id("users")),
  hasGuestOwner: v.boolean(),
  hasEditLink: v.boolean(),
  isPublic: v.boolean(),
  canvasWidth: v.number(),
  canvasHeight: v.number(),
  strokeCounter: v.number(),
  paintLayerOrder: v.optional(v.number()),
  paintLayerVisible: v.optional(v.boolean()),
  backgroundImage: v.optional(v.string()),
  thumbnailUrl: v.optional(v.string()),
  lastModified: v.optional(v.number()),
  recentStrokeOrders: v.optional(v.array(v.number())),
  recentStrokeIds: v.optional(v.array(v.id("strokes"))),
  deletedStrokeCount: v.optional(v.number()),
  lastDeletedStrokeOrder: v.optional(v.number()),
  lastAction: v.optional(v.string()),
  lastClearBatchId: v.optional(v.string()),
  aiPrompts: v.optional(v.array(v.string())),
  deletedAt: v.optional(v.number()),
});

/**
 * Strip guestOwnerKey and editKey before returning session docs to clients —
 * exposing either secret would let any viewer impersonate the owner or gain
 * unauthorized edit access. Clients only receive capability booleans.
 */
function sanitizeSession(session: Doc<"paintingSessions">) {
  // Undo/redo bookkeeping is server-internal and not part of the client shape.
  const {
    guestOwnerKey,
    editKey,
    clearHistory: _clearHistory,
    redoStack: _redoStack,
    // Purge bookkeeping is server-internal too
    purgeStartedAt: _purgeStartedAt,
    purgeTurn: _purgeTurn,
    ...rest
  } = session;
  return {
    ...rest,
    hasGuestOwner: !!guestOwnerKey,
    hasEditLink: !!editKey,
  };
}

/**
 * Get session details.
 *
 * Accepts an arbitrary string so that malformed session IDs (e.g. share links
 * truncated by a chat app) resolve to `not_found` instead of throwing an
 * ArgumentValidationError, and distinguishes a deleted/nonexistent session
 * from one the caller isn't allowed to view.
 */
export const getSession = query({
  args: {
    sessionId: v.string(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      status: v.literal("ok"),
      session: sessionObjectValidator,
      canEdit: v.boolean(),
      isOwner: v.boolean(),
    }),
    v.object({ status: v.literal("not_found") }),
    v.object({ status: v.literal("unauthorized") }),
  ),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("paintingSessions", args.sessionId);
    if (!sessionId) return { status: "not_found" as const };

    const session = await ctx.db.get(sessionId);
    // Soft-deleted sessions look identical to nonexistent ones so shared
    // links show the not-found state rather than leaking that it existed.
    if (!session || session.deletedAt !== undefined) return { status: "not_found" as const };

    const access = await getSessionAccess(ctx, session, args.guestKey, args.editKey);
    if (!access.canRead) {
      return { status: "unauthorized" as const };
    }

    return {
      status: "ok" as const,
      session: sanitizeSession(session),
      canEdit: access.canEdit,
      isOwner: access.isOwner,
    };
  },
});

/**
 * List recent public sessions
 */
export const listRecentSessions = query({
  args: {},
  returns: v.array(sessionObjectValidator),
  handler: async (ctx) => {
    const sessions = await ctx.db
      .query("paintingSessions")
      .filter((q) =>
        q.and(
          q.eq(q.field("isPublic"), true),
          q.eq(q.field("deletedAt"), undefined),
        ),
      )
      .order("desc")
      .take(20);
    return sessions.map(sanitizeSession);
  },
});

/**
 * Get all sessions created by the authenticated user
 */
export const getUserSessions = query({
  args: {},
  returns: v.array(sessionObjectValidator),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Find the user by their Better Auth ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (!user) {
      return [];
    }

    // Owned sessions only. Contributions to another user's canvas do not
    // grant ownership and must not expose that canvas in My Library.
    // The index avoids scanning every session doc, which is especially
    // important while thumbnails are stored inline.
    const ownedSessions = await ctx.db
      .query("paintingSessions")
      .withIndex("by_creator", (q) => q.eq("createdBy", user._id))
      .order("desc")
      .collect();
    const sessions = ownedSessions.filter(
      (session) => session.deletedAt === undefined,
    );

    // Sort by lastModified (fallback to creation time), desc
    sessions.sort((a, b) => {
      const ta = a.lastModified ?? a._creationTime;
      const tb = b.lastModified ?? b._creationTime;
      return tb - ta;
    });

    return sessions.map(sanitizeSession);
  },
});

/**
 * Update session name
 */
export const updateSessionName = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be logged in to rename sessions");
    }

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) {
      throw new Error("Session not found");
    }

    // Find the user
    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    // Check if user owns this session
    if (!user || session.createdBy !== user._id) {
      throw new Error("You can only rename your own sessions");
    }

    await ctx.db.patch(args.sessionId, {
      name: args.name,
    });
  },
});

/**
 * Delete a session (soft delete by marking as deleted).
 *
 * The session and its data stay in the database for a grace window so the
 * owner can restore it (see restoreSession); a cron hard-deletes expired
 * sessions and their associated documents (see purgeDeletedSessions).
 */
export const deleteSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be logged in to delete sessions");
    }

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) {
      throw new Error("Session not found");
    }

    // Find the user
    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    // Check if user owns this session
    if (!user || session.createdBy !== user._id) {
      throw new Error("You can only delete your own sessions");
    }

    await ctx.db.patch(args.sessionId, { deletedAt: Date.now() });
  },
});

/**
 * Restore a soft-deleted session (owner only). Only possible until the
 * purge cron hard-deletes it after the grace window.
 */
export const restoreSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.union(v.literal("restored"), v.literal("not_found"), v.literal("expired")),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be logged in to restore sessions");
    }

    const session = await ctx.db.get(args.sessionId);
    if (!session) return "not_found";

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();
    // Non-owners get the same answer as a missing id so they can't probe
    // whether a session exists (getSession deliberately hides this too)
    if (!user || session.createdBy !== user._id) {
      return "not_found";
    }

    if (session.deletedAt === undefined) return "restored"; // already live
    // Past the grace window (or once the purge has started deleting its
    // children) a session can't come back partially purged.
    if (
      session.purgeStartedAt !== undefined ||
      session.deletedAt < Date.now() - DELETED_SESSION_GRACE_MS
    ) {
      return "expired";
    }
    // Restoring never revives the old collaboration link: any edit link that
    // was shared before the delete stays dead until the owner enables a new one.
    await ctx.db.patch(args.sessionId, { deletedAt: undefined, editKey: undefined });
    return "restored";
  },
});

// Soft-deleted sessions are restorable for this long before the purge cron
// hard-deletes them and their associated documents.
export const DELETED_SESSION_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Per purge run: newly expired sessions queued, queued sessions visited, and
// child documents deleted in total / per session turn. Runs reschedule
// themselves immediately while work remains, so these bound one transaction,
// not overall throughput.
export const PURGE_ENQUEUE_PER_RUN = 50;
export const PURGE_SESSIONS_PER_RUN = 10;
export const PURGE_DOCS_PER_RUN = 400;
export const PURGE_DOCS_PER_SESSION_TURN = 200;

type PurgeCtx = MutationCtx;

/**
 * Delete up to `limit` child documents of one session (storage-bearing tables
 * first), then free every blob those rows referenced that no live row still
 * references. Returns how many documents were deleted and whether the session
 * has no children left.
 */
async function purgeSessionChildren(
  ctx: PurgeCtx,
  sessionId: Id<"paintingSessions">,
  limit: number,
): Promise<{ deleted: number; drained: boolean }> {
  const candidateBlobs = new Set<Id<"_storage">>();
  const track = (id: Id<"_storage"> | undefined) => {
    if (id) candidateBlobs.add(id);
  };

  // Each step takes at most `n` rows of one table, deletes them, and returns
  // how many it deleted.
  const steps: Array<(n: number) => Promise<number>> = [
    async (n) => {
      const docs = await ctx.db.query("uploadedImages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n);
      for (const doc of docs) {
        track(doc.storageId);
        await ctx.db.delete(doc._id);
      }
      return docs.length;
    },
    async (n) => {
      const docs = await ctx.db.query("aiGenerations").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n);
      for (const doc of docs) {
        track(doc.canvasSnapshotId);
        track(doc.generatedImageId);
        await ctx.db.delete(doc._id);
      }
      return docs.length;
    },
    async (n) => {
      const docs = await ctx.db.query("aiGeneratedImages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n);
      for (const doc of docs) {
        track(doc.storageId);
        await ctx.db.delete(doc._id);
      }
      return docs.length;
    },
    async (n) => {
      const docs = await ctx.db.query("imageMerges").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n);
      for (const doc of docs) {
        track(doc.mergedImageStorageId);
        await ctx.db.delete(doc._id);
      }
      return docs.length;
    },
    async (n) => {
      const docs = await ctx.db.query("backgroundRemovals").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n);
      for (const doc of docs) {
        track(doc.resultStorageId);
        await ctx.db.delete(doc._id);
      }
      return docs.length;
    },
    async (n) => {
      const docs = await ctx.db.query("imageUploadIntents").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n);
      for (const doc of docs) {
        track(doc.storageId);
        await ctx.db.delete(doc._id);
      }
      return docs.length;
    },
    // Tables without storage references
    async (n) => deleteAll(ctx, await ctx.db.query("strokes").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n)),
    async (n) => deleteAll(ctx, await ctx.db.query("deletedStrokes").withIndex("by_session_deleted", (q) => q.eq("sessionId", sessionId)).take(n)),
    async (n) => deleteAll(ctx, await ctx.db.query("liveStrokes").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n)),
    async (n) => deleteAll(ctx, await ctx.db.query("userPresence").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n)),
    async (n) => deleteAll(ctx, await ctx.db.query("viewerStates").withIndex("by_session_viewer", (q) => q.eq("sessionId", sessionId)).take(n)),
    async (n) => deleteAll(ctx, await ctx.db.query("webrtcSignals").withIndex("by_session_to", (q) => q.eq("sessionId", sessionId)).take(n)),
    async (n) => deleteAll(ctx, await ctx.db.query("paintLayers").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(n)),
  ];

  let remaining = limit;
  let drained = true;
  for (const step of steps) {
    if (remaining <= 0) {
      drained = false;
      break;
    }
    const deleted = await step(remaining);
    // A full batch may have left more rows behind
    if (deleted === remaining) drained = false;
    remaining -= deleted;
  }

  // The rows are gone, so reference counting only sees other live references
  for (const storageId of candidateBlobs) {
    await deleteStorageIfUnreferenced(ctx, storageId);
  }
  return { deleted: limit - remaining, drained };
}

async function deleteAll(ctx: PurgeCtx, docs: Array<{ _id: Id<TableNames> }>): Promise<number> {
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length;
}

/**
 * Hard-delete sessions whose grace window has expired, along with their
 * associated documents and storage files.
 *
 * Expired sessions are first queued (purgeStartedAt, which also blocks
 * restoreSession) and then served round-robin by `purgeTurn`: each visit
 * deletes a bounded batch of the session's children and moves it to the back
 * of the queue, so a huge session can't starve the rest. A session's own doc
 * is deleted only once every child table is empty. Each run is bounded and
 * reschedules itself immediately while any work remains.
 */
export const purgeDeletedSessions = internalMutation({
  args: {},
  returns: v.object({
    queued: v.number(),
    purged: v.number(),
    deletedDocs: v.number(),
    rescheduled: v.boolean(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - DELETED_SESSION_GRACE_MS;

    const lastQueued = await ctx.db
      .query("paintingSessions")
      .withIndex("by_purge_turn", (q) => q.gt("purgeTurn", 0))
      .order("desc")
      .first();
    let nextTurn = (lastQueued?.purgeTurn ?? 0) + 1;

    // 1. Queue sessions whose grace window just passed
    const newlyExpired = await ctx.db
      .query("paintingSessions")
      .withIndex("by_purge_started_deleted", (q) =>
        q.eq("purgeStartedAt", undefined).gt("deletedAt", 0).lt("deletedAt", cutoff),
      )
      .take(PURGE_ENQUEUE_PER_RUN);
    for (const session of newlyExpired) {
      await ctx.db.patch(session._id, { purgeStartedAt: now, purgeTurn: nextTurn++ });
    }

    // 2. Serve queued sessions round-robin within the run's document budget
    const queue = await ctx.db
      .query("paintingSessions")
      .withIndex("by_purge_turn", (q) => q.gt("purgeTurn", 0))
      .take(PURGE_SESSIONS_PER_RUN);

    let budget = PURGE_DOCS_PER_RUN;
    let workRemains =
      newlyExpired.length === PURGE_ENQUEUE_PER_RUN || queue.length === PURGE_SESSIONS_PER_RUN;
    let purged = 0;
    for (const session of queue) {
      if (budget <= 0) {
        workRemains = true;
        break;
      }
      const { deleted, drained } = await purgeSessionChildren(
        ctx,
        session._id,
        Math.min(budget, PURGE_DOCS_PER_SESSION_TURN),
      );
      budget -= deleted;
      if (drained) {
        await ctx.db.delete(session._id);
        purged += 1;
        console.log("[purgeDeletedSessions] Hard-deleted session", session._id);
      } else {
        await ctx.db.patch(session._id, { purgeTurn: nextTurn++ });
        workRemains = true;
      }
    }

    if (workRemains) {
      await ctx.scheduler.runAfter(0, internal.paintingSessions.purgeDeletedSessions, {});
    }
    return {
      queued: newlyExpired.length,
      purged,
      deletedDocs: PURGE_DOCS_PER_RUN - budget,
      rescheduled: workRemains,
    };
  },
});

// Session-document size guards: an unbounded prompt list or thumbnail could
// push the session doc to Convex's size limit and make every later patch fail.
export const MAX_SESSION_PROMPTS = 50;
export const MAX_THUMBNAIL_URL_LENGTH = 200 * 1024; // ~200 KB as a string

function assertValidThumbnailUrl(url: string) {
  if (url.length > MAX_THUMBNAIL_URL_LENGTH) {
    throw new Error("Thumbnail is too large");
  }
  const isImageDataUrl = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url);
  let isHttpsUrl = false;
  if (!isImageDataUrl) {
    try {
      isHttpsUrl = new URL(url).protocol === "https:";
    } catch {
      isHttpsUrl = false;
    }
  }
  if (!isImageDataUrl && !isHttpsUrl) {
    throw new Error("Thumbnail must be an image data URL or an HTTPS URL");
  }
}

/**
 * Update session thumbnail
 */
export const updateSessionThumbnail = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    thumbnailUrl: v.string(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) {
      throw new Error("Session not found");
    }

    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });
    assertValidThumbnailUrl(args.thumbnailUrl);

    await ctx.db.patch(args.sessionId, {
      thumbnailUrl: args.thumbnailUrl,
      lastModified: Date.now(),
    });
  },
});

/**
 * Add AI prompt to session history
 */
export const addAIPrompt = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) {
      throw new Error("Session not found");
    }

    await assertCanModifySession(ctx, session, args.guestKey, { editKey: args.editKey });

    if (isPromptTooLong(args.prompt)) {
      throw new Error(`Prompt is too long (max ${MAX_PROMPT_LENGTH} characters)`);
    }

    const currentPrompts = session.aiPrompts || [];

    // Only add if it's not already in the list (avoid duplicates). Keep the
    // most recent MAX_SESSION_PROMPTS so the session document stays bounded.
    if (!currentPrompts.includes(args.prompt)) {
      await ctx.db.patch(args.sessionId, {
        aiPrompts: [...currentPrompts, args.prompt].slice(-MAX_SESSION_PROMPTS),
        lastModified: Date.now(),
      });
    }
  },
});

/**
 * Get AI prompts for a session
 */
export const getAIPrompts = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
    }
    return session.aiPrompts || [];
  },
});

/**
 * Claim ownership of a guest-owned session for the authenticated user.
 *
 * Historically this claimed orphaned public sessions without proof, which
 * allowed any signed-in viewer to hijack a public canvas. Ownership claims now
 * require a constant-time matching guestOwnerKey (never an editKey or public flag).
 */
export const claimSessionOwnership = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) return;

    // Only claim if no owner is set and the caller proves guest ownership
    if (session.createdBy !== undefined) return;
    if (!session.guestOwnerKey || !args.guestKey || !keysMatch(session.guestOwnerKey, args.guestKey)) {
      return;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();
    if (!user) return;

    await ctx.db.patch(args.sessionId, {
      createdBy: user._id,
      guestOwnerKey: undefined,
      lastModified: Date.now(),
    });
  },
});

/**
 * Claim a guest-owned session for the authenticated user.
 *
 * The guest key proves the caller's device created the session before they
 * signed in, so ownership moves to their account and the key is cleared.
 * This is how a guest's painting survives the sign-in round-trip.
 */
export const claimGuestSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.string(),
  },
  returns: v.union(
    v.literal("claimed"),
    v.literal("already_owned"),
    v.literal("invalid"),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return "invalid";

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) return "invalid";

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (session.createdBy !== undefined) {
      return user && session.createdBy === user._id ? "already_owned" : "invalid";
    }
    if (!session.guestOwnerKey || !keysMatch(session.guestOwnerKey, args.guestKey)) {
      return "invalid";
    }

    // Only create a missing user row once the claim is proven valid, so bogus
    // claim attempts can't mint accounts/welcome tokens as a side effect.
    // Fallback: the signup trigger normally creates the row (see createSession).
    const userId =
      user?._id ??
      (await createUserWithWelcomeTokens(ctx, {
        authId: identity.subject,
        email: identity.email,
        name: identity.name || identity.givenName,
      }));

    await ctx.db.patch(args.sessionId, {
      createdBy: userId,
      guestOwnerKey: undefined,
      lastModified: Date.now(),
    });
    return "claimed";
  },
});

/**
 * Set session public read-only accessibility (owner only)
 */
export const setSessionVisibility = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    isPublic: v.boolean(),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) throw new Error("Session not found");

    try {
      await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });
    } catch {
      throw new Error("Only the owner can change visibility");
    }

    await ctx.db.patch(args.sessionId, { isPublic: args.isPublic, lastModified: Date.now() });
  },
});

/**
 * Get the current secret edit key for a session (owner only).
 * Returns null for non-owners or when no edit link is active.
 */
export const getSessionEditKey = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) return null;
    if (!(await isSessionOwner(ctx, session, args.guestKey))) {
      return null;
    }
    return session.editKey ?? null;
  },
});

/**
 * Enable (or return the existing) secret collaboration edit link (owner only).
 */
export const enableEditLink = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) throw new Error("Session not found");

    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

    if (session.editKey) {
      return session.editKey;
    }

    const editKey = generateEditKey([session.guestOwnerKey]);
    await ctx.db.patch(args.sessionId, { editKey, lastModified: Date.now() });
    return editKey;
  },
});

/**
 * Rotate the secret collaboration edit link, immediately invalidating any
 * previously issued edit link (owner only).
 */
export const rotateEditLink = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) throw new Error("Session not found");

    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

    const editKey = generateEditKey([session.guestOwnerKey, session.editKey]);
    await ctx.db.patch(args.sessionId, { editKey, lastModified: Date.now() });
    await evictCollaborators(ctx, session);
    return editKey;
  },
});

/**
 * Revoke and disable the collaboration edit link (owner only).
 */
export const revokeEditLink = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) throw new Error("Session not found");

    await assertCanModifySession(ctx, session, args.guestKey, { ownerOnly: true });

    await ctx.db.patch(args.sessionId, { editKey: undefined, lastModified: Date.now() });
    await evictCollaborators(ctx, session);
    return null;
  },
});

/**
 * Admin path for legacy ownerless sessions (no `createdBy` and no guest owner
 * key). Before AUD-005 such public sessions were editable by anyone; now
 * nobody can edit, claim or delete them. Run from the Convex dashboard or
 * `npx convex run paintingSessions:resolveOwnerlessSession` to either assign
 * an owner or soft-delete the session (the purge cron hard-deletes it after
 * the grace window). Sessions that already have an owner are left untouched.
 */
export const resolveOwnerlessSession = internalMutation({
  args: {
    sessionId: v.id("paintingSessions"),
    action: v.union(v.literal("assign"), v.literal("delete")),
    ownerUserId: v.optional(v.id("users")),
  },
  returns: v.union(
    v.literal("assigned"),
    v.literal("deleted"),
    v.literal("not_found"),
    v.literal("has_owner"),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return "not_found" as const;
    if (session.createdBy !== undefined || session.guestOwnerKey) {
      return "has_owner" as const;
    }
    if (args.action === "assign") {
      if (!args.ownerUserId || !(await ctx.db.get(args.ownerUserId))) {
        throw new Error("ownerUserId must reference an existing user");
      }
      await ctx.db.patch(args.sessionId, {
        createdBy: args.ownerUserId,
        lastModified: Date.now(),
      });
      return "assigned" as const;
    }
    await ctx.db.patch(args.sessionId, {
      deletedAt: session.deletedAt ?? Date.now(),
      editKey: undefined,
    });
    return "deleted" as const;
  },
});
