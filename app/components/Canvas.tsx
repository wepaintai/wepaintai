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
}

interface CanvasProps {
  sessionId: Id<"paintingSessions"> | null
  color: string
  size: number
  opacity: number
  onStrokeEnd?: () => void
}

export interface CanvasRef {
  clear: () => void
  undo: () => void
  getImageData: () => string | undefined
}

export const Canvas = forwardRef<CanvasRef, CanvasProps>(
  ({ sessionId, color, size, opacity, onStrokeEnd }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentStroke, setCurrentStroke] = useState<Point[]>([])
    const [context, setContext] = useState<CanvasRenderingContext2D | null>(null)
    const [lastStrokeOrder, setLastStrokeOrder] = useState(0)

    // Use the painting session hook
    const {
      strokes,
      presence,
      currentUser,
      addStrokeToSession,
      updateUserPresence,
    } = usePaintingSession(sessionId)

    // Initialize canvas
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Set canvas size
      const resizeCanvas = () => {
        canvas.width = 800
        canvas.height = 600
        redrawCanvas()
      }

      resizeCanvas()
      setContext(ctx)
    }, [])

    // Redraw all strokes when they change
    useEffect(() => {
      redrawCanvas()
    }, [strokes])

    // Redraw all strokes
    const redrawCanvas = useCallback(() => {
      if (!context || !canvasRef.current) return

      context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)

      // Draw all strokes from the session
      strokes
        .sort((a, b) => a.strokeOrder - b.strokeOrder)
        .forEach((stroke) => {
          drawStroke(context, {
            points: stroke.points,
            color: stroke.brushColor,
            size: stroke.brushSize,
          })
        })
    }, [context, strokes])

    // Draw a single stroke
    const drawStroke = (ctx: CanvasRenderingContext2D, stroke: LocalStroke) => {
      if (stroke.points.length === 0) return

      const outlinePoints = getStroke(stroke.points, {
        size: stroke.size,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
      })

      if (outlinePoints.length === 0) return

      ctx.fillStyle = stroke.color
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
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }

      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
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
      drawStroke(context, {
        points: newStroke,
        color,
        size,
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
        // Add stroke to session
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
