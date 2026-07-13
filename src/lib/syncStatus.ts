import { useSyncExternalStore } from "react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
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
 *
 * The queue is written through to localStorage so it survives the full-page
 * OAuth redirect that "Sign in again" performs (and accidental reloads).
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
type StrokeId = FunctionReturnType<typeof api.strokes.addStroke>;

interface PendingStroke {
  args: AddStrokeArgs;
  /**
   * Resolves with the backend stroke id once the stroke is replayed (so the
   * canvas can reconcile its optimistic copy), or with undefined if the
   * stroke is dropped/discarded. Absent for strokes rehydrated after a page
   * load — the optimistic canvas state is gone by then anyway.
   */
  resolve?: (id: StrokeId | undefined) => void;
}

// Cap the replay queue so a long offline stretch can't grow memory unboundedly.
const MAX_PENDING_STROKES = 100;
// Drop a queued stroke after this many replay failures that aren't explained
// by an auth/network outage — it's a poison pill (e.g. deleted layerId) that
// would otherwise jam the queue forever.
const MAX_POISON_RETRIES = 3;
const STORAGE_KEY = "wepaintai:pendingStrokes:v1";
// Rehydrated queues older than this are stale enough to discard.
const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let pendingStrokes: PendingStroke[] = [];
let state: SyncStatus = {
  status: "ok",
  kind: "unknown",
  pendingStrokeCount: 0,
  retrying: false,
};
// Consecutive unexplained replay failures for the current queue head.
let headFailureCount = 0;

const listeners = new Set<() => void>();

// Strokes queued for replay are unsaved work — closing the tab would lose
// them (they're persisted, but only replayed if the user comes back).
registerUnsavedWorkCounter(() => pendingStrokes.length);

function setState(partial: Partial<SyncStatus>) {
  state = { ...state, ...partial, pendingStrokeCount: pendingStrokes.length };
  listeners.forEach((l) => l());
}

/** Write-through persistence so the queue survives redirects and reloads. */
function persistQueue() {
  if (typeof window === "undefined") return;
  try {
    if (pendingStrokes.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          kind: state.kind,
          strokes: pendingStrokes.map((p) => p.args),
        })
      );
    }
  } catch {
    // Quota exceeded / private mode — the in-memory queue still works.
  }
}

/** Restore a queue persisted before a sign-in redirect or reload. */
function rehydrateQueue() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      savedAt?: number;
      kind?: SyncErrorKind;
      strokes?: AddStrokeArgs[];
    };
    if (
      !Array.isArray(parsed.strokes) ||
      parsed.strokes.length === 0 ||
      (typeof parsed.savedAt === "number" &&
        Date.now() - parsed.savedAt > STORAGE_MAX_AGE_MS)
    ) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    pendingStrokes = parsed.strokes.slice(-MAX_PENDING_STROKES).map((args) => ({ args }));
    // Surface the banner so the user sees the queue; replay kicks off once
    // auth comes back (SyncStatusBanner effect) or any mutation succeeds.
    // Applied async so the first hydration render still matches the server
    // HTML (which never shows the banner).
    const kind = parsed.kind === "auth" || parsed.kind === "network" ? parsed.kind : "unknown";
    setTimeout(() => {
      if (pendingStrokes.length > 0 && state.status === "ok") {
        setState({ status: "error", kind });
        // Kick a replay immediately: guests (and already-valid sessions)
        // recover silently; if auth isn't ready yet this fails and the
        // SyncStatusBanner effect retries once Convex authenticates.
        void retrySync();
      }
    }, 0);
  } catch {
    // Corrupt entry — drop it rather than fail on every load.
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
rehydrateQueue();

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

/**
 * Errors that will fail identically on every replay (bad arguments, e.g. a
 * layerId that no longer validates) — retrying them is pointless.
 */
function isNonRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ArgumentValidationError|Validation failed/i.test(message);
}

/** True while failed strokes are queued for replay. */
export function hasPendingStrokes(): boolean {
  return pendingStrokes.length > 0;
}

/**
 * Queue a stroke for replay. Returns a promise that resolves with the backend
 * stroke id once the stroke is successfully replayed, or undefined if it is
 * dropped (poison pill, queue overflow, or discard).
 */
export function enqueueStroke(args: AddStrokeArgs): Promise<StrokeId | undefined> {
  return new Promise((resolve) => {
    pendingStrokes.push({ args, resolve });
    if (pendingStrokes.length > MAX_PENDING_STROKES) {
      const dropped = pendingStrokes.splice(0, pendingStrokes.length - MAX_PENDING_STROKES);
      headFailureCount = 0;
      dropped.forEach((d) => d.resolve?.(undefined));
    }
    persistQueue();
    setState({});
  });
}

/**
 * Record a failed mutation; optionally retain the stroke args for replay.
 * When a stroke is provided, returns a promise that resolves with its backend
 * id after replay (or undefined if the stroke is eventually dropped).
 */
export function reportSyncFailure(
  error: unknown,
  failedStroke?: AddStrokeArgs
): Promise<StrokeId | undefined> | undefined {
  const kind = classifySyncError(error);
  // Don't let a later vaguer error (e.g. a presence network blip) mask a
  // known auth failure — only a fresh auth classification keeps kind "auth".
  const nextKind = state.status === "error" && state.kind === "auth" ? "auth" : kind;
  // Set the kind before enqueueing so persistQueue stores the right one.
  setState({ status: "error", kind: nextKind });
  return failedStroke ? enqueueStroke(failedStroke) : undefined;
}

/**
 * Record a successful mutation. Clears the error banner and, if strokes are
 * still queued from the outage, kicks off a replay.
 *
 * `source` matters for auth errors: updatePresence has no auth check, so its
 * 20s heartbeat succeeding proves nothing about an expired JWT — presence
 * successes must not clear an auth-kind error (or the banner would falsely
 * clear within ~20s while stroke saving is still broken).
 */
export function reportSyncSuccess(source: "stroke" | "presence" = "stroke") {
  if (state.status === "ok" && pendingStrokes.length === 0) return;
  if (source === "presence" && state.status === "error" && state.kind === "auth") return;
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
  let replayedAny = false;
  try {
    while (pendingStrokes.length > 0) {
      const entry = pendingStrokes[0];
      // Remove by identity, not shift(): a concurrent enqueueStroke overflow
      // can splice the head while its mutation is in flight, and a blind
      // shift() would then silently drop a different stroke.
      const removeEntry = () => {
        const idx = pendingStrokes.indexOf(entry);
        if (idx !== -1) pendingStrokes.splice(idx, 1);
        headFailureCount = 0;
        persistQueue();
      };
      try {
        const strokeId = await convexHigh.mutation(api.strokes.addStroke, entry.args);
        removeEntry();
        replayedAny = true;
        entry.resolve?.(strokeId);
        setState({});
      } catch (error) {
        const kind = classifySyncError(error);
        const poison =
          isNonRetryableError(error) ||
          (kind === "unknown" && ++headFailureCount >= MAX_POISON_RETRIES);
        if (poison) {
          // Drop it so one permanently-failing stroke can't jam the queue —
          // every later stroke would otherwise be stuck behind it forever.
          console.error("[syncStatus] Dropping unreplayable stroke:", error);
          removeEntry();
          entry.resolve?.(undefined);
          setState({});
          continue;
        }
        // Auth/network outage (or a transient unknown): keep the stroke and
        // stop — later strokes must wait so ordering is preserved. A known
        // auth failure isn't downgraded by a vaguer replay error.
        setState({
          status: "error",
          kind: state.status === "error" && state.kind === "auth" ? "auth" : kind,
        });
        persistQueue(); // write the refined kind through for rehydration
        return false;
      }
    }
    if (state.status === "error" && !replayedAny) {
      // Nothing queued to prove the connection works — probe with a query.
      // getCurrentUser returns null (rather than throwing) when the JWT is
      // invalid, so for auth errors a null result means still broken.
      const user = await convexHigh.query(api.auth.getCurrentUser, {});
      if (state.kind === "auth" && user === null) {
        return false;
      }
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

/**
 * Drop queued strokes (e.g. when the user clears the canvas, so a later
 * replay doesn't resurrect strokes onto the freshly cleared session). With a
 * sessionId, only that session's strokes are dropped.
 */
export function discardPendingStrokes(sessionId?: string) {
  const kept: PendingStroke[] = [];
  for (const entry of pendingStrokes) {
    if (sessionId && entry.args.sessionId !== sessionId) {
      kept.push(entry);
    } else {
      entry.resolve?.(undefined);
    }
  }
  pendingStrokes = kept;
  headFailureCount = 0;
  persistQueue();
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
