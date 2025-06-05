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

// Clean up old WebRTC signals every minute
crons.interval(
  "cleanup old webrtc signals",
  { minutes: 1 },
  internal.webrtc.cleanupOldSignals,
  {}
);

export default crons;
