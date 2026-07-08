/**
 * Extract a user-presentable message from an error thrown by a Convex action.
 * Convex wraps server-side throws as
 * "[Request ID: ...] Server Error Uncaught Error: <message> at handler ...",
 * so strip that framing down to the original message when present.
 */
export function getErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback

  let message = err.message
  const uncaught = message.match(/Uncaught (?:Convex)?Error: (.*)/s)
  if (uncaught) {
    message = uncaught[1]
  } else {
    // Drop Convex's "[CONVEX ...] [Request ID: ...]" framing when present
    message = message.replace(/^(\[[^\]]*\]\s*)+/, '')
  }
  // Drop the stack-ish trailer Convex appends ("... at handler (../convex/foo.ts:1:1)")
  message = message.split(/\n\s*at /)[0].trim()

  // A bare "Server Error" (prod redaction) isn't actionable — use the fallback.
  if (!message || /^server error$/i.test(message)) return fallback
  return message
}
