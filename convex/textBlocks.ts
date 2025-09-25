import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

type OptionalString = string | undefined;

const DEFAULT_CONTENT = "Double-click to edit";
const DEFAULT_FONT_FAMILY = "Inter";
const DEFAULT_FONT_SIZE = 32;
const DEFAULT_FILL = "#111111";
const DEFAULT_LINE_HEIGHT = 1.2;

async function getSessionIfAuthorized(
  ctx: QueryCtx,
  sessionId: Id<"paintingSessions">,
  guestKey?: OptionalString
) {
  const session = await ctx.db.get(sessionId);
  if (!session) return null;

  if (!session.isPublic) {
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .first();
      if (!user || session.createdBy !== user._id) {
        if (!session.guestOwnerKey || session.guestOwnerKey !== guestKey) return null;
      }
    } else {
      if (!session.guestOwnerKey || session.guestOwnerKey !== guestKey) return null;
    }
  }

  return session;
}

async function getNextLayerOrder(
  ctx: MutationCtx,
  sessionId: Id<"paintingSessions">
) {
  const session = await ctx.db.get(sessionId);
  const baseOrder = session?.paintLayerOrder ?? 0;

  let maxLayerOrder = baseOrder;

  const [paintLayers, uploadedImages, aiImages, textBlocks] = await Promise.all([
    ctx.db
      .query("paintLayers")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
    ctx.db
      .query("uploadedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
    ctx.db
      .query("aiGeneratedImages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
    ctx.db
      .query("textBlocks")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  ]);

  paintLayers.forEach((layer) => {
    maxLayerOrder = Math.max(maxLayerOrder, layer.layerOrder);
  });
  uploadedImages.forEach((image) => {
    maxLayerOrder = Math.max(maxLayerOrder, image.layerOrder);
  });
  aiImages.forEach((image) => {
    maxLayerOrder = Math.max(maxLayerOrder, image.layerOrder);
  });
  textBlocks.forEach((block) => {
    maxLayerOrder = Math.max(maxLayerOrder, block.layerOrder);
  });

  return maxLayerOrder + 1;
}

export const getSessionTextBlocks = query({
  args: { sessionId: v.id("paintingSessions"), guestKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await getSessionIfAuthorized(ctx, args.sessionId, args.guestKey);
    if (!session) return [];

    const blocks = await ctx.db
      .query("textBlocks")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();

    return blocks.sort((a, b) => a.layerOrder - b.layerOrder);
  },
});

export const createTextBlock = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    x: v.number(),
    y: v.number(),
    content: v.optional(v.string()),
    fontFamily: v.optional(v.string()),
    fontSize: v.optional(v.number()),
    fill: v.optional(v.string()),
    opacity: v.optional(v.number()),
    lineHeight: v.optional(v.number()),
    textAlign: v.optional(
      v.union(
        v.literal("left"),
        v.literal("center"),
        v.literal("right"),
        v.literal("justify")
      )
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const layerOrder = await getNextLayerOrder(ctx, args.sessionId);

    const blockId = await ctx.db.insert("textBlocks", {
      sessionId: args.sessionId,
      content: args.content ?? DEFAULT_CONTENT,
      fontFamily: args.fontFamily ?? DEFAULT_FONT_FAMILY,
      fontSize: args.fontSize ?? DEFAULT_FONT_SIZE,
      fontStyle: "normal",
      fontWeight: "400",
      textAlign: args.textAlign ?? "left",
      lineHeight: args.lineHeight ?? DEFAULT_LINE_HEIGHT,
      fill: args.fill ?? DEFAULT_FILL,
      opacity: args.opacity ?? 1,
      x: args.x,
      y: args.y,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      width: undefined,
      height: undefined,
      layerOrder,
      isEditing: false,
      createdBy: undefined,
      createdAt: now,
      updatedAt: now,
    });

    return blockId;
  },
});

export const updateTextBlock = mutation({
  args: {
    blockId: v.id("textBlocks"),
    content: v.optional(v.string()),
    fontFamily: v.optional(v.string()),
    fontSize: v.optional(v.number()),
    fontStyle: v.optional(v.union(v.literal("normal"), v.literal("italic"))),
    fontWeight: v.optional(v.string()),
    textAlign: v.optional(
      v.union(
        v.literal("left"),
        v.literal("center"),
        v.literal("right"),
        v.literal("justify")
      )
    ),
    lineHeight: v.optional(v.number()),
    fill: v.optional(v.string()),
    opacity: v.optional(v.number()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    scaleX: v.optional(v.number()),
    scaleY: v.optional(v.number()),
    rotation: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    layerOrder: v.optional(v.number()),
    isEditing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { blockId, ...updates } = args;
    const filteredEntries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (filteredEntries.length === 0) return blockId;

    const patch = Object.fromEntries(filteredEntries) as Record<string, any>;
    patch.updatedAt = Date.now();

    await ctx.db.patch(blockId, patch);
    return blockId;
  },
});

export const deleteTextBlock = mutation({
  args: { blockId: v.id("textBlocks") },
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (!block) return;

    await ctx.db.delete(args.blockId);

    const remainingBlocks = await ctx.db
      .query("textBlocks")
      .withIndex("by_session", (q) => q.eq("sessionId", block.sessionId))
      .collect();

    const sorted = remainingBlocks.sort((a, b) => a.layerOrder - b.layerOrder);
    await Promise.all(
      sorted.map((item, index) =>
        item.layerOrder !== index ? ctx.db.patch(item._id, { layerOrder: index }) : null
      )
    );
  },
});

export const reorderTextBlock = mutation({
  args: { blockId: v.id("textBlocks"), newOrder: v.number() },
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (!block) return;

    const blocks = await ctx.db
      .query("textBlocks")
      .withIndex("by_session", (q) => q.eq("sessionId", block.sessionId))
      .collect();

    const sorted = blocks.sort((a, b) => a.layerOrder - b.layerOrder);
    const currentIndex = sorted.findIndex((b) => b._id === args.blockId);
    if (currentIndex === -1) return;

    const [moving] = sorted.splice(currentIndex, 1);

    const clampedIndex = Math.max(0, Math.min(args.newOrder, sorted.length));
    sorted.splice(clampedIndex, 0, moving);

    await Promise.all(
      sorted.map((item, index) =>
        item.layerOrder !== index ? ctx.db.patch(item._id, { layerOrder: index }) : null
      )
    );
  },
});
