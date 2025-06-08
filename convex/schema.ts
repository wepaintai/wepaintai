import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  paintingSessions: defineTable({
    name: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    isPublic: v.boolean(),
    canvasWidth: v.number(),
    canvasHeight: v.number(),
    backgroundImage: v.optional(v.string()),
    strokeCounter: v.number(), // For ordering strokes globally
  }),

  strokes: defineTable({
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(), // For anonymous users
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(), // For ordering strokes
  }).index("by_session", ["sessionId", "strokeOrder"]),

  userPresence: defineTable({
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    userName: v.string(),
    cursorX: v.number(),
    cursorY: v.number(),
    isDrawing: v.boolean(),
    currentTool: v.string(),
    lastSeen: v.number(),
  }).index("by_session", ["sessionId"])
    .index("by_user_session", ["userId", "sessionId"]),

  liveStrokes: defineTable({
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    userName: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    lastUpdated: v.number(),
  }).index("by_session", ["sessionId"])
    .index("by_user_session", ["userId", "sessionId"]),

  users: defineTable({
    name: v.string(),
    email: v.optional(v.string()),
  }),

  viewerStates: defineTable({
    sessionId: v.id("paintingSessions"),
    // Using string for client-generated ID. If proper auth is added, 
    // this could be v.id("users") or a stable user identifier.
    viewerId: v.string(), 
    lastAckedStrokeOrder: v.number(),
  })
  .index("by_session_viewer", ["sessionId", "viewerId"]),

  // WebRTC signaling messages (ephemeral)
  webrtcSignals: defineTable({
    sessionId: v.id("paintingSessions"),
    fromPeerId: v.string(),
    toPeerId: v.string(),
    type: v.union(v.literal("offer"), v.literal("answer"), v.literal("ice-candidate")),
    data: v.any(),
    timestamp: v.number(),
  })
  .index("by_session_to", ["sessionId", "toPeerId"])
  .index("by_timestamp", ["timestamp"]),

  // Uploaded images for sessions
  uploadedImages: defineTable({
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    width: v.number(),
    height: v.number(),
    x: v.number(),
    y: v.number(),
    scale: v.number(),
    rotation: v.number(),
    opacity: v.number(),
    layerOrder: v.number(),
  }).index("by_session", ["sessionId", "layerOrder"]),
});

export default schema;
