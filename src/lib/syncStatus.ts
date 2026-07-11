import { useSyncExternalStore } from "react";
import type { FunctionArgs } from "convex/server";
import { api } from "../../convex/_generated/api";
import { convexHigh } from "./convex";
import { registerUnsavedWorkCounter } from "./unsavedChanges";

/**
 * Module-level sync failure store shared by every usePaintingSession instance
 * (PaintingView and KonvaCanvas each call the hook) and the SyncStatusBanner.
 *
 * When a mutation fails — most importantly after a Better Auth JWT expires
 * mid-session, which makes the backend throw "Unauthorized" — the failure is
 * reported here instead of vanishing in an unhandled promise rejection. Failed
 * strokes are retained so a successful re-auth can replay them.
 */

export type SyncErrorKind = "auth" | "network" | "unknown";

export interface SyncStatus {
  status: "ok" | "error";
  kind: SyncErrorKind;
  /** Strokes that failed to save and are queued for replay. */
  pendingStrokeCount: number;
  retrying: boolean;
}

type AddStrokeArgs = FunctionArgs<typeof api.strokes.addStroke>;

// Cap the replay queue so a long offline stretch can't grow memory unboundedly.
const MAX_PENDING_STROKES = 100;

let pendingStrokes: AddStrokeArgs[] = [];
let state: SyncStatus = {
  status: "ok",
  kind: "unknown",
  pendingStrokeCount: 0,
  retrying: false,
};

const listeners = new Set<() => void>();

// Strokes queued for replay are unsaved work — closing the tab would lose them.
registerUnsavedWorkCounter(() => pendingStrokes.length);

function setState(partial: Partial<SyncStatus>) {
  state = { ...state, ...partial, pendingStrokeCount: pendingStrokes.length };
  listeners.forEach((l) => l());
}

/**
 * Distinguish auth failures from transient network errors. Backend auth
 * checks throw "Unauthorized" / "Not authenticated"; anything failing while
 * the websocket is down is treated as a network problem.
 */
export function classifySyncError(error: unknown): SyncErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized|unauthenticated|not authenticated|token|jwt/i.test(message)) {
    return "auth";
  }
  try {
    if (!convexHigh.connectionState().isWebSocketConnected) {
      return "network";
    }
  } catch {
    // connectionState is best-effort; fall through to unknown
  }
  return "unknown";
}

/** Record a failed mutation; optionally retain the stroke args for replay. */
export function reportSyncFailure(error: unknown, failedStroke?: AddStrokeArgs) {
  if (failedStroke) {
    pendingStrokes.push(failedStroke);
    if (pendingStrokes.length > MAX_PENDING_STROKES) {
      pendingStrokes = pendingStrokes.slice(-MAX_PENDING_STROKES);
    }
  }
  const kind = classifySyncError(error);
  // Don't let a later vague error mask a known auth failure.
  const nextKind = state.status === "error" && state.kind === "auth" && kind === "unknown" ? "auth" : kind;
  setState({ status: "error", kind: nextKind });
}

/**
 * Record a successful mutation. Clears the error banner and, if strokes are
 * still queued from the outage, kicks off a replay.
 */
export function reportSyncSuccess() {
  if (state.status === "ok" && pendingStrokes.length === 0) return;
  if (pendingStrokes.length > 0) {
    void retrySync();
  } else {
    setState({ status: "ok" });
  }
}

/**
 * Replay queued strokes in order via the singleton Convex client. With an
 * empty queue, probes the backend so "Retry" gives real feedback either way.
 * Returns true when everything went through.
 */
export async function retrySync(): Promise<boolean> {
  if (state.retrying) return false;
  setState({ retrying: true });
  try {
    while (pendingStrokes.length > 0) {
      const stroke = pendingStrokes[0];
      await convexHigh.mutation(api.strokes.addStroke, stroke);
      pendingStrokes.shift();
      setState({});
    }
    if (state.status === "error") {
      // Nothing queued to prove the connection works — probe with a query.
      await convexHigh.query(api.auth.getCurrentUser, {});
    }
    setState({ status: "ok" });
    return true;
  } catch (error) {
    setState({ status: "error", kind: classifySyncError(error) });
    return false;
  } finally {
    setState({ retrying: false });
  }
}

/** Drop queued strokes (e.g. when the user clears the canvas). */
export function discardPendingStrokes() {
  pendingStrokes = [];
  setState({});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SyncStatus {
  return state;
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
