import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Join a P2P session and get list of current peers
 */
export const joinP2PSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    peerId: v.string(), // Client-generated peer ID
    roomKey: v.string(), // Room authentication key
  },
  returns: v.object({
    peers: v.array(v.string()),
    mode: v.union(v.literal("mesh"), v.literal("sfu")),
  }),
  handler: async (ctx, args) => {
    // Verify session exists
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    
    // TODO: Verify room key matches session
    // For now, we'll skip authentication
    
    // Get active peers from presence data
    const thirtySecondsAgo = Date.now() - 30 * 1000;
    const activePeers = await ctx.db
      .query("userPresence")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .filter((q) => q.gt(q.field("lastSeen"), thirtySecondsAgo))
      .collect();
    
    console.log("Active peers in session:", activePeers.map(p => ({ 
      userName: p.userName, 
      userId: p.userId,
      lastSeen: p.lastSeen 
    })));
    console.log("Looking for peers different from:", args.peerId);
    
    // Extract peer IDs - use userId if it matches a user ID pattern, otherwise use userName
    const peerIds = activePeers
      .map(p => {
        // If the peer has a userId, use the ID string representation
        if (p.userId) {
          const idStr = p.userId.toString();
          console.log(`Peer ${p.userName} has userId: ${idStr}`);
          return idStr;
        }
        // Otherwise use userName
        console.log(`Peer ${p.userName} has no userId, using name`);
        return p.userName;
      })
      .filter(id => id !== args.peerId);
    
    console.log("Final peer list:", peerIds);
    
    // Determine connection mode based on peer count
    const mode: "mesh" | "sfu" = peerIds.length >= 4 ? "sfu" : "mesh";
    
    return {
      peers: peerIds,
      mode,
    };
  },
});

/**
 * Send WebRTC signaling data (offer/answer/ICE)
 */
export const sendSignal = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    fromPeerId: v.string(),
    toPeerId: v.string(),
    type: v.union(v.literal("offer"), v.literal("answer"), v.literal("ice-candidate")),
    data: v.any(), // SDP or ICE candidate data
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Store signal in database
    await ctx.db.insert("webrtcSignals", {
      sessionId: args.sessionId,
      fromPeerId: args.fromPeerId,
      toPeerId: args.toPeerId,
      type: args.type,
      data: args.data,
      timestamp: Date.now(),
    });
    
    return null;
  },
});

/**
 * Retrieve pending signals for a peer
 */
export const getSignals = query({
  args: {
    sessionId: v.id("paintingSessions"),
    peerId: v.string(),
  },
  returns: v.array(v.object({
    id: v.id("webrtcSignals"),
    fromPeerId: v.string(),
    type: v.union(v.literal("offer"), v.literal("answer"), v.literal("ice-candidate")),
    data: v.any(),
  })),
  handler: async (ctx, args) => {
    // Get signals for this peer
    const signals = await ctx.db
      .query("webrtcSignals")
      .withIndex("by_session_to", (q) => 
        q.eq("sessionId", args.sessionId).eq("toPeerId", args.peerId)
      )
      .collect();
    
    // Note: In a query handler, we cannot delete. Signals will be cleaned up by the cron job
    // or we could create a separate mutation to delete them after reading
    
    // Return the necessary fields including ID for deletion
    return signals.map(s => ({
      id: s._id,
      fromPeerId: s.fromPeerId,
      type: s.type,
      data: s.data,
    }));
  },
});

/**
 * Delete signals after reading
 */
export const deleteSignals = mutation({
  args: {
    signalIds: v.array(v.id("webrtcSignals")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.signalIds) {
      try {
        // Check if document exists before deleting
        const doc = await ctx.db.get(id);
        if (doc) {
          await ctx.db.delete(id);
        }
      } catch (error) {
        // Ignore errors for non-existent documents
        console.log(`Signal ${id} already deleted or doesn't exist`);
      }
    }
    return null;
  },
});

/**
 * Leave P2P session (cleanup)
 */
export const leaveP2PSession = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    peerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Clean up any pending signals for this peer
    const signalsTo = await ctx.db
      .query("webrtcSignals")
      .withIndex("by_session_to", (q) => 
        q.eq("sessionId", args.sessionId).eq("toPeerId", args.peerId)
      )
      .collect();
    
    for (const signal of signalsTo) {
      await ctx.db.delete(signal._id);
    }
    
    // Clean up signals from this peer
    const signalsFrom = await ctx.db
      .query("webrtcSignals")
      .filter((q) => 
        q.and(
          q.eq(q.field("sessionId"), args.sessionId),
          q.eq(q.field("fromPeerId"), args.peerId)
        )
      )
      .collect();
    
    for (const signal of signalsFrom) {
      await ctx.db.delete(signal._id);
    }
    
    return null;
  },
});

/**
 * Clean up old WebRTC signals (older than 1 minute)
 */
export const cleanupOldSignals = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const oneMinuteAgo = Date.now() - 60 * 1000;
    
    const oldSignals = await ctx.db
      .query("webrtcSignals")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", oneMinuteAgo))
      .collect();
    
    for (const signal of oldSignals) {
      await ctx.db.delete(signal._id);
    }
    
    return null;
  },
});