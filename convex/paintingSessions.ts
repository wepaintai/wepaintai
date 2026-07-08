import { mutation, query } from "./_generated/server";
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
 * Get session details
 */
export const getSession = query({
  args: {
    sessionId: v.id("paintingSessions"),
    guestKey: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
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
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;

    if (session.isPublic) return sanitizeSession(session);

    // Private: only owner can view
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
        .first();
      if (user && session.createdBy === user._id) return sanitizeSession(session);
    }

    // Guest ownership
    if (session.guestOwnerKey && args.guestKey && session.guestOwnerKey === args.guestKey) {
      return sanitizeSession(session);
    }
    return null;
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
  })),
  handler: async (ctx) => {
    const sessions = await ctx.db
      .query("paintingSessions")
      .filter((q) => q.eq(q.field("isPublic"), true))
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
  returns: v.array(v.object({
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
  })),
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
      if (session) sessions.push(session);
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
      .withIndex("by_auth_id", (q) => q.eq("authId", identity.subject))
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
