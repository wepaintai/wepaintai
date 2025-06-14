import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { getStroke } from 'perfect-freehand'
import { usePaintingSession, type PaintPoint, type Stroke, type UserPresence, type LiveStroke } from '../hooks/usePaintingSession'
import { useP2PPainting } from '../hooks/useP2PPainting'
import { useSessionImages } from '../hooks/useSessionImages'
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
  getDimensions: () => { width: number; height: number }
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
    const imageCanvasRef = useRef<HTMLCanvasElement>(null) // For images layer
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentStroke, setCurrentStroke] = useState<Point[]>([])
    const [mainContext, setMainContext] = useState<CanvasRenderingContext2D | null>(null)
    const [drawingContext, setDrawingContext] = useState<CanvasRenderingContext2D | null>(null)
    const [imageContext, setImageContext] = useState<CanvasRenderingContext2D | null>(null)
    const [lastStrokeOrder, setLastStrokeOrder] = useState(0)
    const [pendingStrokes, setPendingStrokes] = useState<Map<string, LocalStroke>>(new Map())
    const strokeEndedRef = useRef(false) // Flag to prevent duplicate stroke ending
    const loadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map())

    // Use the painting session hook
    const {
      strokes,
      presence,
      liveStrokes,
      currentUser,
      addStrokeToSession,
      updateUserPresence,
      updateLiveStrokeForUser,
      clearLiveStrokeForUser,
    } = usePaintingSession(sessionId)

    // Use the session images hook
    const { images } = useSessionImages(sessionId)
    
    // Log images for debugging
    React.useEffect(() => {
      console.log('Canvas - Images in session:', images.length, images)
    }, [images])

    // P2P preview layer
    const {
      isConnected: isP2PConnected,
      connectionMode,
      remoteStrokes,
      remoteCursors,
      sendStrokePoint,
      sendCursorPosition,
      clearRemoteStroke,
      metrics: p2pMetrics,
    } = useP2PPainting({
      sessionId,
      userId: currentUser.id ? currentUser.id.toString() : currentUser.name, // Convert ID to string
      enabled: !!currentUser.id, // Only enable when user is created
      presence, // Pass presence to get peer colors
    })
    

    // Track current stroke ID for P2P
    const [currentStrokeId, setCurrentStrokeId] = useState<string | null>(null)

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

    }, [mainContext, strokes, pendingStrokes, smoothing, thinning, streamline, easing, startTaper, startCap, endTaper, endCap, opacity, drawSingleStroke])

    // Draw images on the image canvas
    const redrawImageCanvas = useCallback(async () => {
      if (!imageContext || !imageCanvasRef.current) return

      console.log('Redrawing image canvas with', images.length, 'images')
      console.log('Images details:', images.map(img => ({
        id: img._id,
        type: (img as any).type,
        url: img.url?.substring(0, 50) + '...',
        opacity: img.opacity,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        scale: img.scale
      })))
      imageContext.clearRect(0, 0, imageCanvasRef.current.width, imageCanvasRef.current.height)

      // Draw all images in layer order
      for (const image of images) {
        if (!image.url) {
          console.log('Image missing URL:', image._id)
          continue
        }

        console.log('Drawing image:', image._id, 'type:', (image as any).type, 'at', image.x, image.y, 'scale:', image.scale, 'opacity:', image.opacity)

        // Check if image is already loaded
        let img = loadedImagesRef.current.get(image._id)
        
        if (!img) {
          // Load the image
          console.log('Loading image from URL:', image.url)
          img = new Image()
          img.crossOrigin = 'anonymous'
          
          try {
            await new Promise<void>((resolve, reject) => {
              img!.onload = () => {
                console.log('Image loaded successfully:', image._id)
                loadedImagesRef.current.set(image._id, img!)
                resolve()
              }
              img!.onerror = (e) => {
                console.error('Failed to load image:', image._id, e)
                reject(e)
              }
              img!.src = image.url!
            })
          } catch (err) {
            console.error('Error loading image:', err)
            continue
          }
        }

        // Save context state
        imageContext.save()

        // Apply transformations
        imageContext.globalAlpha = image.opacity
        imageContext.translate(image.x + (image.width * image.scale) / 2, image.y + (image.height * image.scale) / 2)
        imageContext.rotate((image.rotation * Math.PI) / 180)
        imageContext.scale(image.scale, image.scale)

        // Draw the image centered
        imageContext.drawImage(
          img,
          -image.width / 2,
          -image.height / 2,
          image.width,
          image.height
        )

        // Restore context state
        imageContext.restore()
        console.log('Image drawn successfully:', image._id)
      }
    }, [imageContext, images])

    // Initialize canvases
    useEffect(() => {
      const mainCanvas = mainCanvasRef.current
      const drawCv = drawingCanvasRef.current // Renamed to avoid conflict
      const imageCanvas = imageCanvasRef.current
      if (!mainCanvas || !drawCv || !imageCanvas) return

      const mainCtx = mainCanvas.getContext('2d')
      const drawingCtx = drawCv.getContext('2d')
      const imageCtx = imageCanvas.getContext('2d')
      if (!mainCtx || !drawingCtx || !imageCtx) return

      // Initial setup
      const container = mainCanvas.parentElement
      if (container) {
        const { clientWidth, clientHeight } = container
        mainCanvas.width = clientWidth
        mainCanvas.height = clientHeight
        drawCv.width = clientWidth
        drawCv.height = clientHeight
        imageCanvas.width = clientWidth
        imageCanvas.height = clientHeight
      }

      setMainContext(mainCtx)
      setDrawingContext(drawingCtx)
      setImageContext(imageCtx)
    }, [])

    // Handle window resize separately to ensure it uses current redraw functions
    useEffect(() => {
      const resizeCanvases = () => {
        const mainCanvas = mainCanvasRef.current
        const drawCv = drawingCanvasRef.current
        const imageCanvas = imageCanvasRef.current
        if (!mainCanvas || !drawCv || !imageCanvas) return

        const container = mainCanvas.parentElement
        if (container) {
          const { clientWidth, clientHeight } = container
          mainCanvas.width = clientWidth
          mainCanvas.height = clientHeight
          drawCv.width = clientWidth
          drawCv.height = clientHeight
          imageCanvas.width = clientWidth
          imageCanvas.height = clientHeight
          redrawImageCanvas() // Redraw images on resize
          redrawMainCanvas() // Redraw committed strokes on resize
        }
      }

      window.addEventListener('resize', resizeCanvases)
      return () => window.removeEventListener('resize', resizeCanvases)
    }, [redrawMainCanvas, redrawImageCanvas])

    // Redraw main canvas when committed strokes change
    useEffect(() => {
      redrawMainCanvas()
    }, [strokes, redrawMainCanvas]) // Only redraw main canvas when confirmed strokes change

    // Redraw image canvas when images change
    useEffect(() => {
      redrawImageCanvas()
    }, [images, redrawImageCanvas])

    // Draw user cursors on the drawing canvas
    const drawUserCursors = useCallback(() => {
      if (!drawingContext || !drawingCanvasRef.current) return

      const canvasWidth = drawingCanvasRef.current.width;
      const canvasHeight = drawingCanvasRef.current.height;

      // Draw P2P cursors (low latency)
      if (isP2PConnected) {
        remoteCursors.forEach((cursor, peerId) => {
          const x = cursor.x * canvasWidth;
          const y = cursor.y * canvasHeight;
          
          // Get peer color from presence
          const peerColor = presence.find(p => p.userName === peerId || p.userId?.toString() === peerId)?.userColor || '#666666';
          
          drawingContext.fillStyle = peerColor;
          drawingContext.beginPath()
          drawingContext.arc(x, y, cursor.drawing ? 8 : 5, 0, 2 * Math.PI)
          drawingContext.fill()
          
          // Draw cursor outline
          drawingContext.strokeStyle = cursor.drawing ? '#000000' : '#FFFFFF';
          drawingContext.lineWidth = cursor.drawing ? 2 : 1;
          drawingContext.stroke();
          
          // Peer label
          drawingContext.fillStyle = 'white'
          drawingContext.strokeStyle = peerColor;
          drawingContext.lineWidth = 3
          drawingContext.font = 'bold 11px Arial'
          const peerName = presence.find(p => p.userName === peerId || p.userId?.toString() === peerId)?.userName || peerId.substring(0, 8);
          const textWidth = drawingContext.measureText(peerName).width;
          drawingContext.strokeText(peerName, x - textWidth / 2, y - 15)
          drawingContext.fillText(peerName, x - textWidth / 2, y - 15)
        });
      }
      // No Convex cursor fallback - P2P only
    }, [drawingContext, presence, currentUser.name, isP2PConnected, remoteCursors])
    
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

    // Effect to draw live strokes and cursors on the drawing canvas
    useEffect(() => {
      if (!drawingContext || !drawingCanvasRef.current) return;
      drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height);
      
      // Draw current user's live stroke if any
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
      
      // Draw P2P remote strokes (high priority, low latency)
      if (isP2PConnected && drawingCanvasRef.current) {
        const canvasWidth = drawingCanvasRef.current.width;
        const canvasHeight = drawingCanvasRef.current.height;
        
        remoteStrokes.forEach((remoteStroke) => {
          if (remoteStroke.points.length > 0) {
            // Denormalize points from 0-1 to canvas coordinates
            const denormalizedPoints = remoteStroke.points.map(p => ({
              x: p.x * canvasWidth,
              y: p.y * canvasHeight,
              pressure: p.pressure
            }));
            
            // Drawing remote stroke
            
            drawSingleStroke(drawingContext, {
              points: denormalizedPoints,
              color: remoteStroke.color,
              size: remoteStroke.size,
              opacity: 0.8, // Slightly transparent for preview
              isPending: true,
              isLive: true,
            });
          }
        });
      }
      
      // P2P only - no Convex fallback for live strokes
      // Remote strokes are drawn above via P2P remoteStrokes
      
      drawUserCursors();
    }, [drawingContext, currentStroke, isDrawing, color, size, opacity, liveStrokes, currentUser.name, drawUserCursors, isP2PConnected, connectionMode, remoteStrokes]);


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
      
      // Initialize stroke ID for P2P
      const strokeId = crypto.randomUUID()
      setCurrentStrokeId(strokeId)
      
      // Send first point via P2P if connected
      if (isP2PConnected && drawingCanvasRef.current) {
        const normalizedX = point.x / drawingCanvasRef.current.width
        const normalizedY = point.y / drawingCanvasRef.current.height
        sendStrokePoint(strokeId, normalizedX, normalizedY, point.pressure || 0.5)
      }
    }

    // Handle pointer move
    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing || !drawingContext || !drawingCanvasRef.current) {
        // Still update presence even if not drawing, for cursor tracking
        const nonDrawingPoint = getPointerPosition(e)
        
        // Send cursor via P2P (fast)
        if (isP2PConnected && drawingCanvasRef.current) {
          const normalizedX = nonDrawingPoint.x / drawingCanvasRef.current.width;
          const normalizedY = nonDrawingPoint.y / drawingCanvasRef.current.height;
          sendCursorPosition(normalizedX, normalizedY, false);
        }
        
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
      
      // Send cursor via P2P (fast)
      if (isP2PConnected && drawingCanvasRef.current) {
        const normalizedX = lastPoint.x / drawingCanvasRef.current.width;
        const normalizedY = lastPoint.y / drawingCanvasRef.current.height;
        sendCursorPosition(normalizedX, normalizedY, true);
      }
      
      // Update Convex presence (slower, for fallback)
      updateUserPresence(lastPoint.x, lastPoint.y, isDrawing, 'brush')

      const newStrokePoints = [...currentStroke, ...newPoints]
      setCurrentStroke(newStrokePoints)

      // Send points via P2P if connected
      if (isP2PConnected && currentStrokeId && drawingCanvasRef.current) {
        // Log removed for production
        // Send batch of new points
        newPoints.forEach(point => {
          const normalizedX = point.x / drawingCanvasRef.current!.width
          const normalizedY = point.y / drawingCanvasRef.current!.height
          sendStrokePoint(currentStrokeId, normalizedX, normalizedY, point.pressure || 0.5)
        })
      }
      
      // Update live stroke for other users to see (throttled in the hook)
      // Only use Convex if P2P is not connected
      // Only use P2P for live strokes, no Convex fallback
      // updateLiveStrokeForUser is now disabled

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
      // P2P only - no Convex presence update
      
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
        
        // P2P only - no need to clear Convex live strokes
        
        // Clear P2P stroke tracking
        setCurrentStrokeId(null)
        
        // Redraw main canvas to include the new pending stroke immediately
        if (mainContext) {
            drawSingleStroke(mainContext, newPendingStroke)
        }
      }
      setCurrentStroke([]) // Reset current stroke
      setCurrentStrokeId(null) // Reset P2P stroke ID
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
      // P2P only - no Convex presence update
      
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
      setCurrentStrokeId(null) // Reset P2P stroke ID
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
        if (imageContext && imageCanvasRef.current) {
          imageContext.clearRect(0, 0, imageCanvasRef.current.width, imageCanvasRef.current.height)
        }
        setPendingStrokes(new Map())
        setCurrentStroke([])
        setIsDrawing(false)
        strokeEndedRef.current = false
        // Clear loaded images cache to force reload
        loadedImagesRef.current.clear()
        // Note: Session clearing is handled by the parent component via clearSession mutation
      },
      undo: () => {
        // Undo is now handled at the session level in PaintingView
        console.warn('Canvas.undo() is deprecated. Use session-level undo instead.')
      },
      getImageData: () => {
        // Combine all canvas layers (images + strokes) into a single image
        console.log('[Canvas] getImageData called')
        console.log('[Canvas] Main canvas exists:', !!mainCanvasRef.current)
        console.log('[Canvas] Image canvas exists:', !!imageCanvasRef.current)
        console.log('[Canvas] Number of images:', images.length)
        console.log('[Canvas] Number of strokes:', strokes.length)
        console.log('[Canvas] Pending strokes:', pendingStrokes.size)
        
        if (!mainCanvasRef.current) {
          console.log('[Canvas] ERROR: Main canvas ref is null!')
          return ''
        }
        
        // Check if canvases have actual dimensions
        console.log('[Canvas] Main canvas dimensions:', mainCanvasRef.current.width, 'x', mainCanvasRef.current.height)
        
        // Create a temporary canvas to combine all layers
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = mainCanvasRef.current.width
        tempCanvas.height = mainCanvasRef.current.height
        const tempContext = tempCanvas.getContext('2d')
        
        if (!tempContext) {
          console.log('[Canvas] Failed to get temp context')
          return mainCanvasRef.current.toDataURL('image/png')
        }
        
        // Draw white background
        tempContext.fillStyle = 'white'
        tempContext.fillRect(0, 0, tempCanvas.width, tempCanvas.height)
        
        // Draw main canvas (strokes) first
        tempContext.drawImage(mainCanvasRef.current, 0, 0)
        console.log('[Canvas] Drew strokes layer')
        
        // Draw image layer (AI images) on top
        if (imageCanvasRef.current) {
          tempContext.drawImage(imageCanvasRef.current, 0, 0)
          console.log('[Canvas] Drew image layer (AI images) on top')
        }
        
        // Check if the canvas is actually empty
        const imageData = tempContext.getImageData(0, 0, tempCanvas.width, tempCanvas.height)
        const pixels = imageData.data
        let hasContent = false
        for (let i = 0; i < pixels.length; i += 4) {
          // Check if any pixel is not white (255, 255, 255)
          if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) {
            hasContent = true
            break
          }
        }
        console.log('[Canvas] Canvas has content:', hasContent)
        
        // Get initial data URL
        let dataUrl = tempCanvas.toDataURL('image/png')
        console.log('[Canvas] Initial data URL length:', dataUrl.length)
        
        // If the data URL is too large (> 800KB to be safe with Convex limits), resize it
        if (dataUrl.length > 800000) {
          console.log('[Canvas] Data URL too large, resizing...')
          
          // Calculate scale factor to reduce size
          const scaleFactor = Math.sqrt(800000 / dataUrl.length)
          const newWidth = Math.floor(tempCanvas.width * scaleFactor)
          const newHeight = Math.floor(tempCanvas.height * scaleFactor)
          
          console.log('[Canvas] Resizing from', tempCanvas.width, 'x', tempCanvas.height, 'to', newWidth, 'x', newHeight)
          
          // Create a smaller canvas
          const smallCanvas = document.createElement('canvas')
          smallCanvas.width = newWidth
          smallCanvas.height = newHeight
          const smallContext = smallCanvas.getContext('2d')
          
          if (smallContext) {
            // Draw the combined canvas onto the smaller canvas
            smallContext.drawImage(tempCanvas, 0, 0, newWidth, newHeight)
            
            // Try different quality settings to get under the limit
            let quality = 0.9
            dataUrl = smallCanvas.toDataURL('image/jpeg', quality)
            
            while (dataUrl.length > 800000 && quality > 0.1) {
              quality -= 0.1
              dataUrl = smallCanvas.toDataURL('image/jpeg', quality)
              console.log('[Canvas] Trying quality:', quality, 'size:', dataUrl.length)
            }
          }
        }
        
        console.log('[Canvas] Final data URL length:', dataUrl.length)
        console.log('[Canvas] First 100 chars of dataUrl:', dataUrl.substring(0, 100))
        
        return dataUrl
      },
      getDimensions: () => {
        // Return current canvas dimensions
        return {
          width: mainCanvasRef.current?.width || 800,
          height: mainCanvasRef.current?.height || 600
        }
      },
    }), [mainContext, drawingContext, imageContext])

    return (
      <>
        <canvas
          ref={mainCanvasRef}
          className="absolute inset-0 w-full h-full border border-gray-300"
          style={{ zIndex: 0 }} // Main canvas for strokes at the bottom
        />
        <canvas
          ref={imageCanvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ zIndex: 1 }} // Image canvas (AI images) in the middle
        />
        <canvas
          ref={drawingCanvasRef}
          className="absolute inset-0 w-full h-full"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          style={{ touchAction: 'none', zIndex: 2 }} // Drawing canvas on top
        />
      </>
    )
  }
)

Canvas.displayName = 'Canvas'
