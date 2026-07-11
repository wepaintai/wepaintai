import { useCallback, useEffect, useRef } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import type { CanvasRef } from '../components/KonvaCanvas'
import { getGuestKey } from '../utils/guestKey'

interface UseThumbnailGeneratorOptions {
  sessionId?: Id<'paintingSessions'>
  canvasRef: React.RefObject<CanvasRef | null>
  interval?: number
  enabled?: boolean
}

async function isAllWhiteThumbnail(dataUrl: string): Promise<boolean> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Failed to decode canvas thumbnail'))
    image.src = dataUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) return false

  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] !== 255 || pixels[index + 1] !== 255 || pixels[index + 2] !== 255) {
      return false
    }
  }

  return true
}

export function useThumbnailGenerator({
  sessionId,
  canvasRef,
  interval = 30000,
  enabled = true,
}: UseThumbnailGeneratorOptions) {
  const updateThumbnail = useMutation(api.paintingSessions.updateSessionThumbnail)
  const lastThumbnailRef = useRef('')
  const inFlightRef = useRef<Promise<void> | null>(null)
  const pendingSkipBlankRef = useRef<boolean | null>(null)
  const activeSessionRef = useRef(sessionId)

  useEffect(() => {
    activeSessionRef.current = sessionId
    lastThumbnailRef.current = ''
    inFlightRef.current = null
    pendingSkipBlankRef.current = null
  }, [sessionId])

  const generateThumbnail = useCallback(
    async (skipBlank: boolean) => {
      if (!sessionId || !canvasRef.current) return
      if (inFlightRef.current) {
        pendingSkipBlankRef.current =
          pendingSkipBlankRef.current === null
            ? skipBlank
            : pendingSkipBlankRef.current && skipBlank
        return inFlightRef.current
      }

      const targetSessionId = sessionId
      pendingSkipBlankRef.current = null
      let task: Promise<void>
      task = Promise.resolve().then(async () => {
        let nextSkipBlank = skipBlank

        try {
          while (activeSessionRef.current === targetSessionId) {
            try {
              const capture = canvasRef.current?.captureContent('thumbnail')
              if (capture && capture.dataUrl !== lastThumbnailRef.current) {
                const shouldSkip = nextSkipBlank && (await isAllWhiteThumbnail(capture.dataUrl))
                if (!shouldSkip && activeSessionRef.current === targetSessionId) {
                  await updateThumbnail({
                    sessionId: targetSessionId,
                    thumbnailUrl: capture.dataUrl,
                    guestKey: getGuestKey(targetSessionId) || undefined,
                  })

                  if (activeSessionRef.current === targetSessionId) {
                    lastThumbnailRef.current = capture.dataUrl
                  }
                }
              }
            } catch (error) {
              console.error('[ThumbnailGenerator] Error generating thumbnail:', error)
            }

            if (activeSessionRef.current !== targetSessionId) return

            const pendingSkipBlank = pendingSkipBlankRef.current
            if (pendingSkipBlank === null) return
            pendingSkipBlankRef.current = null
            nextSkipBlank = pendingSkipBlank
          }
        } finally {
          if (inFlightRef.current === task) {
            inFlightRef.current = null
          }
        }
      })

      inFlightRef.current = task
      await task
    },
    [canvasRef, sessionId, updateThumbnail]
  )

  useEffect(() => {
    if (!enabled || !sessionId) return

    const initialTimer = window.setTimeout(() => {
      void generateThumbnail(true)
    }, 3000)
    const intervalTimer = window.setInterval(() => {
      void generateThumbnail(true)
    }, interval)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalTimer)
    }
  }, [enabled, generateThumbnail, interval, sessionId])

  const generateNow = useCallback(() => generateThumbnail(false), [generateThumbnail])

  return { generateNow }
}
