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

export default crons;
