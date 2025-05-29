import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { getStroke } from 'perfect-freehand'
import { usePaintingSession, type PaintPoint, type Stroke, type UserPresence } from '../hooks/usePaintingSession'
import { Id } from '../../convex/_generated/dataModel'

interface Point {
  x: number
  y: number
  pressure?: number
}

interface LocalStroke {
  points: Point[]
  color: string
  size: number
  opacity?: number
  id?: string
  isPending?: boolean
}

interface CanvasProps {
  sessionId: Id<"paintingSessions"> | null
  color: string
  size: number // perfect-freehand: size
  opacity: number
  onStrokeEnd?: () => void
  // perfect-freehand options
  smoothing?: number
  thinning?: number
  streamline?: number
  easing?: (t: number) => number
  startTaper?: number
  startCap?: boolean
  endTaper?: number
  endCap?: boolean
}

export interface CanvasRef {
  clear: () => void
  undo: () => void
  getImageData: () => string | undefined
}

export const Canvas = forwardRef<CanvasRef, CanvasProps>(
  (
    {
      sessionId,
      color,
      size,
      opacity,
      onStrokeEnd,
      // perfect-freehand options
      smoothing = 0.5, // Default value
      thinning = 0.5,  // Default value
      streamline = 0.5, // Default value
      easing = (t: number) => t, // Default value
      startTaper = 0,    // Default value
      startCap = true,   // Default value
      endTaper = 0,      // Default value
      endCap = true,     // Default value
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentStroke, setCurrentStroke] = useState<Point[]>([])
    const [context, setContext] = useState<CanvasRenderingContext2D | null>(null)
    const [lastStrokeOrder, setLastStrokeOrder] = useState(0)
    const [pendingStrokes, setPendingStrokes] = useState<Map<string, LocalStroke>>(new Map())

    // Use the painting session hook
    const {
      strokes,
      presence,
      currentUser,
      addStrokeToSession,
      updateUserPresence,
    } = usePaintingSession(sessionId)

    // Remove confirmed strokes from pending when they appear in the strokes array
    useEffect(() => {
      if (strokes.length > 0) {
        setPendingStrokes(prev => {
          const newPending = new Map(prev)
          strokes.forEach(stroke => {
            for (const [id, pendingStroke] of newPending) {
              if (pendingStroke.points.length === stroke.points.length &&
                  pendingStroke.color === stroke.brushColor &&
                  pendingStroke.size === stroke.brushSize) {
                const firstMatch = Math.abs(pendingStroke.points[0].x - stroke.points[0].x) < 1 &&
                                 Math.abs(pendingStroke.points[0].y - stroke.points[0].y) < 1
                const lastIdx = pendingStroke.points.length - 1
                const lastMatch = Math.abs(pendingStroke.points[lastIdx].x - stroke.points[lastIdx].x) < 1 &&
                                Math.abs(pendingStroke.points[lastIdx].y - stroke.points[lastIdx].y) < 1
                
                if (firstMatch && lastMatch) {
                  newPending.delete(id)
                  break
                }
              }
            }
          })
          return newPending
        })
      }
    }, [strokes])

    // Clean up pending strokes that haven't been confirmed after 10 seconds
    useEffect(() => {
      const cleanup = setInterval(() => {
        setPendingStrokes(prev => {
          const newPending = new Map(prev)
          const now = Date.now()
          for (const [id] of newPending) {
            // Simple cleanup: remove all pending strokes older than 10 seconds
            // In a real app, you'd track creation time more precisely
            if (newPending.size > 5) {
              newPending.delete(id)
              break
            }
          }
          return newPending
        })
      }, 5000)

      return () => clearInterval(cleanup)
    }, [])

    // Initialize canvas
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Set canvas size to match container
      const resizeCanvas = () => {
        const container = canvas.parentElement
        if (container) {
          canvas.width = container.clientWidth
          canvas.height = container.clientHeight
          redrawCanvas()
        }
      }

      resizeCanvas()
      setContext(ctx)

      // Add resize listener
      window.addEventListener('resize', resizeCanvas)
      return () => window.removeEventListener('resize', resizeCanvas)
    }, [])

    // Redraw all strokes when they change
    useEffect(() => {
      redrawCanvas()
    }, [strokes, pendingStrokes])

    // Redraw all strokes
    const redrawCanvas = useCallback(() => {
      if (!context || !canvasRef.current) return

      context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)

      // Draw all confirmed strokes from the session
      strokes
        .sort((a, b) => a.strokeOrder - b.strokeOrder)
        .forEach((s) => { // Renamed stroke to s to avoid conflict with outer scope if any
          drawStroke(context, {
            points: s.points,
            color: s.brushColor,
            size: s.brushSize, // Use size from the stored stroke
          })
        })

      // Draw pending strokes
      pendingStrokes.forEach((pendingS) => { // Renamed pendingStroke to pendingS
        drawStroke(context, pendingS)
      })
    }, [context, strokes, pendingStrokes, smoothing, thinning, streamline, easing, startTaper, startCap, endTaper, endCap, opacity]) // Added new dependencies

    // Draw a single stroke
    // Note: 'size' for getStroke comes from stroke.size. Other perfect-freehand options come from CanvasProps.
    const drawStroke = (ctx: CanvasRenderingContext2D, currentLocalStroke: LocalStroke) => {
      if (currentLocalStroke.points.length === 0) return

      const options = {
        size: currentLocalStroke.size,
        smoothing,
        thinning,
        streamline,
        easing,
        start: {
          taper: startTaper,
          cap: startCap,
        },
        end: {
          taper: endTaper,
          cap: endCap,
        },
      }
      const outlinePoints = getStroke(currentLocalStroke.points, options)

      if (outlinePoints.length === 0) return

      ctx.fillStyle = currentLocalStroke.color
      // Use the opacity from CanvasProps for all strokes for consistency in this version
      // If individual strokes should have their own opacity, LocalStroke and Convex schema would need update
      ctx.globalAlpha = opacity 

      ctx.beginPath()
      ctx.moveTo(outlinePoints[0][0], outlinePoints[0][1])
      
      for (let i = 1; i < outlinePoints.length; i++) {
        ctx.lineTo(outlinePoints[i][0], outlinePoints[i][1])
      }
      
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
    }

    // Draw user cursors
    const drawUserCursors = useCallback(() => {
      if (!context || !canvasRef.current) return

      presence.forEach((user) => {
        if (user.userName === currentUser.name) return // Don't draw own cursor

        // Draw cursor
        context.fillStyle = user.userColor
        context.beginPath()
        context.arc(user.cursorX, user.cursorY, 5, 0, 2 * Math.PI)
        context.fill()

        // Draw user name
        context.fillStyle = 'white'
        context.strokeStyle = user.userColor
        context.lineWidth = 2
        context.font = '12px Arial'
        const textWidth = context.measureText(user.userName).width
        context.strokeText(user.userName, user.cursorX - textWidth / 2, user.cursorY - 10)
        context.fillText(user.userName, user.cursorX - textWidth / 2, user.cursorY - 10)
      })
    }, [context, presence, currentUser.name])

    // Redraw with cursors
    useEffect(() => {
      redrawCanvas()
      drawUserCursors()
    }, [redrawCanvas, drawUserCursors])

    // Get pointer position
    const getPointerPosition = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
      const canvas = canvasRef.current
      const rect = canvas?.getBoundingClientRect()
      if (!rect || !canvas) return { x: 0, y: 0 }

      // Calculate the scale factor between the canvas display size and actual size
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height

      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
        pressure: e.pressure,
      }
    }

    // Handle pointer down
    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsDrawing(true)
      const point = getPointerPosition(e)
      setCurrentStroke([point])

      // Update presence
      updateUserPresence(point.x, point.y, true, 'brush')
    }

    // Handle pointer move
    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const point = getPointerPosition(e)

      // Always update presence for cursor tracking
      updateUserPresence(point.x, point.y, isDrawing, 'brush')

      if (!isDrawing || !context) return

      const newStroke = [...currentStroke, point]
      setCurrentStroke(newStroke)

      // Clear and redraw
      context.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height)
      redrawCanvas()

      // Draw current stroke
      // For the currently drawn stroke, use the main 'color' and 'size' props from PaintingView
      drawStroke(context, {
        points: newStroke,
        color: color, // from CanvasProps
        size: size,   // from CanvasProps
        // opacity is handled by drawStroke directly from CanvasProps
      })

      // Draw user cursors
      drawUserCursors()
    }

    // Handle pointer up
    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return

      e.currentTarget.releasePointerCapture(e.pointerId)
      setIsDrawing(false)

      const point = getPointerPosition(e)
      updateUserPresence(point.x, point.y, false, 'brush')

      if (currentStroke.length > 0) {
        // Generate a temporary ID for the stroke
        const tempId = crypto.randomUUID()
        
        // Add stroke to pending state immediately for optimistic update
        const pendingStroke: LocalStroke = {
          points: currentStroke,
          color,
          size,
          opacity,
          id: tempId,
          isPending: true
        }
        
        setPendingStrokes(prev => new Map(prev.set(tempId, pendingStroke)))
        
        // Send stroke to Convex
        addStrokeToSession(currentStroke, color, size, opacity)
        setCurrentStroke([])
        onStrokeEnd?.()
      }
    }

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      clear: () => {
        // TODO: Implement clear for session
        if (context && canvasRef.current) {
          context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
        }
      },
      undo: () => {
        // TODO: Implement undo for session
      },
      getImageData: () => {
        return canvasRef.current?.toDataURL('image/png')
      },
    }), [context])

    return (
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full border border-gray-300"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ touchAction: 'none' }}
      />
    )
  }
)

Canvas.displayName = 'Canvas'
