import { describe, expect, test } from 'vitest'
import { calculateCaptureDimensions, getRasterExportPixelRatio } from './canvasCapture'

describe('calculateCaptureDimensions', () => {
  test('bounds a landscape thumbnail to 400 pixels wide', () => {
    expect(calculateCaptureDimensions({ width: 1600, height: 900, preset: 'thumbnail' })).toEqual({
      pixelRatio: 0.25,
      width: 400,
      height: 225,
    })
  })

  test('bounds a portrait thumbnail on height as well as width', () => {
    expect(calculateCaptureDimensions({ width: 600, height: 2400, preset: 'thumbnail' })).toEqual({
      pixelRatio: 1 / 6,
      width: 100,
      height: 400,
    })
  })

  test('does not upscale small thumbnails', () => {
    expect(calculateCaptureDimensions({ width: 200, height: 150, preset: 'thumbnail' })).toEqual({
      pixelRatio: 1,
      width: 200,
      height: 150,
    })
  })

  test('caps export resolution even when raster content is heavily downscaled', () => {
    expect(
      calculateCaptureDimensions({
        width: 800,
        height: 600,
        preset: 'export',
        desiredPixelRatio: getRasterExportPixelRatio([0.01]),
      })
    ).toEqual({ pixelRatio: 4, width: 3200, height: 2400 })
  })

  test('constrains large exports by their maximum dimension', () => {
    const result = calculateCaptureDimensions({
      width: 3000,
      height: 2000,
      preset: 'export',
      desiredPixelRatio: 4,
    })

    expect(result?.width).toBe(4096)
    expect(result?.height).toBe(2731)
    expect((result?.width ?? 0) * (result?.height ?? 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
  })

  test('rejects invalid canvas dimensions', () => {
    expect(calculateCaptureDimensions({ width: 0, height: 600, preset: 'export' })).toBeUndefined()
    expect(
      calculateCaptureDimensions({ width: Number.NaN, height: 600, preset: 'export' })
    ).toBeUndefined()
  })
})

describe('getRasterExportPixelRatio', () => {
  test('uses both scale axes while ignoring invalid transforms', () => {
    expect(getRasterExportPixelRatio([2, 0.25, 0, Number.NaN, -0.5])).toBe(4)
  })
})
