import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { createUserWithWelcomeTokens } from "./users";
import {
  assertCanModifySession,
  canReadSession,
  getSessionAccess,
  isSessionOwner,
  keysMatch,
} from "./sessionAuth";
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
  returns: v.union(v.literal("restored"), v.literal("not_found")),
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
    // Restoring never revives the old collaboration link: any edit link that
    // was shared before the delete stays dead until the owner enables a new one.
    await ctx.db.patch(args.sessionId, { deletedAt: undefined, editKey: undefined });
    return "restored";
  },
});

// Soft-deleted sessions are restorable for this long before the purge cron
// hard-deletes them and their associated documents.
const DELETED_SESSION_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PURGE_SESSIONS_PER_RUN = 5;
const PURGE_DOCS_PER_TABLE = 200;

/**
 * Hard-delete sessions whose grace window has expired, along with their
 * associated documents and storage files. Reads/writes are bounded per run;
 * a session with more documents than the per-table cap is drained across
 * successive runs and its own doc is only deleted once everything else is
 * gone (so no orphans are left behind).
 */
export const purgeDeletedSessions = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - DELETED_SESSION_GRACE_MS;
    const expired = await ctx.db
      .query("paintingSessions")
      .withIndex("by_deleted", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .take(PURGE_SESSIONS_PER_RUN);

    for (const session of expired) {
      let drained = true;

      // Uploaded images carry storage files that must be deleted too
      const uploads = await ctx.db
        .query("uploadedImages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(PURGE_DOCS_PER_TABLE);
      for (const doc of uploads) {
        await ctx.storage.delete(doc.storageId).catch(() => {});
        await ctx.db.delete(doc._id);
      }
      if (uploads.length === PURGE_DOCS_PER_TABLE) drained = false;

      // AI generation records may reference stored snapshots/results
      const generations = await ctx.db
        .query("aiGenerations")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(PURGE_DOCS_PER_TABLE);
      for (const doc of generations) {
        if (doc.canvasSnapshotId) await ctx.storage.delete(doc.canvasSnapshotId).catch(() => {});
        if (doc.generatedImageId) await ctx.storage.delete(doc.generatedImageId).catch(() => {});
        await ctx.db.delete(doc._id);
      }
      if (generations.length === PURGE_DOCS_PER_TABLE) drained = false;

      // Remaining tables keyed by sessionId (no storage references)
      const sessionQueries = [
        ctx.db.query("strokes").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("deletedStrokes").withIndex("by_session_deleted", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("liveStrokes").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("userPresence").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("viewerStates").withIndex("by_session_viewer", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("webrtcSignals").withIndex("by_session_to", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("paintLayers").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("aiGeneratedImages").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("imageMerges").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
        ctx.db.query("backgroundRemovals").withIndex("by_session", (q) => q.eq("sessionId", session._id)),
      ];
      for (const query of sessionQueries) {
        const docs = await query.take(PURGE_DOCS_PER_TABLE);
        for (const doc of docs) await ctx.db.delete(doc._id);
        if (docs.length === PURGE_DOCS_PER_TABLE) drained = false;
      }

      if (drained) {
        await ctx.db.delete(session._id);
        console.log("[purgeDeletedSessions] Hard-deleted session", session._id);
      }
    }
    return null;
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
