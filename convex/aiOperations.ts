/**
 * Lifecycle of token-billed AI operations (AI generation via Replicate or
 * Gemini, image merge, background removal).
 *
 * Every operation is a row in `aiGenerations`, `imageMerges` or
 * `backgroundRemovals`; the row id is the operation id that keys the token
 * debit (`<operationType>:<rowId>`) and its refund (`refund:<operationKey>`).
 *
 *   beginOperation          authorize + check balance + insert row + debit (one transaction)
 *   markOperationProcessing record that the provider accepted the request
 *   completeOperation       re-check session access, then write the result
 *   failOperation           terminal failure; refunds first when outcome = "refund"
 *   refundOperation         idempotent refund keyed by the row (no ctx.auth)
 *
 * Billing policy: refund only when the provider never accepted the request
 * (request rejected / 4xx validation / network error before acceptance, or our
 * own failure before calling the provider). Once the provider accepted the
 * request (a Replicate prediction exists, or Gemini answered 200), failures are
 * `failed_billed` and the token is not refunded.
 *
 * Status transitions only ever leave `pending`/`processing`; terminal rows
 * (`completed`, `failed`, `failed_billed`) are never rewritten, so a late
 * action and a stale-operation sweep cannot both settle the same row.
 */
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertCanModifySession } from "./sessionAuth";
import { debitUserForOperation, refundUserForOperation, tokenOperationValidator } from "./tokens";
import { getTokenCost, isPromptTooLong, MAX_PROMPT_LENGTH, type TokenOperationType } from "./tokenPolicy";

/** User-facing message for a beginOperation refusal (shared by AI actions). */
export function beginErrorMessage(
  status: "not_found" | "unauthenticated" | "unauthorized" | "insufficient_tokens" | "prompt_too_long",
): string {
  switch (status) {
    case "not_found":
      return "Session not found";
    case "unauthenticated":
      return "Please sign in to use AI features.";
    case "unauthorized":
      return "Unauthorized";
    case "insufficient_tokens":
      return "Insufficient tokens. Please purchase more tokens to continue.";
    case "prompt_too_long":
      return `Prompt is too long (max ${MAX_PROMPT_LENGTH} characters).`;
  }
}

type OperationRow =
  | Doc<"aiGenerations">
  | Doc<"imageMerges">
  | Doc<"backgroundRemovals">;

const TERMINAL_STATUSES = new Set(["completed", "failed", "failed_billed"]);

export function isTerminalOperationStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

async function loadOperationRow(
  ctx: MutationCtx,
  operationType: TokenOperationType,
  operationId: string,
): Promise<OperationRow | null> {
  if (operationType === "ai-generation") {
    const id = ctx.db.normalizeId("aiGenerations", operationId);
    return id ? await ctx.db.get(id) : null;
  }
  if (operationType === "image-merge") {
    const id = ctx.db.normalizeId("imageMerges", operationId);
    return id ? await ctx.db.get(id) : null;
  }
  const id = ctx.db.normalizeId("backgroundRemovals", operationId);
  return id ? await ctx.db.get(id) : null;
}

/**
 * Operation rows store the auth subject (`identity.subject`) in `userId`.
 * Resolve it to the app `users` row; tolerate legacy rows that stored a users
 * `_id` instead.
 */
export async function resolveOperationUser(
  ctx: MutationCtx,
  storedUserId: string | undefined,
): Promise<Doc<"users"> | null> {
  if (!storedUserId) return null;
  const byAuth = await ctx.db
    .query("users")
    .withIndex("by_auth_id", (q) => q.eq("authId", storedUserId))
    .first();
  if (byAuth) return byAuth;
  const legacyId = ctx.db.normalizeId("users", storedUserId);
  return legacyId ? await ctx.db.get(legacyId) : null;
}

async function refundOperationRow(
  ctx: MutationCtx,
  operationType: TokenOperationType,
  row: OperationRow,
  reason: string | undefined,
): Promise<{ refunded: boolean; newBalance?: number }> {
  const user = await resolveOperationUser(ctx, row.userId);
  if (!user) return { refunded: false };
  return await refundUserForOperation(ctx, user, operationType, row._id, reason);
}

/**
 * Idempotent refund keyed by the operation row. The user is derived from the
 * stored row (never ctx.auth), so crons and scheduled jobs can call it. Credits
 * only if that user has a matching usage debit, at most once per operation.
 *
 * Signature (internal.aiOperations.refundOperation):
 *   { operationType: "ai-generation" | "background-removal" | "image-merge",
 *     operationId: string (the row _id), reason?: string }
 *   -> { refunded: boolean, newBalance?: number }
 *
 * Prefer failOperation when the row should also be marked terminal.
 */
export const refundOperation = internalMutation({
  args: {
    operationType: tokenOperationValidator,
    operationId: v.string(),
    reason: v.optional(v.string()),
  },
  returns: v.object({ refunded: v.boolean(), newBalance: v.optional(v.number()) }),
  handler: async (ctx, args) => {
    const row = await loadOperationRow(ctx, args.operationType, args.operationId);
    if (!row) return { refunded: false };
    return await refundOperationRow(ctx, args.operationType, row, args.reason);
  },
});

/**
 * Atomically settle a failed operation. With outcome "refund" the token is
 * refunded first and the row becomes `failed`; with outcome "billed" the row
 * becomes `failed_billed` and nothing is refunded. Rows already in a terminal
 * state are left untouched (returns status "already_terminal").
 *
 * Signature (internal.aiOperations.failOperation):
 *   { operationType, operationId: string (the row _id),
 *     outcome: "refund" | "billed", error: string }
 *   -> { status: "failed" | "failed_billed" | "already_terminal" | "not_found",
 *        refunded: boolean }
 *
 * Stale-operation sweeps: a `pending` row never reached the provider (refund);
 * a `processing` row may have been accepted/billed by the provider (billed).
 * Replicate rows become `processing` once a prediction exists (replicateId is
 * set); Gemini rows become `processing` right before the single provider call.
 */
export const failOperation = internalMutation({
  args: {
    operationType: tokenOperationValidator,
    operationId: v.string(),
    outcome: v.union(v.literal("refund"), v.literal("billed")),
    error: v.string(),
  },
  returns: v.object({
    status: v.union(
      v.literal("failed"),
      v.literal("failed_billed"),
      v.literal("already_terminal"),
      v.literal("not_found"),
    ),
    refunded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const row = await loadOperationRow(ctx, args.operationType, args.operationId);
    if (!row) return { status: "not_found" as const, refunded: false };
    if (isTerminalOperationStatus(row.status)) {
      return { status: "already_terminal" as const, refunded: false };
    }

    let refunded = false;
    if (args.outcome === "refund") {
      refunded = (await refundOperationRow(ctx, args.operationType, row, args.error)).refunded;
    }
    const status = args.outcome === "refund" ? ("failed" as const) : ("failed_billed" as const);
    await ctx.db.patch(row._id, { status, error: args.error.slice(0, 500) });
    return { status, refunded };
  },
});

const operationSpecValidator = v.union(
  v.object({
    type: v.literal("ai-generation"),
    prompt: v.string(),
    provider: v.union(v.literal("replicate"), v.literal("gemini")),
  }),
  v.object({
    type: v.literal("image-merge"),
    firstLayerId: v.string(),
    secondLayerId: v.string(),
    controlLayerId: v.optional(v.string()),
    mergeMode: v.union(v.literal("full"), v.literal("left_right"), v.literal("top_bottom")),
  }),
  v.object({
    type: v.literal("background-removal"),
    targetLayerId: v.optional(v.string()),
  }),
);

/**
 * Authorize the caller for the session, check the balance, insert the
 * operation row and debit the token, all in one transaction. A caller without
 * enough tokens gets `insufficient_tokens` and no row is written.
 */
export const beginOperation = internalMutation({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
    operation: operationSpecValidator,
  },
  returns: v.union(
    v.object({ status: v.literal("ok"), operationId: v.string() }),
    v.object({
      status: v.union(
        v.literal("not_found"),
        v.literal("unauthenticated"),
        v.literal("unauthorized"),
        v.literal("insufficient_tokens"),
        v.literal("prompt_too_long"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.deletedAt !== undefined) {
      return { status: "not_found" as const };
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { status: "unauthenticated" as const };

    let user: Doc<"users"> | null;
    try {
      ({ user } = await assertCanModifySession(ctx, session, args.guestKey, {
        editKey: args.editKey,
      }));
    } catch {
      return { status: "unauthorized" as const };
    }
    if (!user) return { status: "unauthenticated" as const };

    const op = args.operation;
    if (op.type === "ai-generation" && isPromptTooLong(op.prompt)) {
      return { status: "prompt_too_long" as const };
    }

    if ((user.tokens ?? 0) < getTokenCost(op.type)) {
      return { status: "insufficient_tokens" as const };
    }

    const createdAt = Date.now();
    let operationId: Id<"aiGenerations"> | Id<"imageMerges"> | Id<"backgroundRemovals">;
    if (op.type === "ai-generation") {
      operationId = await ctx.db.insert("aiGenerations", {
        sessionId: args.sessionId,
        userId: identity.subject,
        prompt: op.prompt,
        status: "pending",
        provider: op.provider,
        createdAt,
      });
    } else if (op.type === "image-merge") {
      operationId = await ctx.db.insert("imageMerges", {
        sessionId: args.sessionId,
        userId: identity.subject,
        firstLayerId: op.firstLayerId,
        secondLayerId: op.secondLayerId,
        controlLayerId: op.controlLayerId,
        mergeMode: op.mergeMode,
        status: "pending",
        createdAt,
      });
    } else {
      operationId = await ctx.db.insert("backgroundRemovals", {
        sessionId: args.sessionId,
        userId: identity.subject,
        targetLayerId: op.targetLayerId,
        status: "pending",
        createdAt,
      });
    }

    // Throws (rolling back the insert) only if the balance check above raced,
    // which cannot happen inside one serializable mutation.
    await debitUserForOperation(ctx, user, op.type, operationId, {
      sessionId: args.sessionId,
      targetLayerId: op.type === "background-removal" ? op.targetLayerId : undefined,
    });

    return { status: "ok" as const, operationId };
  },
});

/**
 * Record that the request is with the provider (Replicate: the prediction id
 * once accepted; Gemini: right before the call). Stale-operation sweeps treat
 * `processing` rows as billed. No-op on terminal rows.
 */
export const markOperationProcessing = internalMutation({
  args: {
    operationType: tokenOperationValidator,
    operationId: v.string(),
    replicateId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await loadOperationRow(ctx, args.operationType, args.operationId);
    if (!row || isTerminalOperationStatus(row.status)) return false;
    await ctx.db.patch(row._id, { status: "processing", replicateId: args.replicateId });
    return true;
  },
});

/**
 * Write a successful result, re-checking session access at write time: if the
 * session was deleted, made private, or the caller otherwise lost edit access
 * while the provider was running, the result is NOT written into the session
 * (the row becomes `failed_billed`; the provider already billed it).
 */
export const completeOperation = internalMutation({
  args: {
    operationType: tokenOperationValidator,
    operationId: v.string(),
    resultImageUrl: v.string(),
    guestKey: v.optional(v.string()),
    editKey: v.optional(v.string()),
  },
  returns: v.union(
    v.literal("completed"),
    v.literal("access_lost"),
    v.literal("already_terminal"),
    v.literal("not_found"),
  ),
  handler: async (ctx, args) => {
    const row = await loadOperationRow(ctx, args.operationType, args.operationId);
    if (!row) return "not_found" as const;
    if (isTerminalOperationStatus(row.status)) return "already_terminal" as const;

    const session = await ctx.db.get(row.sessionId);
    const identity = await ctx.auth.getUserIdentity();
    let allowed = false;
    if (session && identity && identity.subject === row.userId) {
      try {
        const { user } = await assertCanModifySession(ctx, session, args.guestKey, {
          editKey: args.editKey,
        });
        allowed = user !== null;
      } catch {
        allowed = false;
      }
    }

    if (!allowed) {
      await ctx.db.patch(row._id, {
        status: "failed_billed",
        error: "Session is no longer accessible; result discarded",
      });
      return "access_lost" as const;
    }

    await ctx.db.patch(row._id, {
      status: "completed",
      error: undefined,
      resultImageUrl: args.resultImageUrl,
    });
    return "completed" as const;
  },
});
