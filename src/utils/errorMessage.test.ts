import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import { getErrorMessage } from './errorMessage'

describe('getErrorMessage', () => {
  test('prefers ConvexError data, which survives production redaction', () => {
    const err = new ConvexError('Insufficient tokens. Background removal costs 1 token.')
    err.message = '[CONVEX A(backgroundRemoval:removeBackground)] Server Error'
    expect(getErrorMessage(err, 'fallback')).toBe(
      'Insufficient tokens. Background removal costs 1 token.'
    )
  })

  test('unwraps dev-mode framing and falls back on a redacted plain error', () => {
    expect(
      getErrorMessage(new Error('[Request ID: 1] Server Error Uncaught Error: Boom\n  at handler'), 'x')
    ).toBe('Boom')
    expect(getErrorMessage(new Error('[CONVEX A(x)] Server Error'), 'fallback')).toBe('fallback')
  })
})
