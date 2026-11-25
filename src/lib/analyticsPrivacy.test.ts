import { describe, expect, test } from 'vitest'
import type { CaptureResult } from 'posthog-js'
import { sanitizeAnalyticsUrl, scrubAnalyticsEvent } from './analyticsPrivacy'

const TOKEN = 'a'.repeat(48)
const EDIT_URL = `https://wepaint.ai/?session=abc#edit=${TOKEN}`

describe('sanitizeAnalyticsUrl', () => {
  test('drops the fragment and any edit query parameter', () => {
    expect(sanitizeAnalyticsUrl(EDIT_URL)).toBe('https://wepaint.ai/?session=abc')
    expect(sanitizeAnalyticsUrl(`https://wepaint.ai/?session=abc&edit=${TOKEN}`)).toBe(
      'https://wepaint.ai/?session=abc',
    )
    expect(sanitizeAnalyticsUrl(`https://wepaint.ai/?edit=${TOKEN}#x`)).toBe('https://wepaint.ai/')
    expect(sanitizeAnalyticsUrl(`/?session=abc#foo=1&edit=${TOKEN}`)).toBe('/?session=abc')
  })

  test('leaves non-URL strings (colors, names) and clean URLs untouched', () => {
    expect(sanitizeAnalyticsUrl('#ff0000')).toBe('#ff0000')
    expect(sanitizeAnalyticsUrl('edit=thing')).toBe('edit=thing')
    expect(sanitizeAnalyticsUrl('https://wepaint.ai/?session=abc')).toBe(
      'https://wepaint.ai/?session=abc',
    )
  })
})

describe('scrubAnalyticsEvent', () => {
  test('strips the token from properties, $set and $set_once (including nested values)', () => {
    const event = {
      uuid: 'u',
      event: '$pageview',
      properties: {
        $current_url: EDIT_URL,
        $session_entry_url: EDIT_URL,
        $referrer: EDIT_URL,
        $initial_person_info: { u: EDIT_URL, r: '$direct' },
        brushColor: '#00ff00',
        list: [EDIT_URL],
      },
      $set: { $current_url: EDIT_URL },
      $set_once: { $initial_current_url: EDIT_URL },
    } as unknown as CaptureResult

    const scrubbed = scrubAnalyticsEvent(event)
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN)
    expect(JSON.stringify(scrubbed)).not.toContain('edit=')
    expect(scrubbed?.properties.$current_url).toBe('https://wepaint.ai/?session=abc')
    expect(scrubbed?.properties.brushColor).toBe('#00ff00')
    expect(scrubbed?.$set_once?.$initial_current_url).toBe('https://wepaint.ai/?session=abc')
  })

  test('passes null through', () => {
    expect(scrubAnalyticsEvent(null)).toBeNull()
  })
})
