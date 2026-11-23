import { mutation, query, internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertCanModifySession,
  canReadSession,
  keysMatch,
  resolveAuthenticatedUser,
} from "./sessionAuth";

function generateLeaveToken(): string {
  const bytes = new Uint8Array(24);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    // Presence must never hard-fail on the runtime's crypto support. Convex
    // seeds Math.random in mutations with a strong per-execution seed; the
    // token only authorizes removing the holder's own presence row.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type PresenceIdentity =
  | { userId: Id<"users">; guestId?: undefined }
  | { userId?: undefined; guestId: string };

/**
 * Resolve whose presence a caller may touch: the authenticated user, or (for
 * guests) their own per-browser guestId. A caller-supplied userId is never
 * trusted; it is ignored rather than rejected so stale clients degrade
 * quietly. Returns null when the caller may not touch presence at all.
 */
async function resolvePresenceIdentity(
  ctx: MutationCtx,
  session: Doc<"paintingSessions"> | null,
  args: { guestKey?: string; guestId?: string; editKey?: string },
): Promise<PresenceIdentity | null> {
  if (!session || session.deletedAt !== undefined) return null;
  let user: Doc<"users"> | null;
  try {
    // Presence is an editor-only signal: read-only viewers of a public
    // session (no owner key, no edit key) are not shown in the strip.
    ({ user } = await assertCanModifySession(ctx, session, args.guestKey, {
      editKey: args.editKey,
    }));
  } catch {
    return null;
  }
  if (user) return { userId: user._id };
  if (args.guestId) return { guestId: args.guestId };
  // No stable identity (e.g. an old unauthenticated client that only sent a
  // userId): skip instead of writing a shared anonymous row.
  return null;
}

async function findPresence(
  ctx: MutationCtx,
  sessionId: Id<"paintingSessions">,
  identity: PresenceIdentity,
) {
  return identity.userId
    ? await ctx.db
        .query("userPresence")
        .withIndex("by_user_session", (q) =>
          q.eq("userId", identity.userId).eq("sessionId", sessionId)
        )
        .first()
    : await ctx.db
        .query("userPresence")
        .withIndex("by_guest_session", (q) =>
          q.eq("guestId", identity.guestId).eq("sessionId", sessionId)
        )
        .first();
}

/**
 * Update user presence in a session.
 *
 * Presence is best-effort: unauthorized callers and a userId that doesn't
 * match ctx.auth are ignored (returns null) instead of throwing, so old
 * clients don't surface sync errors. Returns the caller's presence id and a
 * leave token that authorizes the sendBeacon leave route.
 */
export const updatePresence = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    // Accepted for old clients; identity always comes from ctx.auth.
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
    userColor: v.string(),
    userName: v.string(),
    cursorX: v.number(),
    cursorY: v.number(),
    isDrawing: v.boolean(),
    currentTool: v.string(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({ presenceId: v.id("userPresence"), leaveToken: v.string() }),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    const identity = await resolvePresenceIdentity(ctx, session, args);
    if (!identity) return null;

    const now = Date.now();
    const userName = args.userName.slice(0, 100);
    const userColor = args.userColor.slice(0, 64);
    const currentTool = args.currentTool.slice(0, 32);
    const existingPresence = await findPresence(ctx, args.sessionId, identity);

    if (existingPresence) {
      const leaveToken = existingPresence.leaveToken ?? generateLeaveToken();
      // If an identical update arrived within a short window, skip writing to reduce conflicts
      const recentlyUpdated = now - (existingPresence.lastSeen || 0) < 200;
      const noChange =
        existingPresence.cursorX === args.cursorX &&
        existingPresence.cursorY === args.cursorY &&
        existingPresence.isDrawing === args.isDrawing &&
        existingPresence.currentTool === currentTool &&
        existingPresence.userColor === userColor &&
        existingPresence.userName === userName;
      if (recentlyUpdated && noChange && existingPresence.leaveToken) {
        return { presenceId: existingPresence._id, leaveToken };
      }
      // Replace the entire document to avoid conflicts (carrying the token over)
      await ctx.db.replace(existingPresence._id, {
        sessionId: args.sessionId,
        userId: identity.userId,
        guestId: identity.guestId,
        userColor,
        userName,
        cursorX: args.cursorX,
        cursorY: args.cursorY,
        isDrawing: args.isDrawing,
        currentTool,
        lastSeen: now,
        leaveToken,
      });
      return { presenceId: existingPresence._id, leaveToken };
    }

    const leaveToken = generateLeaveToken();
    const presenceId = await ctx.db.insert("userPresence", {
      sessionId: args.sessionId,
      userId: identity.userId,
      guestId: identity.guestId,
      userColor,
      userName,
      cursorX: args.cursorX,
      cursorY: args.cursorY,
      isDrawing: args.isDrawing,
      currentTool,
      lastSeen: now,
      leaveToken,
    });
    return { presenceId, leaveToken };
  },
});

/**
 * Get all active users in a session.
 *
 * Rows are mapped to an explicit public shape: the guest's per-browser
 * guestId (which keys guest presence/live strokes) and the leave token are
 * never returned. Clients identify rows by the opaque presence `_id`.
 */
export const getSessionPresence = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.array(v.object({
    _id: v.id("userPresence"),
    _creationTime: v.number(),
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    userName: v.string(),
    cursorX: v.number(),
    cursorY: v.number(),
    isDrawing: v.boolean(),
    currentTool: v.string(),
    lastSeen: v.number(),
  })),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!(await canReadSession(ctx, session, args.guestKey, args.editKey))) {
      return [];
    }
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000; // 5 minutes

    const rows = await ctx.db
      .query("userPresence")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.gt(q.field("lastSeen"), fiveMinutesAgo))
      .collect();
    return rows.map((p) => ({
      _id: p._id,
      _creationTime: p._creationTime,
      sessionId: p.sessionId,
      userId: p.userId,
      userColor: p.userColor,
      userName: p.userName,
      cursorX: p.cursorX,
      cursorY: p.cursorY,
      isDrawing: p.isDrawing,
      currentTool: p.currentTool,
      lastSeen: p.lastSeen,
    }));
  },
});

/**
 * Remove the caller's own presence from a session (when they leave).
 * Identity comes from ctx.auth or the caller's guestId; anything else is a
 * silent no-op, so nobody can evict another user.
 */
export const leaveSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    guestId: v.optional(v.string()),
    userName: v.optional(v.string()),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    let identity: PresenceIdentity | null;
    if (session && session.deletedAt === undefined) {
      identity = await resolvePresenceIdentity(ctx, session, args);
    } else {
      // Session is gone/deleted: authenticated callers may still clean up
      // their own row.
      const user = await resolveAuthenticatedUser(ctx);
      identity = user ? { userId: user._id } : null;
    }
    if (!identity) return null;

    const presence = await findPresence(ctx, args.sessionId, identity);
    if (presence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});

/**
 * Best-effort leave fired via navigator.sendBeacon on pagehide (tab close /
 * navigation away), routed through an HTTP action. A beacon can't carry auth,
 * so it must present the leave token issued to that presence row by
 * updatePresence. Removes that presence row and the same identity's live
 * stroke (identity taken from the row, never from the request body).
 */
export const beaconLeave = internalMutation({
  args: {
    sessionId: v.string(),
    presenceId: v.string(),
    leaveToken: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("paintingSessions", args.sessionId);
    const presenceId = ctx.db.normalizeId("userPresence", args.presenceId);
    if (!sessionId || !presenceId) return null;

    const presence = await ctx.db.get(presenceId);
    if (
      !presence ||
      presence.sessionId !== sessionId ||
      !presence.leaveToken ||
      !keysMatch(presence.leaveToken, args.leaveToken)
    ) {
      return null;
    }
    await ctx.db.delete(presence._id);

    const liveStroke = presence.userId
      ? await ctx.db
          .query("liveStrokes")
          .withIndex("by_user_session", (q) =>
            q.eq("userId", presence.userId).eq("sessionId", sessionId)
          )
          .first()
      : presence.guestId
        ? await ctx.db
            .query("liveStrokes")
            .withIndex("by_guest_session", (q) =>
              q.eq("guestId", presence.guestId).eq("sessionId", sessionId)
            )
            .first()
        : null;
    if (liveStroke) {
      await ctx.db.delete(liveStroke._id);
    }

    return null;
  },
});

/**
 * Clean up old presence records (internal function).
 * Internal-only duplicate of the cron-driven cleanup; never client-callable.
 */
export const cleanupOldPresence = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // 1 hour
    
    const oldPresence = await ctx.db
      .query("userPresence")
      .filter((q) => q.lt(q.field("lastSeen"), oneHourAgo))
      .collect();

    for (const presence of oldPresence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});

/**
 * Internal cron-safe cleanup for old presence records
 */
export const cleanupOldPresenceInternal = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // 1 hour
    
    const oldPresence = await ctx.db
      .query("userPresence")
      .filter((q) => q.lt(q.field("lastSeen"), oneHourAgo))
      .collect();

    for (const presence of oldPresence) {
      await ctx.db.delete(presence._id);
    }

    return null;
  },
});
