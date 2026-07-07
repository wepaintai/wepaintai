import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel, Id } from "./_generated/dataModel";

const INITIAL_TOKENS = 10;

/** Look up an app user by their Better Auth user id (identity.subject). */
export async function getUserByAuthId(
  ctx: GenericQueryCtx<DataModel>,
  authId: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("by_auth_id", (q) => q.eq("authId", authId))
    .first();
}

/** Create an app user row with the welcome token grant. */
export async function createUserWithWelcomeTokens(
  ctx: GenericMutationCtx<DataModel>,
  args: { authId: string; email?: string; name?: string },
): Promise<Id<"users">> {
  const userId = await ctx.db.insert("users", {
    authId: args.authId,
    email: args.email,
    name: args.name || args.email?.split("@")[0] || "User",
    tokens: INITIAL_TOKENS,
    lifetimeTokensUsed: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await ctx.db.insert("tokenTransactions", {
    userId,
    type: "initial",
    amount: INITIAL_TOKENS,
    balance: INITIAL_TOKENS,
    description: "Welcome bonus - 10 free tokens",
    createdAt: Date.now(),
  });

  return userId;
}
