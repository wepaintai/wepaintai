import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * Create a new painting session
 */
export const createSession = mutation({
  args: {
    name: v.optional(v.string()),
    canvasWidth: v.number(),
    canvasHeight: v.number(),
    isPublic: v.optional(v.boolean()),
  },
  returns: v.id("paintingSessions"),
  handler: async (ctx, args) => {
    let userId: Id<"users"> | undefined = undefined;
    
    try {
      // Get the authenticated user ID if available
      const identity = await ctx.auth.getUserIdentity();
      console.log("[createSession] Identity:", identity ? { subject: identity.subject, email: identity.email } : null);
      
      if (identity) {
        // Find the user by their Clerk ID
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
          .first();
        
        console.log("[createSession] Found user:", user ? { _id: user._id, email: user.email } : null);
        
        if (user) {
          userId = user._id;
        } else {
          // Create the user if they don't exist
          console.log("[createSession] Creating new user for:", identity.email);
          userId = await ctx.db.insert("users", {
            clerkId: identity.subject,
            email: identity.email,
            name: identity.name || identity.givenName || identity.email?.split("@")[0] || "User",
            tokens: 10, // Initial 10 tokens for new users
            lifetimeTokensUsed: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          console.log("[createSession] Created user with ID:", userId);
          
          // Record initial token grant
          await ctx.db.insert("tokenTransactions", {
            userId,
            type: "initial",
            amount: 10,
            balance: 10,
            description: "Welcome bonus - 10 free tokens",
            createdAt: Date.now(),
          });
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
      isPublic: args.isPublic ?? true,
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

/**
 * Get session details
 */
export const getSession = query({
  args: {
    sessionId: v.id("paintingSessions"),
  },
  returns: v.union(
    v.object({
      _id: v.id("paintingSessions"),
      _creationTime: v.number(),
      name: v.optional(v.string()),
      createdBy: v.optional(v.id("users")),
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
      deletedStrokeCount: v.optional(v.number()),
      aiPrompts: v.optional(v.array(v.string())),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

/**
 * List recent public sessions
 */
export const listRecentSessions = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id("paintingSessions"),
    _creationTime: v.number(),
    name: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
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
    deletedStrokeCount: v.optional(v.number()),
    aiPrompts: v.optional(v.array(v.string())),
  })),
  handler: async (ctx) => {
    return await ctx.db
      .query("paintingSessions")
      .filter((q) => q.eq(q.field("isPublic"), true))
      .order("desc")
      .take(20);
  },
});

/**
 * Get all sessions created by the authenticated user
 */
export const getUserSessions = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id("paintingSessions"),
    _creationTime: v.number(),
    name: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
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
    deletedStrokeCount: v.optional(v.number()),
    aiPrompts: v.optional(v.array(v.string())),
  })),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Find the user by their Clerk ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      return [];
    }

    // Get all sessions created by this user
    const sessions = await ctx.db
      .query("paintingSessions")
      .filter((q) => q.eq(q.field("createdBy"), user._id))
      .order("desc")
      .collect();

    return sessions;
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
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
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
 * Delete a session (soft delete by marking as deleted)
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
    if (!session) {
      throw new Error("Session not found");
    }

    // Find the user
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    // Check if user owns this session
    if (!user || session.createdBy !== user._id) {
      throw new Error("You can only delete your own sessions");
    }

    // For now, we'll do a hard delete. In the future, we might want to add a "deleted" field
    await ctx.db.delete(args.sessionId);
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
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return [];
    }
    return session.aiPrompts || [];
  },
});
