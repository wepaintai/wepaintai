import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";

/**
 * Compare a stored secret (guest owner key, presence leave token) with a
 * caller-supplied value without short-circuiting on the first differing
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

export async function canReadSession(
  ctx: QueryCtx,
  session: Doc<"paintingSessions"> | null,
  guestKey: string | undefined,
): Promise<boolean> {
  if (!session || session.deletedAt !== undefined) {
    return false;
  }

  if (session.isPublic) return true;

  const user = await resolveAuthenticatedUser(ctx);
  if (user && session.createdBy === user._id) return true;

  if (session.guestOwnerKey && guestKey && keysMatch(session.guestOwnerKey, guestKey)) {
    return true;
  }

  return false;
}

/**
 * Authorization for session-modifying mutations and actions.
 * Allows public sessions (unless ownerOnly), the signed-in owner, or the guest
 * owner with a matching key. Returns the resolved authenticated user (if any)
 * so callers derive user attribution strictly from `ctx.auth`.
 */
export async function assertCanModifySession(
  ctx: QueryCtx,
  session: Doc<"paintingSessions">,
  guestKey: string | undefined,
  opts?: { ownerOnly?: boolean },
): Promise<{ user: Doc<"users"> | null }> {
  if (session.deletedAt !== undefined) {
    throw new Error("Session not found");
  }

  const user = await resolveAuthenticatedUser(ctx);

  if (session.isPublic && !opts?.ownerOnly) {
    return { user };
  }

  if (user && session.createdBy === user._id) {
    return { user };
  }

  if (session.guestOwnerKey && guestKey && keysMatch(session.guestOwnerKey, guestKey)) {
    return { user };
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
