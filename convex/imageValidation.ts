export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MiB
export const MAX_IMAGE_DIMENSION = 4096
export const MAX_AI_IMAGE_DIMENSION = 8192
export const MAX_FILENAME_LENGTH = 255
export const UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000 // 10 minutes

// Upload-intent rate limits, per bucket (signed-in user, guest owner of a
// session, or anonymous editors of a public session).
export const UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1000 // 1 hour
export const MAX_OPEN_UPLOAD_INTENTS = 10 // unexpired and not yet committed
export const MAX_UPLOAD_INTENTS_PER_WINDOW = 60

// Hosts an AI image URL may point at besides this deployment's own storage.
// All current AI flows store their output in Convex storage first; the
// provider CDN is kept for robustness. PR #106 replaces URL insertion with a
// storageId binding entirely.
export const AI_IMAGE_PROVIDER_HOSTS: readonly string[] = ['replicate.delivery']

export type AllowedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface DecodedImageInfo {
  mimeType: AllowedImageMimeType
  width: number
  height: number
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  )
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function parsePng(bytes: Uint8Array): DecodedImageInfo | null {
  if (bytes.length < 24) return null
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return null
  }
  if (!matchesAscii(bytes, 12, 'IHDR')) return null
  const width = readUint32BE(bytes, 16)
  const height = readUint32BE(bytes, 20)
  if (width <= 0 || height <= 0) return null
  return { mimeType: 'image/png', width, height }
}

function parseGif(bytes: Uint8Array): DecodedImageInfo | null {
  if (bytes.length < 10) return null
  if (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a')) return null
  const width = readUint16LE(bytes, 6)
  const height = readUint16LE(bytes, 8)
  if (width <= 0 || height <= 0) return null
  return { mimeType: 'image/gif', width, height }
}

function parseWebp(bytes: Uint8Array): DecodedImageInfo | null {
  if (bytes.length < 30) return null
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) return null

  if (matchesAscii(bytes, 12, 'VP8X')) {
    const width = readUint24LE(bytes, 24) + 1
    const height = readUint24LE(bytes, 27) + 1
    return width > 0 && height > 0 ? { mimeType: 'image/webp', width, height } : null
  }

  if (matchesAscii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | ((bytes[24] << 24) >>> 0)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return width > 0 && height > 0 ? { mimeType: 'image/webp', width, height } : null
  }

  if (matchesAscii(bytes, 12, 'VP8 ')) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = readUint16LE(bytes, 26) & 0x3fff
    const height = readUint16LE(bytes, 28) & 0x3fff
    return width > 0 && height > 0 ? { mimeType: 'image/webp', width, height } : null
  }

  return null
}

function parseJpeg(bytes: Uint8Array): DecodedImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2

  while (offset + 1 < bytes.length) {
    // Skip any padding 0xFF bytes before marker
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset++
    }
    if (offset >= bytes.length) return null
    const marker = bytes[offset++]

    // Standalone markers with no length field (RST0-RST7, SOI, EOI, TEM)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    // End of image / start of scan without seeing SOF
    if (marker === 0xd9 || marker === 0xda) {
      return null
    }

    if (offset + 1 >= bytes.length) return null
    const segmentLength = readUint16BE(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null

    const isSofMarker =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)

    if (isSofMarker) {
      if (segmentLength < 7 || offset + 7 > bytes.length) return null
      const height = readUint16BE(bytes, offset + 3)
      const width = readUint16BE(bytes, offset + 5)
      if (width <= 0 || height <= 0) return null
      return { mimeType: 'image/jpeg', width, height }
    }

    offset += segmentLength
  }

  return null
}

/**
 * Inspect raw binary headers to verify the payload is a genuine PNG, JPEG, GIF,
 * or WebP image and decode its true dimensions server-side.
 */
export function inspectImageBytes(bytes: Uint8Array): DecodedImageInfo | null {
  return parsePng(bytes) ?? parseJpeg(bytes) ?? parseGif(bytes) ?? parseWebp(bytes)
}

export function assertValidImageDimensions(
  width: number,
  height: number,
  maxDimension: number = MAX_IMAGE_DIMENSION
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > maxDimension ||
    height > maxDimension
  ) {
    throw new Error(`Image dimensions must be between 1 and ${maxDimension}px`)
  }
  return { width: Math.round(width), height: Math.round(height) }
}

export function assertFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[/\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, MAX_FILENAME_LENGTH)
  return cleaned || 'image'
}

function originOf(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * Accept an AI image URL only when it points at this deployment's file storage
 * (`<CONVEX_CLOUD_URL or CONVEX_SITE_URL>/api/storage/...`, any scheme that
 * origin uses, so a local http backend works) or at a known provider CDN over
 * HTTPS. Everything else, including arbitrary HTTPS hosts that could be used
 * for tracking pixels or unmoderated content, is rejected.
 */
export function assertAllowedAiImageUrl(
  url: string,
  storageOrigins: ReadonlyArray<string | undefined>,
): string {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error('Invalid image URL')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Invalid image URL')
  }

  const allowedOrigins = new Set(
    storageOrigins.map(originOf).filter((origin): origin is string => origin !== null),
  )
  if (allowedOrigins.has(parsed.origin) && parsed.pathname.startsWith('/api/storage/')) {
    return parsed.href
  }

  if (parsed.protocol === 'https:' && parsed.port === '') {
    const host = parsed.hostname.toLowerCase()
    if (AI_IMAGE_PROVIDER_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return parsed.href
    }
  }

  throw new Error("Image URL must be an HTTPS URL from this app's image storage")
}

/** Canvas size hints from the client: finite, positive, and bounded. */
export function sanitizeCanvasDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(value, MAX_AI_IMAGE_DIMENSION)
}
