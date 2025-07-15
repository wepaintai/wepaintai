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
    if (!enabled || !sessionId) {
      console.log('[ThumbnailGenerator] Not enabled or no sessionId:', { enabled, sessionId })
      return
    }

    const generateThumbnail = async () => {
      try {
        console.log('[ThumbnailGenerator] Generating thumbnail for session:', sessionId)
        
        // Check if canvas ref is available
        if (!canvasRef.current) {
          console.log('[ThumbnailGenerator] Canvas ref not available yet')
          return
        }
        
        // Get the canvas image data
        const imageData = canvasRef.current?.getImageData?.()
        if (!imageData) {
          console.log('[ThumbnailGenerator] No image data from canvas')
          return
        }
        
        console.log('[ThumbnailGenerator] Got image data, creating thumbnail...')

        // Check if the image has changed
        if (imageData === lastThumbnailRef.current) {
          return // No changes, skip update
        }

        // Create a smaller thumbnail (max 400px wide)
        const img = new Image()
        img.onload = async () => {
          // Check if the canvas is not empty (all white)
          const tempCanvas = document.createElement('canvas')
          tempCanvas.width = img.width
          tempCanvas.height = img.height
          const tempCtx = tempCanvas.getContext('2d')
          
          if (tempCtx) {
            tempCtx.drawImage(img, 0, 0)
            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height)
            const pixels = imageData.data
            
            // Check if all pixels are white
            let isAllWhite = true
            for (let i = 0; i < pixels.length; i += 4) {
              // Check RGB values (ignore alpha)
              if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) {
                isAllWhite = false
                break
              }
            }
            
            if (isAllWhite) {
              console.log('[ThumbnailGenerator] Canvas is empty (all white), skipping thumbnail update')
              return
            }
          }
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
              console.log('[ThumbnailGenerator] Thumbnail updated successfully')
            }
          }
        }
        img.src = imageData
      } catch (error) {
        console.error('[ThumbnailGenerator] Error generating thumbnail:', error)
      }
    }

    // Delay initial thumbnail generation to allow strokes to load
    const initialTimer = setTimeout(() => {
      console.log('[ThumbnailGenerator] Initial thumbnail generation after delay')
      generateThumbnail()
    }, 3000) // 3 second delay for initial load

    // Set up interval for periodic updates
    intervalRef.current = setInterval(generateThumbnail, interval)

    return () => {
      clearTimeout(initialTimer)
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