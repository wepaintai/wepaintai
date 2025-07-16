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
    thumbnailUrl: v.optional(v.string()), // Thumbnail for library view
    lastModified: v.optional(v.number()), // Last modification timestamp
    // Undo/redo optimization: track last few stroke orders for quick access
    recentStrokeOrders: v.optional(v.array(v.number())), // Last 10 stroke orders for quick undo
    recentStrokeIds: v.optional(v.array(v.id("strokes"))), // Last 10 stroke IDs for instant undo
    deletedStrokeCount: v.optional(v.number()), // Count of deleted strokes for quick redo check
    lastDeletedStrokeOrder: v.optional(v.number()), // Order of the last deleted stroke for quick redo
    // AI generation prompts history
    aiPrompts: v.optional(v.array(v.string())), // Array of unique prompts used in this session
  }),

  strokes: defineTable({
    sessionId: v.id("paintingSessions"),
    layerId: v.optional(v.id("paintLayers")), // Reference to paint layer (optional for backward compatibility)
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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))), // Color mode for special effects
  }).index("by_session", ["sessionId", "strokeOrder"])
    .index("by_layer", ["sessionId", "layerId", "strokeOrder"]),

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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))), // Color mode for special effects
    lastUpdated: v.number(),
  }).index("by_session", ["sessionId"])
    .index("by_user_session", ["userId", "sessionId"]),

  users: defineTable({
    // Clerk integration fields
    clerkId: v.optional(v.string()), // Clerk user ID (subject)
    
    // User profile fields
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    
    // Token system
    tokens: v.optional(v.number()), // Current token balance
    lifetimeTokensUsed: v.optional(v.number()), // Total tokens ever used
    
    // Timestamps
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("by_clerk_id", ["clerkId"]),

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
    layerId: v.optional(v.id("paintLayers")), // Reference to paint layer
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
    colorMode: v.optional(v.union(v.literal("solid"), v.literal("rainbow"))), // Color mode for special effects
    deletedAt: v.number(),
  }).index("by_session_deleted", ["sessionId", "deletedAt"])
    .index("by_session_stroke", ["sessionId", "strokeOrder"]),

  // Paint layers for multi-layer painting support
  paintLayers: defineTable({
    sessionId: v.id("paintingSessions"),
    name: v.string(),
    layerOrder: v.number(),
    visible: v.boolean(),
    opacity: v.number(),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_session", ["sessionId", "layerOrder"]),

  // Token transactions
  tokenTransactions: defineTable({
    userId: v.id("users"),
    type: v.union(v.literal("initial"), v.literal("purchase"), v.literal("usage"), v.literal("refund")),
    amount: v.number(), // Positive for credits, negative for usage
    balance: v.number(), // Balance after transaction
    description: v.string(),
    metadata: v.optional(v.object({
      polarCheckoutId: v.optional(v.string()),
      polarProductId: v.optional(v.string()),
      aiGenerationId: v.optional(v.id("aiGenerations")),
      sessionId: v.optional(v.string()),
      targetLayerId: v.optional(v.string()),
    })),
    createdAt: v.number(),
  }).index("by_user", ["userId", "createdAt"]),

  // Polar purchase records
  polarPurchases: defineTable({
    userId: v.id("users"),
    checkoutId: v.string(),
    productId: v.string(),
    productName: v.string(),
    amount: v.number(), // Amount in cents
    currency: v.string(),
    tokens: v.number(), // Number of tokens purchased
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_user", ["userId"])
    .index("by_checkout", ["checkoutId"]),

  // User-level AI prompts history
  userPrompts: defineTable({
    userId: v.id("users"),
    prompt: v.string(),
    usageCount: v.number(), // How many times this prompt was used
    lastUsed: v.number(), // Timestamp of last use
    createdAt: v.number(), // When first used
  }).index("by_user", ["userId", "lastUsed"])
    .index("by_user_prompt", ["userId", "prompt"]),
});

export default schema;
