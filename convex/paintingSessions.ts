import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { createUserWithWelcomeTokens } from "./users";

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
 * Strip guestOwnerKey before returning session docs to clients — exposing the
 * key would let any viewer impersonate the guest owner. Clients only need to
 * know whether a guest owner exists.
 */
function sanitizeSession(session: Doc<"paintingSessions">) {
  const { guestOwnerKey, ...rest } = session;
  return { ...rest, hasGuestOwner: !!guestOwnerKey };
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
  },
  returns: v.union(
    v.object({ status: v.literal("ok"), session: sessionObjectValidator }),
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

    if (session.isPublic) return { status: "ok" as const, session: sanitizeSession(session) };

    // Private: only owner can view
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
        .first();
      if (user && session.createdBy === user._id) return { status: "ok" as const, session: sanitizeSession(session) };
    }

    // Guest ownership
    if (session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey) {
      return { status: "ok" as const, session: sanitizeSession(session) };
    }
    return { status: "unauthorized" as const };
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

    // Collect sessionIds associated with this user through ownership or contributions
    const sessionIdSet = new Set<Id<"paintingSessions">>();

    // 1) Owned sessions (indexed — avoids scanning every session doc,
    // which blows the 16MB read limit because thumbnails are stored inline)
    const ownedSessions = await ctx.db
      .query("paintingSessions")
      .withIndex("by_creator", (q) => q.eq("createdBy", user._id))
      .order("desc")
      .collect();
    ownedSessions.forEach((s) => sessionIdSet.add(s._id));

    // 2-4) Sessions contributed to. Stroke docs carry full point arrays, so
    // reads must stay bounded: only the most recent contributions are
    // considered. Older contributed-to sessions won't appear unless owned.
    const userStrokes = await ctx.db
      .query("strokes")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(300);
    userStrokes.forEach((st) => sessionIdSet.add(st.sessionId));

    const userUploads = await ctx.db
      .query("uploadedImages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(200);
    userUploads.forEach((img) => sessionIdSet.add(img.sessionId));

    const userLayers = await ctx.db
      .query("paintLayers")
      .withIndex("by_user", (q) => q.eq("createdBy", user._id))
      .order("desc")
      .take(200);
    userLayers.forEach((pl) => sessionIdSet.add(pl.sessionId));

    // Fetch session docs for all collected IDs
    const sessions: Array<Doc<"paintingSessions">> = [];

    for (const sessionId of sessionIdSet) {
      const session = await ctx.db.get(sessionId);
      if (session && session.deletedAt === undefined) sessions.push(session);
    }

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
    if (!session) {
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
    if (!user || session.createdBy !== user._id) {
      throw new Error("You can only restore your own sessions");
    }

    if (session.deletedAt === undefined) return "restored"; // already live
    await ctx.db.patch(args.sessionId, { deletedAt: undefined });
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

/**
 * Update session thumbnail
 */
export const updateSessionThumbnail = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    thumbnailUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

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
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const currentPrompts = session.aiPrompts || [];
    
    // Only add if it's not already in the list (avoid duplicates)
    if (!currentPrompts.includes(args.prompt)) {
      await ctx.db.patch(args.sessionId, {
        aiPrompts: [...currentPrompts, args.prompt],
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
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return [];
    }
    if (!session.isPublic) {
      const identity = await ctx.auth.getUserIdentity();
      let authorized = false;
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
          .first();
        authorized = !!user && session.createdBy === user._id;
      }
      if (!authorized) {
        if (!(session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey)) {
          return [];
        }
      }
    }
    return session.aiPrompts || [];
  },
});

/**
 * Claim ownership of an orphaned session (createdBy is undefined)
 * Assigns to the current authenticated user if no owner is set.
 */
export const claimSessionOwnership = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;

    const session = await ctx.db.get(args.sessionId);
    if (!session) return;

    // Only claim if no owner is set
    if (session.createdBy !== undefined) return;
    // Don't override guest-owned sessions
    if (session.guestOwnerKey) return;

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();
    if (!user) return;

    await ctx.db.patch(args.sessionId, { createdBy: user._id });
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
    if (!session) return "invalid";

    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();

    if (session.createdBy !== undefined) {
      return user && session.createdBy === user._id ? "already_owned" : "invalid";
    }
    if (!session.guestOwnerKey || session.guestOwnerKey !== args.guestKey) {
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
 * Set session public accessibility (owner only)
 */
export const setSessionVisibility = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    isPublic: v.boolean(),
    guestKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    
    // If authenticated, require owner
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
        .first();
      if (!user) throw new Error("User not found");
      if (session.createdBy !== user._id) {
        // Not owner as user, try guest key
        if (!(session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey)) {
          throw new Error("Only the owner can change visibility");
        }
      }
    } else {
      // Guest path: validate guest key
      if (!(session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey)) {
        throw new Error("Only the owner can change visibility");
      }
    }

    await ctx.db.patch(args.sessionId, { isPublic: args.isPublic, lastModified: Date.now() });
  },
});
