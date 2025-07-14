import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const debugUserSessions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    
    if (!identity) {
      return {
        error: "No authenticated user",
        identity: null,
        user: null,
        sessions: []
      };
    }

    // Find the user by their Clerk ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    // Get all sessions (not filtered by user)
    const allSessions = await ctx.db
      .query("paintingSessions")
      .order("desc")
      .take(10);

    // Get sessions for this user
    const userSessions = user
      ? await ctx.db
          .query("paintingSessions")
          .filter((q) => q.eq(q.field("createdBy"), user._id))
          .collect()
      : [];

    return {
      identity: {
        subject: identity.subject,
        email: identity.email,
        name: identity.name
      },
      user: user ? {
        _id: user._id,
        clerkId: user.clerkId,
        email: user.email,
        name: user.name
      } : null,
      userSessionCount: userSessions.length,
      allSessionsInfo: allSessions.map(s => ({
        _id: s._id,
        name: s.name,
        createdBy: s.createdBy,
        _creationTime: s._creationTime
      }))
    };
  },
});

export const assignSessionToUser = mutation({
  args: {
    sessionId: v.id("paintingSessions")
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("No authenticated user");
    }

    // Find the user
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found in database");
    }

    // Get the session
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    // Update the session owner
    await ctx.db.patch(args.sessionId, {
      createdBy: user._id
    });

    return {
      sessionId: session._id,
      sessionName: session.name,
      previousOwner: session.createdBy,
      newOwner: user._id,
      updated: true
    };
  }
});

export const claimOrphanedSessions = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("No authenticated user");
    }

    // Find the user
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found in database");
    }

    // Find orphaned sessions (no owner)
    const orphanedSessions = await ctx.db
      .query("paintingSessions")
      .filter((q) => q.eq(q.field("createdBy"), undefined))
      .collect();

    // Claim them
    let claimed = 0;
    for (const session of orphanedSessions) {
      await ctx.db.patch(session._id, {
        createdBy: user._id
      });
      claimed++;
    }

    return {
      userId: user._id,
      userEmail: user.email,
      sessionsClaimed: claimed,
      orphanedSessionIds: orphanedSessions.map(s => s._id)
    };
  }
});