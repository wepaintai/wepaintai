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

import { Layer } from './ToolPanel'

interface CanvasLayer {
  id: string
  type: 'stroke' | 'image' | 'ai-image'
  canvasRef: React.RefObject<HTMLCanvasElement>
  context: CanvasRenderingContext2D | null
  visible: boolean
  opacity: number
  order: number
  isDirty: boolean
}

interface CanvasProps {
  sessionId: Id<"paintingSessions"> | null
  color: string
  size: number // perfect-freehand: size
  opacity: number
  onStrokeEnd?: () => void
  layers: Layer[] // Layers from PaintingView
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
  forceRedraw: () => void
}

export const Canvas = forwardRef<CanvasRef, CanvasProps>(
  (
    {
      sessionId,
      color,
      size,
      opacity,
      onStrokeEnd,
      layers,
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
    const drawingCanvasRef = useRef<HTMLCanvasElement>(null) // For live drawing
    const [canvasLayers, setCanvasLayers] = useState<Map<string, CanvasLayer>>(new Map())
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentStroke, setCurrentStroke] = useState<Point[]>([])
    const [drawingContext, setDrawingContext] = useState<CanvasRenderingContext2D | null>(null)
    const [lastStrokeOrder, setLastStrokeOrder] = useState(0)
    const [pendingStrokes, setPendingStrokes] = useState<Map<string, LocalStroke>>(new Map())
    const strokeEndedRef = useRef(false) // Flag to prevent duplicate stroke ending
    const loadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
    const containerRef = useRef<HTMLDivElement>(null)

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

    // Sync canvas layers with layers prop
    useEffect(() => {
      setCanvasLayers(prevCanvasLayers => {
        const updatedLayers = new Map<string, CanvasLayer>()
        
        layers.forEach(layer => {
          const existing = prevCanvasLayers.get(layer.id)
          if (existing) {
            // Update existing layer properties
            updatedLayers.set(layer.id, {
              ...existing,
              visible: layer.visible,
              opacity: layer.opacity,
              order: layer.order,
              isDirty: existing.order !== layer.order || existing.visible !== layer.visible || existing.opacity !== layer.opacity
            })
          } else {
            // Create new canvas layer
            console.log(`[Canvas] Creating new canvas layer for ${layer.id} (${layer.type})`)
            updatedLayers.set(layer.id, {
              id: layer.id,
              type: layer.type,
              canvasRef: React.createRef<HTMLCanvasElement>(),
              context: null,
              visible: layer.visible,
              opacity: layer.opacity,
              order: layer.order,
              isDirty: true
            })
          }
        })
        
        // Remove layers that no longer exist
        prevCanvasLayers.forEach((layer, id) => {
          if (!layers.find(l => l.id === id)) {
            // Clean up canvas context if needed
            if (layer?.context) {
              // Clear the canvas before removing
              const canvas = layer.canvasRef.current
              if (canvas) {
                layer.context.clearRect(0, 0, canvas.width, canvas.height)
              }
            }
          }
        })
        
        return updatedLayers
      })
    }, [layers])

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

    // Redraw a specific layer
    const redrawLayer = useCallback(async (layer: CanvasLayer) => {
      if (!layer.context || !layer.canvasRef.current) return
      
      const canvas = layer.canvasRef.current
      layer.context.clearRect(0, 0, canvas.width, canvas.height)
      
      // Skip if layer is not visible
      if (!layer.visible) return
      
      if (layer.type === 'stroke') {
        // Draw all confirmed strokes from the session
        strokes
          .sort((a, b) => a.strokeOrder - b.strokeOrder)
          .forEach((s) => {
            drawSingleStroke(layer.context!, {
              points: s.points,
              color: s.brushColor,
              size: s.brushSize,
              opacity: s.opacity * layer.opacity,
              isPending: false,
            })
          })
        
        // Draw pending strokes
        pendingStrokes.forEach((pendingS) => {
          drawSingleStroke(layer.context!, {
            ...pendingS,
            opacity: (pendingS.opacity || 1) * layer.opacity
          })
        })
      } else if (layer.type === 'image' || layer.type === 'ai-image') {
        // Find the corresponding image
        const image = images.find(img => img._id === layer.id)
        if (!image || !image.url) return
        
        // Check if image is already loaded
        let img = loadedImagesRef.current.get(image._id)
        
        if (!img) {
          // Load the image
          img = new Image()
          img.crossOrigin = 'anonymous'
          
          try {
            await new Promise<void>((resolve, reject) => {
              img!.onload = () => {
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
            return
          }
        }
        
        // Save context state
        layer.context.save()
        
        // Apply transformations
        layer.context.globalAlpha = image.opacity * layer.opacity
        layer.context.translate(image.x + (image.width * image.scale) / 2, image.y + (image.height * image.scale) / 2)
        layer.context.rotate((image.rotation * Math.PI) / 180)
        layer.context.scale(image.scale, image.scale)
        
        // Draw the image centered
        layer.context.drawImage(
          img,
          -image.width / 2,
          -image.height / 2,
          image.width,
          image.height
        )
        
        // Restore context state
        layer.context.restore()
      }
      
      layer.isDirty = false
    }, [strokes, pendingStrokes, images, drawSingleStroke])

    // Redraw all dirty layers
    useEffect(() => {
      canvasLayers.forEach((layer) => {
        if (layer.isDirty) {
          redrawLayer(layer)
        }
      })
    }, [canvasLayers, redrawLayer])

    // Mark stroke layer as dirty when strokes change
    useEffect(() => {
      setCanvasLayers(prev => {
        const updated = new Map(prev)
        const strokeLayer = Array.from(updated.values()).find(l => l.type === 'stroke')
        if (strokeLayer) {
          strokeLayer.isDirty = true
        }
        return updated
      })
    }, [strokes, pendingStrokes])

    // Mark image layers as dirty when images change
    useEffect(() => {
      setCanvasLayers(prev => {
        const updated = new Map(prev)
        updated.forEach((layer) => {
          if (layer.type === 'image' || layer.type === 'ai-image') {
            layer.isDirty = true
          }
        })
        return updated
      })
    }, [images])

    // Initialize layer canvases
    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const { clientWidth, clientHeight } = container

      // Initialize each layer canvas
      canvasLayers.forEach((layer) => {
        const canvas = layer.canvasRef.current
        if (canvas && !layer.context) {
          const ctx = canvas.getContext('2d')
          if (ctx) {
            canvas.width = clientWidth
            canvas.height = clientHeight
            layer.context = ctx
            layer.isDirty = true
          }
        }
      })

      // Initialize drawing canvas
      const drawingCanvas = drawingCanvasRef.current
      if (drawingCanvas && !drawingContext) {
        const ctx = drawingCanvas.getContext('2d')
        if (ctx) {
          drawingCanvas.width = clientWidth
          drawingCanvas.height = clientHeight
          setDrawingContext(ctx)
        }
      }
    }, [canvasLayers, drawingContext])

    // Handle window resize
    useEffect(() => {
      const resizeCanvases = () => {
        const container = containerRef.current
        if (!container) return

        const { clientWidth, clientHeight } = container

        // Resize all layer canvases
        canvasLayers.forEach((layer) => {
          const canvas = layer.canvasRef.current
          if (canvas && layer.context) {
            canvas.width = clientWidth
            canvas.height = clientHeight
            layer.isDirty = true
          }
        })

        // Resize drawing canvas
        const drawingCanvas = drawingCanvasRef.current
        if (drawingCanvas && drawingContext) {
          drawingCanvas.width = clientWidth
          drawingCanvas.height = clientHeight
        }

        // Trigger redraw of all layers
        setCanvasLayers(new Map(canvasLayers))
      }

      window.addEventListener('resize', resizeCanvases)
      return () => window.removeEventListener('resize', resizeCanvases)
    }, [canvasLayers, drawingContext])


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
                
                // Pending strokes will be drawn when stroke layer redraws
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
    }, [isDrawing, color, size, opacity, addStrokeToSession, onStrokeEnd, drawingContext, canvasLayers])

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
        
        // Mark stroke layer as dirty to trigger redraw
        setCanvasLayers(prev => {
          const updated = new Map(prev)
          const strokeLayer = Array.from(updated.values()).find(l => l.type === 'stroke')
          if (strokeLayer) {
            strokeLayer.isDirty = true
          }
          return updated
        })
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
        
        // Mark stroke layer as dirty to trigger redraw
        setCanvasLayers(prev => {
          const updated = new Map(prev)
          const strokeLayer = Array.from(updated.values()).find(l => l.type === 'stroke')
          if (strokeLayer) {
            strokeLayer.isDirty = true
          }
          return updated
        })
      }
      
      setCurrentStroke([]) // Reset current stroke
      setCurrentStrokeId(null) // Reset P2P stroke ID
      onStrokeEnd?.()
    }

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      clear: () => {
        // Clear all layer canvases
        canvasLayers.forEach((layer) => {
          if (layer.context && layer.canvasRef.current) {
            layer.context.clearRect(0, 0, layer.canvasRef.current.width, layer.canvasRef.current.height)
          }
        })
        
        if (drawingContext && drawingCanvasRef.current) {
          drawingContext.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height)
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
        // Combine all canvas layers into a single image
        console.log('[Canvas] getImageData called')
        console.log('[Canvas] Number of layers:', canvasLayers.size)
        
        if (canvasLayers.size === 0 || !containerRef.current) {
          console.log('[Canvas] ERROR: No layers or container!')
          return ''
        }
        
        const { clientWidth: width, clientHeight: height } = containerRef.current
        
        // Create a temporary canvas to combine all layers
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = width
        tempCanvas.height = height
        const tempContext = tempCanvas.getContext('2d')
        
        if (!tempContext) {
          console.log('[Canvas] Failed to get temp context')
          return ''
        }
        
        // Draw white background
        tempContext.fillStyle = 'white'
        tempContext.fillRect(0, 0, tempCanvas.width, tempCanvas.height)
        
        // Draw layers in order
        Array.from(canvasLayers.values())
          .sort((a, b) => a.order - b.order)
          .forEach(layer => {
            if (layer.visible && layer.canvasRef.current) {
              tempContext.globalAlpha = 1 // Layer opacity is already baked into the canvas
              tempContext.drawImage(layer.canvasRef.current, 0, 0)
              console.log(`[Canvas] Drew layer ${layer.id} (${layer.type}) at order ${layer.order}`)
            }
          })
        
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
        const container = containerRef.current
        return {
          width: container?.clientWidth || 800,
          height: container?.clientHeight || 600
        }
      },
      forceRedraw: () => {
        // Force redraw all layers
        setCanvasLayers(prev => {
          const updated = new Map(prev)
          updated.forEach((layer) => {
            layer.isDirty = true
          })
          return updated
        })
      },
    }), [canvasLayers])

    return (
      <div ref={containerRef} className="relative w-full h-full">
        {/* Render all layer canvases sorted by order */}
        {Array.from(canvasLayers.values())
          .sort((a, b) => a.order - b.order)
          .map((layer) => (
            <canvas
              key={layer.id}
              ref={layer.canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{
                zIndex: layer.order,
                opacity: layer.visible ? 1 : 0,
                border: layer.type === 'stroke' ? '1px solid rgb(209 213 219)' : 'none'
              }}
            />
          ))}
        
        {/* Drawing canvas always on top */}
        <canvas
          ref={drawingCanvasRef}
          className="absolute inset-0 w-full h-full"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          style={{ touchAction: 'none', zIndex: 10 }}
        />
      </div>
    )
  }
)

Canvas.displayName = 'Canvas'
