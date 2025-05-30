import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { getStroke } from 'perfect-freehand'
import { usePaintingSession, type PaintPoint, type Stroke, type UserPresence } from '../hooks/usePaintingSession'
import { Id } from '../../convex/_generated/dataModel'

const average = (a: number, b: number): number => (a + b) / 2;

function getSvgPathFromStroke(points: number[][], closed: boolean = true): string {
  const len = points.length;

  if (len < 4) {
    return ``;
  }

  let a = points[0];
  let b = points[1];
  const c = points[2];

  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(
    2
  )},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(
    b[1],
    c[1]
  ).toFixed(2)} T`;

  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(
      2
    )} `;
  }

  if (closed) {
    result += 'Z';
  }

  return result;
}

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
  isLive?: boolean // True for strokes currently being drawn
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
      smoothing = 0.75, // Increased for smoother lines
      thinning = 0.5,  // Default value
      streamline = 0.65, // Increased for smoother lines
      easing = (t: number) => t, // Default value
      startTaper = 0,    // Default value
      startCap = true,   // Default value
      endTaper = 0,      // Default value
      endCap = true,     // Default value
    },
    ref
  ) => {
    const mainCanvasRef = useRef<HTMLCanvasElement>(null) // For committed strokes
    const drawingCanvasRef = useRef<HTMLCanvasElement>(null) // For live drawing
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentStroke, setCurrentStroke] = useState<Point[]>([])
    const [mainContext, setMainContext] = useState<CanvasRenderingContext2D | null>(null)
    const [drawingContext, setDrawingContext] = useState<CanvasRenderingContext2D | null>(null)
    const [lastStrokeOrder, setLastStrokeOrder] = useState(0)
    const [pendingStrokes, setPendingStrokes] = useState<Map<string, LocalStroke>>(new Map())
    const strokeEndedRef = useRef(false) // Flag to prevent duplicate stroke ending

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

    // Initialize canvases
    useEffect(() => {
      const mainCanvas = mainCanvasRef.current
      const drawCv = drawingCanvasRef.current // Renamed to avoid conflict
      if (!mainCanvas || !drawCv) return

      const mainCtx = mainCanvas.getContext('2d')
      const drawingCtx = drawCv.getContext('2d')
      if (!mainCtx || !drawingCtx) return

      const resizeCanvases = () => {
        const container = mainCanvas.parentElement
        if (container) {
          const { clientWidth, clientHeight } = container
          mainCanvas.width = clientWidth
          mainCanvas.height = clientHeight
          drawCv.width = clientWidth
          drawCv.height = clientHeight
          redrawMainCanvas() // Redraw committed strokes on resize
        }
      }

      resizeCanvases()
      setMainContext(mainCtx)
      setDrawingContext(drawingCtx)

      window.addEventListener('resize', resizeCanvases)
      return () => window.removeEventListener('resize', resizeCanvases)
    }, [])

    // Redraw main canvas when committed strokes change
    useEffect(() => {
      redrawMainCanvas()
    }, [strokes]) // Only redraw main canvas when confirmed strokes change

    // Redraw all committed strokes on the main canvas
    const redrawMainCanvas = useCallback(() => {
      if (!mainContext || !mainCanvasRef.current) return

      mainContext.clearRect(0, 0, mainCanvasRef.current.width, mainCanvasRef.current.height)

      // Draw all confirmed strokes from the session
      strokes
        .sort((a, b) => a.strokeOrder - b.strokeOrder)
        .forEach((s) => {
          drawSingleStroke(mainContext, {
            points: s.points,
            color: s.brushColor,
            size: s.brushSize,
            isPending: false, // Confirmed strokes are not pending
          })
        })
      
      // Draw pending strokes on the main canvas as well, so they persist if drawing canvas is cleared
      // This might be slightly redundant if live drawing is fast, but ensures they are not lost
      // Alternatively, pending strokes could be drawn only on the drawing canvas until confirmed.
      // For now, let's draw them on main too, to ensure they are visible if user stops interacting.
      pendingStrokes.forEach((pendingS) => {
        drawSingleStroke(mainContext, pendingS)
      })

    }, [mainContext, strokes, pendingStrokes, smoothing, thinning, streamline, easing, startTaper, startCap, endTaper, endCap, opacity])

    // Draw a single stroke (helper for both canvases)
    const drawSingleStroke = (ctx: CanvasRenderingContext2D, currentLocalStroke: LocalStroke) => {
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
        last: !currentLocalStroke.isLive, // Use `last: false` only for live strokes being drawn
      }
      const outlinePoints = getStroke(currentLocalStroke.points, options)

      const pathData = getSvgPathFromStroke(outlinePoints)

      if (pathData === '') return // If pathData is empty, nothing to draw

      ctx.fillStyle = currentLocalStroke.color
      ctx.globalAlpha = currentLocalStroke.opacity !== undefined ? currentLocalStroke.opacity : opacity

      const myPath = new Path2D(pathData)
      ctx.fill(myPath)
      
      ctx.globalAlpha = 1 // Reset globalAlpha
    }

    // Draw user cursors on the drawing canvas
    const drawUserCursors = useCallback(() => {
      if (!drawingContext || !drawingCanvasRef.current) return

      presence.forEach((user) => {
        if (user.userName === currentUser.name) return

        drawingContext.fillStyle = user.userColor
        drawingContext.beginPath()
        drawingContext.arc(user.cursorX, user.cursorY, 5, 0, 2 * Math.PI)
        drawingContext.fill()

        drawingContext.fillStyle = 'white'
        drawingContext.strokeStyle = user.userColor
        drawingContext.lineWidth = 2
        drawingContext.font = '12px Arial'
        const textWidth = drawingContext.measureText(user.userName).width
        drawingContext.strokeText(user.userName, user.cursorX - textWidth / 2, user.cursorY - 10)
        drawingContext.fillText(user.userName, user.cursorX - textWidth / 2, user.cursorY - 10)
      })
    }, [drawingContext, presence, currentUser.name])
    
    // Fallback global listener to ensure drawing stops if pointer capture fails
    useEffect(() => {
      if (!isDrawing) return
      
      const handleGlobalPointerUp = () => {
        if (strokeEndedRef.current) return // Prevent duplicate stroke ending
        strokeEndedRef.current = true
        
        // Use a ref to get the current stroke state to avoid stale closure
        setIsDrawing(prevIsDrawing => {
          if (prevIsDrawing) {
            // Get current stroke from state
            setCurrentStroke(prevStroke => {
              // Save the current stroke if it has points
              if (prevStroke.length > 0) {
                const tempId = crypto.randomUUID()
                const newPendingStroke: LocalStroke = {
                  points: prevStroke,
                  color,
                  size,
                  opacity,
                  id: tempId,
                  isPending: true,
                }
                setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
                
                addStrokeToSession(prevStroke, color, size, opacity)
                
                // Redraw main canvas to include the new pending stroke immediately
                if (mainContext) {
                  drawSingleStroke(mainContext, newPendingStroke)
                }
              }
              
              onStrokeEnd?.()
              
              // Clear drawing canvas
              if (drawingContext && drawingCanvasRef.current) {
                drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height)
              }
              
              return [] // Reset current stroke
            })
          }
          return false // Set isDrawing to false
        })
      }
      
      document.addEventListener('pointerup', handleGlobalPointerUp)
      return () => document.removeEventListener('pointerup', handleGlobalPointerUp)
    }, [isDrawing, color, size, opacity, addStrokeToSession, onStrokeEnd, mainContext, drawingContext])

    // Effect to draw pending strokes and cursors on the drawing canvas
    useEffect(() => {
      if (!drawingContext || !drawingCanvasRef.current) return;
      drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height);
      
      // Draw current live stroke if any
      if (isDrawing && currentStroke.length > 0) {
        drawSingleStroke(drawingContext, {
          points: currentStroke,
          color: color,
          size: size,
          opacity: opacity,
          isPending: true,
          isLive: true, // This is a live stroke being drawn
        });
      }
      drawUserCursors();
    }, [drawingContext, currentStroke, isDrawing, color, size, opacity, drawUserCursors]);


    // Get pointer position
    const getPointerPosition = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
      const canvas = drawingCanvasRef.current // Use drawing canvas for pointer events
      const rect = canvas?.getBoundingClientRect()
      if (!rect || !canvas) return { x: 0, y: 0 }

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
      if (!drawingContext || !drawingCanvasRef.current) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsDrawing(true)
      strokeEndedRef.current = false // Reset the flag when starting a new stroke
      
      drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height) // Clear drawing canvas

      const point = getPointerPosition(e)
      setCurrentStroke([point])
      updateUserPresence(point.x, point.y, true, 'brush')
    }

    // Handle pointer move
    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || !drawingContext || !drawingCanvasRef.current) {
        // Still update presence even if not drawing, for cursor tracking
        const nonDrawingPoint = getPointerPosition(e)
        updateUserPresence(nonDrawingPoint.x, nonDrawingPoint.y, false, 'brush')
        return
      }

      // Access the native browser event to use getCoalescedEvents
      const nativeEvent = e.nativeEvent as globalThis.PointerEvent
      const coalescedEvents = nativeEvent.getCoalescedEvents?.() ?? [nativeEvent]
      
      const newPoints: Point[] = coalescedEvents.map(event => {
        // We need to construct a compatible event object for getPointerPosition
        // or adapt getPointerPosition to take a native PointerEvent.
        // For now, let's assume getPointerPosition can work with the properties
        // available on the native event if we simulate the React event structure
        // or, more simply, pass the native event and adjust getPointerPosition.
        // However, getPointerPosition expects a React.PointerEvent.
        // Let's create a "mock" React.PointerEvent-like structure for getPointerPosition
        // or it's better to pass the raw clientX/clientY/pressure.

        // Simpler: pass the native event directly to a modified getPointerPosition,
        // or extract values here. For minimal changes to getPointerPosition:
        return getPointerPosition({
          clientX: event.clientX,
          clientY: event.clientY,
          pressure: event.pressure,
          currentTarget: e.currentTarget, // Keep currentTarget from the original React event
          target: event.target,
        } as unknown as React.PointerEvent<HTMLCanvasElement>); // Cast needed due to partial mock
      })
      
      if (newPoints.length === 0) return

      // Update presence with the last point in the batch
      const lastPoint = newPoints[newPoints.length - 1]
      updateUserPresence(lastPoint.x, lastPoint.y, isDrawing, 'brush')

      const newStrokePoints = [...currentStroke, ...newPoints]
      setCurrentStroke(newStrokePoints)

      // Clear drawing canvas and redraw current stroke and cursors
      drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height)
      drawSingleStroke(drawingContext, {
        points: newStrokePoints,
        color: color,
        size: size,
        opacity: opacity,
        isPending: true, // Live stroke is pending
        isLive: true, // This is a live stroke being drawn
      })
      drawUserCursors()
    }

    // Handle pointer up
    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || !drawingContext || !drawingCanvasRef.current) return
      if (strokeEndedRef.current) return // Prevent duplicate stroke ending
      strokeEndedRef.current = true

      e.currentTarget.releasePointerCapture(e.pointerId)
      setIsDrawing(false)
      
      drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height) // Clear drawing canvas

      const point = getPointerPosition(e) // Get final point
      updateUserPresence(point.x, point.y, false, 'brush')
      
      const finalStrokePoints = [...currentStroke, point] // Add final point to current stroke

      if (finalStrokePoints.length > 0) {
        const tempId = crypto.randomUUID()
        const newPendingStroke: LocalStroke = {
          points: finalStrokePoints,
          color,
          size,
          opacity,
          id: tempId,
          isPending: true,
        }
        setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
        
        addStrokeToSession(finalStrokePoints, color, size, opacity)
        
        // Redraw main canvas to include the new pending stroke immediately
        if (mainContext) {
            drawSingleStroke(mainContext, newPendingStroke)
        }
      }
      setCurrentStroke([]) // Reset current stroke
      onStrokeEnd?.()
    }

    // Handle pointer leave - force end stroke when pointer leaves canvas
    const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return
      if (strokeEndedRef.current) return // Prevent duplicate stroke ending
      strokeEndedRef.current = true
      
      // End the stroke when pointer leaves the canvas
      e.currentTarget.releasePointerCapture(e.pointerId)
      setIsDrawing(false)
      
      if (drawingContext && drawingCanvasRef.current) {
        drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height)
      }
      
      // Get the final point at the edge of the canvas
      const point = getPointerPosition(e)
      updateUserPresence(point.x, point.y, false, 'brush')
      
      // Add final point to current stroke
      const finalStrokePoints = [...currentStroke, point]
      
      // Save the current stroke if it has points
      if (finalStrokePoints.length > 0) {
        const tempId = crypto.randomUUID()
        const newPendingStroke: LocalStroke = {
          points: finalStrokePoints,
          color,
          size,
          opacity,
          id: tempId,
          isPending: true,
        }
        setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
        
        addStrokeToSession(finalStrokePoints, color, size, opacity)
        
        // Redraw main canvas to include the new pending stroke immediately
        if (mainContext) {
          drawSingleStroke(mainContext, newPendingStroke)
        }
      }
      
      setCurrentStroke([]) // Reset current stroke
      onStrokeEnd?.()
    }

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      clear: () => {
        if (mainContext && mainCanvasRef.current) {
          mainContext.clearRect(0, 0, mainCanvasRef.current.width, mainCanvasRef.current.height)
        }
        if (drawingContext && drawingCanvasRef.current) {
          drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height)
        }
        setPendingStrokes(new Map())
        // TODO: Implement clear for session on Convex side
      },
      undo: () => {
        // TODO: Implement undo for session
      },
      getImageData: () => {
        // Return image data from the main canvas which has all committed strokes
        return mainCanvasRef.current?.toDataURL('image/png')
      },
    }), [mainContext, drawingContext])

    return (
      <>
        <canvas
          ref={mainCanvasRef}
          className="absolute inset-0 w-full h-full border border-gray-300"
          style={{ zIndex: 0 }} // Main canvas at the bottom
        />
        <canvas
          ref={drawingCanvasRef}
          className="absolute inset-0 w-full h-full"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          style={{ touchAction: 'none', zIndex: 1 }} // Drawing canvas on top
        />
      </>
    )
  }
)

Canvas.displayName = 'Canvas'
