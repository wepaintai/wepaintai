import { describe, expect, it } from 'vitest'
import { getImageUploadEndpoint } from './imageUpload'

describe('getImageUploadEndpoint', () => {
  it('uses the Convex site origin for the upload HTTP action', () => {
    expect(getImageUploadEndpoint({ VITE_CONVEX_SITE_URL: 'https://site.wepaint.ai/' })).toBe(
      'https://site.wepaint.ai/uploads/image',
    )
    expect(getImageUploadEndpoint({ VITE_CONVEX_SITE_URL: 'http://127.0.0.1:3211' })).toBe(
      'http://127.0.0.1:3211/uploads/image',
    )
  })

  it('derives the .convex.site origin from a Convex Cloud URL when unset', () => {
    expect(getImageUploadEndpoint({ VITE_CONVEX_URL: 'https://happy-otter-123.convex.cloud' })).toBe(
      'https://happy-otter-123.convex.site/uploads/image',
    )
  })

  it('returns null rather than guessing for self-hosted backends without a site URL', () => {
    expect(getImageUploadEndpoint({ VITE_CONVEX_URL: 'https://api.wepaint.ai' })).toBeNull()
    expect(getImageUploadEndpoint({})).toBeNull()
  })
})
