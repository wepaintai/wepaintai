import { useEffect, useRef } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import type { CanvasRef } from '../components/Canvas'

interface UseThumbnailGeneratorOptions {
  sessionId?: Id<"paintingSessions">
  canvasRef: React.RefObject<CanvasRef>
  interval?: number // Default: 30 seconds
  enabled?: boolean
}

export function useThumbnailGenerator({
  sessionId,
  canvasRef,
  interval = 30000, // 30 seconds default
  enabled = true
}: UseThumbnailGeneratorOptions) {
  const updateThumbnail = useMutation(api.paintingSessions.updateSessionThumbnail)
  const lastThumbnailRef = useRef<string>('')
  const intervalRef = useRef<NodeJS.Timeout>()

  useEffect(() => {
    if (!enabled || !sessionId || !canvasRef.current) {
      return
    }

    const generateThumbnail = async () => {
      try {
        // Get the canvas image data
        const imageData = canvasRef.current?.getImageData?.()
        if (!imageData) return

        // Check if the image has changed
        if (imageData === lastThumbnailRef.current) {
          return // No changes, skip update
        }

        // Create a smaller thumbnail (max 400px wide)
        const img = new Image()
        img.onload = async () => {
          const maxWidth = 400
          const scale = Math.min(1, maxWidth / img.width)
          const width = img.width * scale
          const height = img.height * scale

          // Create a small canvas for the thumbnail
          const thumbnailCanvas = document.createElement('canvas')
          thumbnailCanvas.width = width
          thumbnailCanvas.height = height
          const ctx = thumbnailCanvas.getContext('2d')
          
          if (ctx) {
            // Draw white background
            ctx.fillStyle = 'white'
            ctx.fillRect(0, 0, width, height)
            
            // Draw the image
            ctx.drawImage(img, 0, 0, width, height)
            
            // Get the thumbnail data URL (JPEG for smaller size)
            const thumbnailData = thumbnailCanvas.toDataURL('image/jpeg', 0.8)
            
            // Update only if changed
            if (thumbnailData !== lastThumbnailRef.current) {
              lastThumbnailRef.current = thumbnailData
              
              // Update the thumbnail in the database
              await updateThumbnail({
                sessionId,
                thumbnailUrl: thumbnailData
              })
            }
          }
        }
        img.src = imageData
      } catch (error) {
        console.error('[ThumbnailGenerator] Error generating thumbnail:', error)
      }
    }

    // Generate initial thumbnail
    generateThumbnail()

    // Set up interval for periodic updates
    intervalRef.current = setInterval(generateThumbnail, interval)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [sessionId, canvasRef, interval, enabled, updateThumbnail])

  // Manual trigger for thumbnail generation (e.g., on significant changes)
  const generateNow = async () => {
    if (!sessionId || !canvasRef.current) return

    try {
      const imageData = canvasRef.current?.getImageData?.()
      if (!imageData) return

      // Same thumbnail generation logic as above
      const img = new Image()
      img.onload = async () => {
        const maxWidth = 400
        const scale = Math.min(1, maxWidth / img.width)
        const width = img.width * scale
        const height = img.height * scale

        const thumbnailCanvas = document.createElement('canvas')
        thumbnailCanvas.width = width
        thumbnailCanvas.height = height
        const ctx = thumbnailCanvas.getContext('2d')
        
        if (ctx) {
          ctx.fillStyle = 'white'
          ctx.fillRect(0, 0, width, height)
          ctx.drawImage(img, 0, 0, width, height)
          
          const thumbnailData = thumbnailCanvas.toDataURL('image/jpeg', 0.8)
          lastThumbnailRef.current = thumbnailData
          
          await updateThumbnail({
            sessionId,
            thumbnailUrl: thumbnailData
          })
        }
      }
      img.src = imageData
    } catch (error) {
      console.error('[ThumbnailGenerator] Error generating thumbnail:', error)
    }
  }

  return { generateNow }
}