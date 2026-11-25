/**
 * Shared Replicate prediction helpers for the AI actions (no Convex functions
 * here). Encodes the billing-relevant distinction between a request the
 * provider never accepted (refundable) and one it accepted (billed).
 */

const REPLICATE_API = "https://api.replicate.com/v1/predictions";

export type CreatePredictionResult =
  | { kind: "accepted"; id: string }
  // The provider never accepted the request: HTTP error (4xx validation,
  // 5xx), malformed response without a prediction id, or a network error.
  | { kind: "rejected"; httpStatus?: number; message: string };

export type PollPredictionResult =
  | { kind: "succeeded"; output: unknown }
  | { kind: "failed"; error: string }
  // Deadline reached while the prediction was still running, or the status
  // endpoint kept failing until the deadline / returned a non-retryable error.
  | { kind: "timeout" }
  | { kind: "poll_error"; message: string };

export function replicateTimeoutMs(): number {
  const parsed = parseInt(process.env.REPLICATE_TIMEOUT_SECONDS || "180", 10);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 180) * 1000;
}

function pollIntervalMs(): number {
  const parsed = parseInt(process.env.REPLICATE_POLL_INTERVAL_MS || "1000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createPrediction(
  token: string,
  body: unknown,
): Promise<CreatePredictionResult> {
  let response: Response;
  try {
    response = await fetch(REPLICATE_API, {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      kind: "rejected",
      message: error instanceof Error ? error.message : "Network error",
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { kind: "rejected", httpStatus: response.status, message: text.slice(0, 500) };
  }

  try {
    const prediction = (await response.json()) as { id?: unknown };
    if (typeof prediction?.id === "string" && prediction.id.length > 0) {
      return { kind: "accepted", id: prediction.id };
    }
  } catch {
    // fall through
  }
  return { kind: "rejected", httpStatus: response.status, message: "Missing prediction id" };
}

function isRetryablePollStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Poll a prediction until it reaches a terminal status or the wall-clock
 * deadline passes. Transient status-check failures (network errors, 408/429,
 * 5xx) are retried with exponential backoff instead of failing the operation.
 */
export async function pollPrediction(
  token: string,
  predictionId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PollPredictionResult> {
  const timeoutMs = opts.timeoutMs ?? replicateTimeoutMs();
  const intervalMs = opts.intervalMs ?? pollIntervalMs();
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${REPLICATE_API}/${encodeURIComponent(predictionId)}`, {
        headers: { Authorization: `Token ${token}` },
      });
      if (response.ok) {
        const status = (await response.json()) as {
          status?: string;
          output?: unknown;
          error?: unknown;
        };
        consecutiveErrors = 0;
        if (status.status === "succeeded") {
          return { kind: "succeeded", output: status.output };
        }
        if (status.status === "failed" || status.status === "canceled") {
          const error =
            typeof status.error === "string" && status.error
              ? status.error
              : status.status === "canceled"
                ? "Prediction was canceled"
                : "Prediction failed";
          return { kind: "failed", error };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(intervalMs, remaining));
        continue;
      }
      if (!isRetryablePollStatus(response.status)) {
        const text = await response.text().catch(() => "");
        return {
          kind: "poll_error",
          message: `Status check failed (${response.status}) ${text.slice(0, 200)}`.trim(),
        };
      }
    } catch {
      // Network error or malformed JSON: transient, retry with backoff.
    }

    consecutiveErrors += 1;
    const backoff = Math.min(intervalMs * 2 ** Math.min(consecutiveErrors, 6), 10_000);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(backoff, remaining));
  }

  return { kind: "timeout" };
}

/** Best-effort cancellation so a timed-out prediction stops accruing cost. */
export async function cancelPrediction(token: string, predictionId: string): Promise<void> {
  try {
    await fetch(`${REPLICATE_API}/${encodeURIComponent(predictionId)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Token ${token}` },
    });
  } catch (error) {
    console.warn("[replicate] Failed to cancel prediction", predictionId, error);
  }
}

/**
 * Normalize a prediction output into a URL. Handles Replicate's occasional
 * character-array output (`["h","t","t","p",...]`). Returns null when no
 * usable URL is present.
 */
export function extractOutputUrl(output: unknown): string | null {
  let url: unknown;
  if (Array.isArray(output)) {
    if (
      output.length > 10 &&
      output.every((item) => typeof item === "string" && item.length === 1)
    ) {
      url = output.join("");
    } else {
      url = output[0];
    }
  } else if (typeof output === "string") {
    url = output;
  } else if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    url = obj.url ?? obj.image ?? obj[0];
  }
  if (typeof url !== "string" || url.length <= 1 || !/^https?:\/\//i.test(url)) {
    return null;
  }
  return url;
}

export const BILLED_FAILURE_NOTE =
  "The provider had already started processing this request, so the token was not refunded.";
export const REFUNDED_FAILURE_NOTE = "Your token was refunded.";

export function isModerationError(message: string): boolean {
  return /E005|flagged|moderation|sensitive/i.test(message);
}
