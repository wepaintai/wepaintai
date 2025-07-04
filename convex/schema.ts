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
    paintLayerOrder: v.optional(v.number()), // Order of the paint layer
    paintLayerVisible: v.optional(v.boolean()), // Visibility of the paint layer
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
    isEraser: v.optional(v.boolean()), // True if this stroke is an eraser stroke
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
    // Fields are optional - Better Auth manages user metadata
    // Add any application-specific fields here
    name: v.optional(v.string()), // For existing data compatibility
    email: v.optional(v.string()), // For existing data compatibility
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

  // AI generation requests and results
  aiGenerations: defineTable({
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.string()), // User identity subject
    prompt: v.optional(v.string()), // Made optional to handle existing data
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    errorType: v.optional(v.string()), // Added missing field
    resultImageUrl: v.optional(v.string()),
    replicateId: v.optional(v.string()),
    createdAt: v.number(),
    // Fields from existing data
    canvasSnapshotId: v.optional(v.id("_storage")),
    canvasHash: v.optional(v.string()), // Added missing field
    generatedImageId: v.optional(v.id("_storage")), // Added missing field
    completedAt: v.optional(v.number()),
    processingStartedAt: v.optional(v.number()),
    processingDuration: v.optional(v.number()), // Added missing field
    strokeCount: v.optional(v.number()),
    metadata: v.optional(v.object({
      strength: v.optional(v.number()),
      style: v.optional(v.string()),
    })),
  }).index("by_session", ["sessionId"]),

  // AI-generated images (stores URLs directly)
  aiGeneratedImages: defineTable({
    sessionId: v.id("paintingSessions"),
    imageUrl: v.string(),
    width: v.number(),
    height: v.number(),
    x: v.number(),
    y: v.number(),
    scale: v.number(),
    rotation: v.number(),
    opacity: v.number(),
    layerOrder: v.number(),
    createdAt: v.number(),
  }).index("by_session", ["sessionId", "layerOrder"]),

  // Deleted strokes for undo/redo functionality
  deletedStrokes: defineTable({
    sessionId: v.id("paintingSessions"),
    userId: v.optional(v.id("users")),
    userColor: v.string(),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number()),
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    strokeOrder: v.number(),
    isEraser: v.optional(v.boolean()),
    deletedAt: v.number(),
  }).index("by_session_deleted", ["sessionId", "deletedAt"]),
});

export default schema;
