import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * Authorization for session-modifying mutations.
 * Allows public sessions (unless ownerOnly), the signed-in owner, or the guest
 * owner with a matching key.
 */
export async function assertCanModifySession(
  ctx: QueryCtx,
  session: Doc<"paintingSessions">,
  guestKey: string | undefined,
  opts?: { ownerOnly?: boolean },
): Promise<void> {
  if (session.isPublic && !opts?.ownerOnly) return;

  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
      .first();
    if (user && session.createdBy === user._id) return;
  }

  if (session.guestOwnerKey && guestKey && session.guestOwnerKey === guestKey) return;
  throw new Error("Unauthorized");
}
