import type { CaptureResult } from 'posthog-js'

/**
 * Keep collaboration secrets out of analytics.
 *
 * Edit links carry their capability token in the URL fragment
 * (`?session=<id>#edit=<token>`). The fragment never reaches our servers, but
 * PostHog reads `window.location` itself (`$current_url`,
 * `$session_entry_url`, `$initial_current_url`, `$referrer`, ...). The token
 * is scrubbed from the address bar before `posthog.init` (see client.tsx);
 * these helpers are the second layer: every URL-shaped string in an outgoing
 * event loses its fragment and any `edit` query parameter.
 */

const URL_LIKE = /^(https?:\/\/|\/)/i
const MAX_DEPTH = 6

/** Strip the fragment and any `edit` query parameter from a URL string. */
export function sanitizeAnalyticsUrl(value: string): string {
  if (!URL_LIKE.test(value)) return value
  if (!value.includes('#') && !/[?&]edit=/i.test(value)) return value
  const hashIndex = value.indexOf('#')
  let url = hashIndex === -1 ? value : value.slice(0, hashIndex)
  const queryIndex = url.indexOf('?')
  if (queryIndex !== -1) {
    const params = new URLSearchParams(url.slice(queryIndex + 1))
    if (params.has('edit')) {
      params.delete('edit')
      const rest = params.toString()
      url = url.slice(0, queryIndex) + (rest ? `?${rest}` : '')
    }
  }
  return url
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeAnalyticsUrl(value)
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubValue(inner, depth + 1)
  }
  return out
}

/**
 * PostHog `before_send` hook: sanitize every URL-shaped string in the event's
 * properties and person properties (`$set` / `$set_once`, which carry
 * `$initial_current_url` and friends).
 */
export function scrubAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event
  return {
    ...event,
    properties: scrubValue(event.properties, 0) as CaptureResult['properties'],
    ...(event.$set ? { $set: scrubValue(event.$set, 0) as CaptureResult['$set'] } : {}),
    ...(event.$set_once
      ? { $set_once: scrubValue(event.$set_once, 0) as CaptureResult['$set_once'] }
      : {}),
  }
}
