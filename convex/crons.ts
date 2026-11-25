import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Clean up stale live strokes every 30 seconds
crons.interval(
  "cleanup stale live strokes",
  { seconds: 30 },
  internal.liveStrokes.cleanupStaleLiveStrokes,
  {}
);

/* Clean up old WebRTC signals every minute */
crons.interval(
  "cleanup old webrtc signals",
  { minutes: 1 },
  internal.webrtc.cleanupOldSignals,
  {}
);

// Clean up old presence records periodically to expire stale users
crons.interval(
  "cleanup old presence",
  { minutes: 5 },
  internal.presence.cleanupOldPresenceInternal,
  {}
);

// Hard-delete soft-deleted sessions after their restore grace window
crons.interval(
  "purge deleted sessions",
  { hours: 6 },
  internal.paintingSessions.purgeDeletedSessions,
  {}
);

// Settle Polar purchases stuck in pending (e.g. a lost webhook delivery)
crons.interval(
  "reconcile pending polar purchases",
  { minutes: 15 },
  internal.polarReconcile.reconcilePendingPurchases,
  {}
);

// Clean up expired single-use image upload intents and abandoned uploads
crons.interval(
  "cleanup expired upload intents",
  { minutes: 15 },
  internal.images.cleanupExpiredUploadIntents,
  {}
);

export default crons;
