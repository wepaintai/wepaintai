import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { getStroke } from 'perfect-freehand'

interface Point {
  x: number
  y: number
  pressure?: number
}

interface Stroke {
  points: Point[]
  color: string
  size: number
}

interface CanvasProps {
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
  ({ color, size, opacity, onStrokeEnd }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentStroke, setCurrentStroke] = useState<Point[]>([])
    const [strokes, setStrokes] = useState<Stroke[]>([])
    const [context, setContext] = useState<CanvasRenderingContext2D | null>(null)

    // Initialize canvas
    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Set canvas size
      const resizeCanvas = () => {
        canvas.width = window.innerWidth
        canvas.height = window.innerHeight
        redrawCanvas()
      }

      resizeCanvas()
      window.addEventListener('resize', resizeCanvas)
      setContext(ctx)

      return () => {
        window.removeEventListener('resize', resizeCanvas)
      }
    }, [])

    // Redraw all strokes
    const redrawCanvas = useCallback(() => {
      if (!context || !canvasRef.current) return

      context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)

      strokes.forEach((stroke) => {
        drawStroke(context, stroke)
      })
    }, [context, strokes])

    // Draw a single stroke
    const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
      const outlinePoints = getStroke(stroke.points, {
        size: stroke.size,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
      })

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
    }

    // Handle pointer move
    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || !context) return

      const point = getPointerPosition(e)
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
    }

    // Handle pointer up
    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return

      e.currentTarget.releasePointerCapture(e.pointerId)
      setIsDrawing(false)

      if (currentStroke.length > 0) {
        const newStroke: Stroke = {
          points: currentStroke,
          color,
          size,
        }
        setStrokes([...strokes, newStroke])
        setCurrentStroke([])
        onStrokeEnd?.()
      }
    }

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      clear: () => {
        setStrokes([])
        if (context && canvasRef.current) {
          context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
        }
      },
      undo: () => {
        if (strokes.length > 0) {
          const newStrokes = strokes.slice(0, -1)
          setStrokes(newStrokes)
          setTimeout(() => redrawCanvas(), 0)
        }
      },
      getImageData: () => {
        return canvasRef.current?.toDataURL('image/png')
      },
    }), [strokes, context, redrawCanvas])

    return (
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ touchAction: 'none' }}
      />
    )
  }
)

Canvas.displayName = 'Canvas'