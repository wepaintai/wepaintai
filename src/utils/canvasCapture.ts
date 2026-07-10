export type CanvasCapturePreset = 'thumbnail' | 'processing' | 'export'

export interface CanvasCaptureResult {
  dataUrl: string
  width: number
  height: number
}

interface CapturePresetConfig {
  mimeType: 'image/png' | 'image/jpeg'
  quality?: number
  desiredPixelRatio: number
  maxPixelRatio: number
  maxWidth: number
  maxHeight: number
  maxPixels: number
}

export interface CaptureDimensions {
  pixelRatio: number
  width: number
  height: number
}

const CAPTURE_PRESETS: Record<CanvasCapturePreset, CapturePresetConfig> = {
  thumbnail: {
    mimeType: 'image/jpeg',
    quality: 0.8,
    desiredPixelRatio: 1,
    maxPixelRatio: 1,
    maxWidth: 400,
    maxHeight: 400,
    maxPixels: 400 * 400,
  },
  processing: {
    mimeType: 'image/png',
    desiredPixelRatio: 1,
    maxPixelRatio: 1,
    maxWidth: 2048,
    maxHeight: 2048,
    maxPixels: 2048 * 2048,
  },
  export: {
    mimeType: 'image/png',
    desiredPixelRatio: 1,
    maxPixelRatio: 4,
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixels: 16 * 1024 * 1024,
  },
}

export function getCapturePreset(preset: CanvasCapturePreset): CapturePresetConfig {
  return CAPTURE_PRESETS[preset]
}

export function getRasterExportPixelRatio(scales: readonly number[]): number {
  return scales.reduce((pixelRatio, scale) => {
    const normalizedScale = Math.abs(scale)
    if (!Number.isFinite(normalizedScale) || normalizedScale <= 0) {
      return pixelRatio
    }

    return Math.max(pixelRatio, 1 / normalizedScale)
  }, 1)
}

export function calculateCaptureDimensions({
  width,
  height,
  preset,
  desiredPixelRatio,
}: {
  width: number
  height: number
  preset: CanvasCapturePreset
  desiredPixelRatio?: number
}): CaptureDimensions | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }

  const config = CAPTURE_PRESETS[preset]
  const requestedRatio =
    desiredPixelRatio !== undefined && Number.isFinite(desiredPixelRatio) && desiredPixelRatio > 0
      ? desiredPixelRatio
      : config.desiredPixelRatio
  const pixelRatio = Math.min(
    requestedRatio,
    config.maxPixelRatio,
    config.maxWidth / width,
    config.maxHeight / height,
    Math.sqrt(config.maxPixels / (width * height))
  )

  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    return undefined
  }

  return {
    pixelRatio,
    width: Math.max(1, Math.round(width * pixelRatio)),
    height: Math.max(1, Math.round(height * pixelRatio)),
  }
}
