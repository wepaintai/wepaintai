/**
 * beforeunload guard that warns only while stroke data could still be lost:
 * a stroke mid-draw, a stroke mutation in flight, or failed strokes queued
 * for replay (see syncStatus). A fully synced canvas closes freely.
 */

type Counter = () => number;

let inFlightStrokes = 0;
const counters = new Set<Counter>();

export function beginInFlightStroke() {
  inFlightStrokes++;
}

export function endInFlightStroke() {
  if (inFlightStrokes > 0) inFlightStrokes--;
}

/** Register an extra unsaved-work counter; returns an unregister function. */
export function registerUnsavedWorkCounter(counter: Counter) {
  counters.add(counter);
  return () => {
    counters.delete(counter);
  };
}

function hasUnsavedWork(): boolean {
  if (inFlightStrokes > 0) return true;
  for (const counter of counters) {
    if (counter() > 0) return true;
  }
  return false;
}

let installed = false;
let suppressed = false;

/**
 * Skip the "Leave site?" prompt for an intentional navigation that doesn't
 * lose work — e.g. the sign-in redirect, where queued strokes are persisted
 * to localStorage and replayed after the round-trip.
 */
export function suppressUnloadGuard() {
  suppressed = true;
}

/** Re-enable the prompt (e.g. when the sign-in redirect fails). */
export function resumeUnloadGuard() {
  suppressed = false;
}

/** Idempotent; safe to call from any component effect (client only). */
export function installUnloadGuard() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("beforeunload", (e) => {
    if (suppressed || !hasUnsavedWork()) return;
    e.preventDefault();
    // Required by some browsers to actually show the prompt
    e.returnValue = "";
  });
}
