import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";

/**
 * Compare a stored secret (guest owner key, edit key, presence leave token)
 * with a caller-supplied value without short-circuiting on the first differing
 * character. Length is not secret (keys are fixed-size random hex).
 */
export function keysMatch(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function resolveAuthenticatedUser(
  ctx: QueryCtx,
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
    .first();
}

export function hasValidEditKey(
  session: Doc<"paintingSessions">,
  editKey: string | undefined,
  fallbackGuestKey?: string,
): boolean {
  if (!session.editKey) return false;
  if (editKey && keysMatch(session.editKey, editKey)) return true;
  if (fallbackGuestKey && keysMatch(session.editKey, fallbackGuestKey)) return true;
  return false;
}

export interface SessionAccess {
  canRead: boolean;
  canEdit: boolean;
  isOwner: boolean;
  user: Doc<"users"> | null;
}

/**
 * Evaluate caller access level for a session:
 * - `isOwner`: signed-in creator OR guest owner with constant-time matching `guestOwnerKey`
 * - `canEdit`: owner OR caller presenting a valid `editKey` capability token
 * - `canRead`: `session.isPublic` (read-only) OR `canEdit`
 *
 * `session.isPublic` NEVER grants write access.
 */
export async function getSessionAccess(
  ctx: QueryCtx,
  session: Doc<"paintingSessions"> | null,
  guestKey: string | undefined,
  editKey?: string,
): Promise<SessionAccess> {
  if (!session || session.deletedAt !== undefined) {
    return { canRead: false, canEdit: false, isOwner: false, user: null };
  }

  const user = await resolveAuthenticatedUser(ctx);
  const isOwner =
    (!!user && session.createdBy === user._id) ||
    (!!session.guestOwnerKey && !!guestKey && keysMatch(session.guestOwnerKey, guestKey));

  const canEdit = isOwner || hasValidEditKey(session, editKey, guestKey);
  const canRead = session.isPublic || canEdit;

  return { canRead, canEdit, isOwner, user };
}

export async function isSessionOwner(
  ctx: QueryCtx,
  session: Doc<"paintingSessions"> | null,
  guestKey: string | undefined,
): Promise<boolean> {
  if (!session || session.deletedAt !== undefined) {
    return false;
  }
  const user = await resolveAuthenticatedUser(ctx);
  if (user && session.createdBy === user._id) return true;
  if (session.guestOwnerKey && guestKey && keysMatch(session.guestOwnerKey, guestKey)) {
    return true;
  }
  return false;
}

export async function canReadSession(
  ctx: QueryCtx,
  session: Doc<"paintingSessions"> | null,
  guestKey: string | undefined,
  editKey?: string,
): Promise<boolean> {
  const access = await getSessionAccess(ctx, session, guestKey, editKey);
  return access.canRead;
}

/**
 * Authorization for session-modifying mutations and actions.
 * `session.isPublic` is strictly read-only and NEVER grants write access.
 * Write access requires:
 * - Signed-in session owner, OR
 * - Guest owner with matching `guestOwnerKey`, OR
 * - (When `!opts?.ownerOnly`) a valid `editKey` collaboration capability.
 *
 * Returns the resolved authenticated user (if any) so callers derive user
 * attribution strictly from `ctx.auth`.
 */
export async function assertCanModifySession(
  ctx: QueryCtx,
  session: Doc<"paintingSessions">,
  guestKey: string | undefined,
  opts?: { ownerOnly?: boolean; editKey?: string },
): Promise<{ user: Doc<"users"> | null }> {
  if (session.deletedAt !== undefined) {
    throw new Error("Session not found");
  }

  const access = await getSessionAccess(ctx, session, guestKey, opts?.editKey);

  if (opts?.ownerOnly) {
    if (access.isOwner) {
      return { user: access.user };
    }
    throw new Error("Unauthorized");
  }

  if (access.canEdit) {
    return { user: access.user };
  }

  throw new Error("Unauthorized");
}

/**
 * Internal query for Convex actions to enforce the exact same session
 * authorization policy as mutations and queries.
 */
export const verifySessionAccess = internalQuery({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
    requireAuth: v.optional(v.boolean()),
    ownerOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) {
      return { status: "not_found" as const };
    }

    const identity = await ctx.auth.getUserIdentity();
    if (args.requireAuth && !identity) {
      return { status: "unauthenticated" as const };
    }

    try {
      const { user } = await assertCanModifySession(ctx, session, args.guestKey, {
        ownerOnly: args.ownerOnly,
        editKey: args.editKey,
      });
      if (args.requireAuth && !user) {
        return { status: "unauthenticated" as const };
      }
      return {
        status: "ok" as const,
        userId: user?._id,
      };
    } catch {
      return { status: "unauthorized" as const };
    }
  },
});
