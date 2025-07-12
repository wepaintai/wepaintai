import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Stage, Layer, Path, Image as KonvaImage, Circle, Text, Group } from 'react-konva'
import Konva from 'konva'
import { getStroke } from 'perfect-freehand'
import { usePaintingSession, type PaintPoint, type Stroke, type UserPresence, type LiveStroke } from '../hooks/usePaintingSession'
import { useP2PPainting } from '../hooks/useP2PPainting'
import { useSessionImages } from '../hooks/useSessionImages'
import { Id } from '../../convex/_generated/dataModel'
import { Layer as LayerType } from './ToolPanel'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'

const average = (a: number, b: number): number => (a + b) / 2

function getSvgPathFromStroke(points: number[][], closed: boolean = true): string {
  const len = points.length

  if (len < 4) {
    return ``
  }

  let a = points[0]
  let b = points[1]
  const c = points[2]

  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(
    2
  )},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(
    b[1],
    c[1]
  ).toFixed(2)} T`

  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i]
    b = points[i + 1]
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(
      2
    )} `
  }

  if (closed) {
    result += 'Z'
  }

  return result
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
  isLive?: boolean
  isEraser?: boolean
}

interface KonvaCanvasProps {
  sessionId: Id<"paintingSessions"> | null
  color: string
  size: number
  opacity: number
  onStrokeEnd?: () => void
  layers: LayerType[]
  selectedTool?: string
  activeLayerId?: string
  activePaintLayerId?: string | null
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

const KonvaCanvasComponent = (props: KonvaCanvasProps, ref: React.Ref<CanvasRef>) => {
  const {
    sessionId,
    color,
    size,
    opacity,
    onStrokeEnd,
    layers,
    activePaintLayerId,
    selectedTool = 'brush',
    activeLayerId = 'painting-layer',
    // perfect-freehand options
    smoothing = 0.75,
    thinning = 0.5,
    streamline = 0.65,
    easing = (t: number) => t,
    startTaper = 0,
    startCap = true,
    endTaper = 0,
    endCap = true,
  } = props
  
  const stageRef = useRef<Konva.Stage>(null)
  const strokeLayerRef = useRef<Konva.Layer>(null)
  const imageLayerRef = useRef<Konva.Layer>(null)
  const aiImageLayerRef = useRef<Konva.Layer>(null)
  const drawingLayerRef = useRef<Konva.Layer>(null)
    
  const [isDrawing, setIsDrawing] = useState(false)
  const [currentStroke, setCurrentStroke] = useState<Point[]>([])
  const [pendingStrokes, setPendingStrokes] = useState<Map<string, LocalStroke>>(new Map())
  const strokeEndedRef = useRef(false)
  const loadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [konvaImages, setKonvaImages] = useState<Map<string, HTMLImageElement>>(new Map())
  // Map to track pending strokes by their temporary IDs to backend IDs
  const pendingStrokeIdsRef = useRef<Map<string, Id<"strokes"> | null>>(new Map())
  // Cursor position for brush size indicator
  const [cursorPosition, setCursorPosition] = useState<Point | null>(null)
  // Eraser masks for image layers - maps layer ID to array of eraser strokes
  const [imageMasks, setImageMasks] = useState<Map<string, LocalStroke[]>>(new Map())

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
  
  // Debug log strokes
  useEffect(() => {
    console.log('[KonvaCanvas] strokes updated:', {
      sessionId,
      strokesLength: strokes?.length || 0,
      strokes: strokes?.slice(0, 2) // Log first 2 strokes
    })
  }, [strokes, sessionId])

  // Use the session images hook
  const { images } = useSessionImages(sessionId)
  
  // Get AI generated images separately
  const aiImages = useQuery(api.images.getAIGeneratedImages, sessionId ? { sessionId } : 'skip')
  
  // Mutations for updating positions
  const updateImageTransform = useMutation(api.images.updateImageTransform)
  const updateAIImageTransform = useMutation(api.images.updateAIImageTransform)

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
    userId: currentUser.id ? currentUser.id.toString() : currentUser.name,
    enabled: !!currentUser.id,
    presence,
  })

  // Track current stroke ID for P2P
  const [currentStrokeId, setCurrentStrokeId] = useState<string | null>(null)
  
  // Track which layer is being dragged (not needed with Konva's built-in dragging)

  // Load images effect
  useEffect(() => {
    const loadImage = async (id: string, url: string) => {
      if (konvaImages.has(id)) return
      
      const img = new window.Image()
      img.crossOrigin = 'anonymous'
      
      return new Promise<void>((resolve) => {
        img.onload = () => {
          setKonvaImages(prev => new Map(prev).set(id, img))
          resolve()
        }
        img.onerror = () => {
          console.error('Failed to load image:', id, url)
          resolve()
        }
        img.src = url
      })
    }

    // Load uploaded images
    if (images) {
      images.forEach(image => {
        if (image.url) {
          loadImage(image._id, image.url)
        }
      })
    }

    // Load AI images
    if (aiImages) {
      aiImages.forEach(image => {
        if (image.imageUrl) {
          loadImage(image._id, image.imageUrl)
        }
      })
    }
  }, [images, aiImages, konvaImages])

  // Update dimensions when container resizes
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current
        setDimensions({ width: clientWidth, height: clientHeight })
      }
    }

    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // Remove confirmed strokes from pending when they appear in the strokes array
  useEffect(() => {
    if (strokes.length > 0) {
      setPendingStrokes(prev => {
        const newPending = new Map(prev)
        const strokeIds = new Set(strokes.map(s => s._id))
        
        // Check each pending stroke to see if it's been confirmed
        for (const [tempId, pendingStroke] of newPending) {
          const backendId = pendingStrokeIdsRef.current.get(tempId)
          if (backendId && strokeIds.has(backendId)) {
            // This pending stroke has been confirmed, remove it
            newPending.delete(tempId)
            pendingStrokeIdsRef.current.delete(tempId)
          }
        }
        
        return newPending
      })
    }
  }, [strokes])

  // Clean up pending strokes that haven't been confirmed after 30 seconds
  useEffect(() => {
    const cleanup = setInterval(() => {
      setPendingStrokes(prev => {
        const newPending = new Map(prev)
        const now = Date.now()
        
        // Only clean up if we have a lot of pending strokes (more than 20)
        // This prevents aggressive deletion of strokes that are still being processed
        if (newPending.size > 20) {
          // Remove the oldest pending stroke
          const firstKey = newPending.keys().next().value
          if (firstKey) {
            newPending.delete(firstKey)
            pendingStrokeIdsRef.current.delete(firstKey)
          }
        }
        
        return newPending
      })
    }, 30000) // Increased to 30 seconds and only when > 20 pending

    return () => clearInterval(cleanup)
  }, [])

  // Clean up masks for deleted layers
  useEffect(() => {
    setImageMasks(prev => {
      const newMasks = new Map(prev)
      const layerIds = new Set(layers.map(l => l.id))
      
      // Remove masks for layers that no longer exist
      for (const [layerId] of newMasks) {
        if (!layerIds.has(layerId)) {
          newMasks.delete(layerId)
        }
      }
      
      return newMasks
    })
  }, [layers])

  // Generate stroke path data
  const getStrokePathData = useCallback((strokeData: LocalStroke) => {
    if (strokeData.points.length === 0) return ''

    const options = {
      size: strokeData.size,
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
      last: !strokeData.isLive,
    }
    const outlinePoints = getStroke(strokeData.points, options)
    return getSvgPathFromStroke(outlinePoints)
  }, [smoothing, thinning, streamline, easing, startTaper, startCap, endTaper, endCap])

  // Get pointer position
  const getPointerPosition = useCallback((e: Konva.KonvaEventObject<PointerEvent>): Point => {
    const stage = stageRef.current
    if (!stage) return { x: 0, y: 0 }

    const pos = stage.getPointerPosition()
    if (!pos) return { x: 0, y: 0 }

    return {
      x: pos.x,
      y: pos.y,
      pressure: e.evt.pressure,
    }
  }, [])

  // Handle pointer down
  const handlePointerDown = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    // Don't start drawing if pan tool is selected
    if (selectedTool === 'pan') {
      return
    }
    
    // Only allow brush on paint layer
    if (selectedTool === 'brush' && activeLayerId !== 'painting-layer') {
      return
    }
    
    // Check if erasing on a valid layer
    if (selectedTool === 'eraser') {
      const activeLayer = layers.find(l => l.id === activeLayerId)
      if (!activeLayer || !['stroke', 'image', 'ai-image'].includes(activeLayer.type)) {
        return
      }
    }
    
    const point = getPointerPosition(e)
    
    // Normal brush/eraser behavior
    setIsDrawing(true)
    strokeEndedRef.current = false

    setCurrentStroke([point])
    updateUserPresence(point.x, point.y, true, selectedTool)

    // Initialize stroke ID for P2P
    const strokeId = crypto.randomUUID()
    setCurrentStrokeId(strokeId)

    // Send first point via P2P if connected
    if (isP2PConnected && dimensions.width > 0) {
      const normalizedX = point.x / dimensions.width
      const normalizedY = point.y / dimensions.height
      sendStrokePoint(strokeId, normalizedX, normalizedY, point.pressure || 0.5)
    }
  }, [getPointerPosition, updateUserPresence, isP2PConnected, dimensions, sendStrokePoint, selectedTool, activeLayerId])

  // Handle pointer move
  const handlePointerMove = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    const point = getPointerPosition(e)

    // Update cursor position for brush size indicator
    if (selectedTool === 'brush' || selectedTool === 'eraser') {
      setCursorPosition(point)
    } else {
      setCursorPosition(null)
    }

    if (!isDrawing) {
      // Still update presence even if not drawing, for cursor tracking
      if (isP2PConnected && dimensions.width > 0) {
        const normalizedX = point.x / dimensions.width
        const normalizedY = point.y / dimensions.height
        sendCursorPosition(normalizedX, normalizedY, false)
      }
      updateUserPresence(point.x, point.y, false, 'brush')
      
      // Update cursor based on tool
      const stage = e.target.getStage()
      if (stage) {
        const container = stage.container()
        if (container) {
          if (selectedTool === 'pan') {
            container.style.cursor = isDrawing ? 'grabbing' : 'grab'
          } else if (selectedTool === 'eraser' || selectedTool === 'brush') {
            container.style.cursor = 'none' // Hide default cursor, we'll show our custom one
          } else {
            container.style.cursor = 'crosshair'
          }
        }
      }
      return
    }

    // Handle drawing (only if brush or eraser tool is selected)
    if (selectedTool !== 'brush' && selectedTool !== 'eraser') return
    
    const newPoints = [...currentStroke, point]
    setCurrentStroke(newPoints)

    // Send points via P2P if connected
    if (isP2PConnected && currentStrokeId && dimensions.width > 0) {
      const normalizedX = point.x / dimensions.width
      const normalizedY = point.y / dimensions.height
      sendStrokePoint(currentStrokeId, normalizedX, normalizedY, point.pressure || 0.5)
    }

    // Update presence
    if (isP2PConnected && dimensions.width > 0) {
      const normalizedX = point.x / dimensions.width
      const normalizedY = point.y / dimensions.height
      sendCursorPosition(normalizedX, normalizedY, true)
    }
    updateUserPresence(point.x, point.y, isDrawing, selectedTool)
  }, [isDrawing, currentStroke, getPointerPosition, updateUserPresence, isP2PConnected, currentStrokeId, dimensions, sendStrokePoint, sendCursorPosition, selectedTool])

  // Handle pointer up
  const handlePointerUp = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    if (!isDrawing || strokeEndedRef.current || (selectedTool !== 'brush' && selectedTool !== 'eraser')) return
    strokeEndedRef.current = true

    setIsDrawing(false)

    const point = getPointerPosition(e)
    const finalStrokePoints = [...currentStroke, point]

    if (finalStrokePoints.length > 0) {
      // Check if we're erasing on an image layer
      if (selectedTool === 'eraser' && activeLayerId !== 'painting-layer') {
        // Add eraser stroke to the image mask
        const eraserStroke: LocalStroke = {
          points: finalStrokePoints,
          color: '#000000',
          size,
          opacity: 1,
          id: crypto.randomUUID(),
          isEraser: true,
        }
        
        setImageMasks(prev => {
          const newMasks = new Map(prev)
          const layerMasks = newMasks.get(activeLayerId) || []
          newMasks.set(activeLayerId, [...layerMasks, eraserStroke])
          return newMasks
        })
      } else {
        // Normal paint layer behavior
        const tempId = crypto.randomUUID()
        const newPendingStroke: LocalStroke = {
          points: finalStrokePoints,
          color,
          size,
          opacity,
          id: tempId,
          isPending: true,
          isEraser: selectedTool === 'eraser',
        }
        setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
        
        // Track the pending stroke and update when we get the backend ID
        pendingStrokeIdsRef.current.set(tempId, null)
        addStrokeToSession(finalStrokePoints, color, size, opacity, selectedTool === 'eraser', activePaintLayerId).then(strokeId => {
          if (strokeId) {
            pendingStrokeIdsRef.current.set(tempId, strokeId)
          }
        })
      }
    }

    setCurrentStroke([])
    setCurrentStrokeId(null)
    onStrokeEnd?.()
  }, [isDrawing, currentStroke, getPointerPosition, color, size, opacity, addStrokeToSession, onStrokeEnd, selectedTool, activeLayerId, activePaintLayerId])

  // Fallback global listener to ensure drawing stops if pointer capture fails
  useEffect(() => {
    if (!isDrawing) return

    const handleGlobalPointerUp = () => {
      if (strokeEndedRef.current) return
      strokeEndedRef.current = true

      setIsDrawing(false)
      
      if (currentStroke.length > 0) {
        // Check if we're erasing on an image layer
        if (selectedTool === 'eraser' && activeLayerId !== 'painting-layer') {
          // Add eraser stroke to the image mask
          const eraserStroke: LocalStroke = {
            points: currentStroke,
            color: '#000000',
            size,
            opacity: 1,
            id: crypto.randomUUID(),
            isEraser: true,
          }
          
          setImageMasks(prev => {
            const newMasks = new Map(prev)
            const layerMasks = newMasks.get(activeLayerId) || []
            newMasks.set(activeLayerId, [...layerMasks, eraserStroke])
            return newMasks
          })
        } else {
          // Normal paint layer behavior
          const tempId = crypto.randomUUID()
          const newPendingStroke: LocalStroke = {
            points: currentStroke,
            color,
            size,
            opacity,
            id: tempId,
            isPending: true,
            isEraser: selectedTool === 'eraser',
          }
          setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
          
          // Track the pending stroke and update when we get the backend ID
          pendingStrokeIdsRef.current.set(tempId, null)
          addStrokeToSession(currentStroke, color, size, opacity, selectedTool === 'eraser').then(strokeId => {
            if (strokeId) {
              pendingStrokeIdsRef.current.set(tempId, strokeId)
            }
          })
        }
      }

      setCurrentStroke([])
      setCurrentStrokeId(null)
      onStrokeEnd?.()
    }

    document.addEventListener('pointerup', handleGlobalPointerUp)
    return () => document.removeEventListener('pointerup', handleGlobalPointerUp)
  }, [isDrawing, currentStroke, color, size, opacity, addStrokeToSession, onStrokeEnd, selectedTool, activeLayerId])

  // Handle pointer leave - hide cursor
  const handlePointerLeave = useCallback(() => {
    setCursorPosition(null)
  }, [])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    clear: () => {
      // Clear all layers
      strokeLayerRef.current?.clear()
      imageLayerRef.current?.clear()
      aiImageLayerRef.current?.clear()
      drawingLayerRef.current?.clear()
      
      setPendingStrokes(new Map())
      pendingStrokeIdsRef.current.clear()
      setCurrentStroke([])
      setIsDrawing(false)
      strokeEndedRef.current = false
      loadedImagesRef.current.clear()
      setImageMasks(new Map())
    },
    undo: () => {
      console.warn('KonvaCanvas.undo() is deprecated. Use session-level undo instead.')
    },
    getImageData: () => {
      const stage = stageRef.current
      if (!stage) {
        console.error('[KonvaCanvas] getImageData: No stage ref')
        return ''
      }
      
      try {
        // Log current state
        console.log('[KonvaCanvas] getImageData called')
        console.log('[KonvaCanvas] Stage dimensions:', stage.width(), 'x', stage.height())
        console.log('[KonvaCanvas] Number of layers:', stage.children.length)
        console.log('[KonvaCanvas] Visible layers:', stage.children.filter(l => l.visible()).length)
        // Note: strokes array might be empty here due to closure, but the rendered paths are what matters
        
        // Log what's actually rendered in each layer
        stage.children.forEach((layer, idx) => {
          const childCount = layer.children.length
          console.log(`[KonvaCanvas] Layer ${idx}: visible=${layer.visible()}, opacity=${layer.opacity()}, children=${childCount}`)
          
          // Log first few children details
          if (childCount > 0) {
            const firstChild = layer.children[0]
            console.log(`  - First child type: ${firstChild.className}, visible: ${firstChild.visible()}`)
          }
        })
        
        // Force draw before capturing
        stage.batchDraw()
        
        // Create a temporary canvas with white background
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = stage.width()
        tempCanvas.height = stage.height()
        const tempCtx = tempCanvas.getContext('2d')
        
        if (tempCtx) {
          // Fill with white background
          tempCtx.fillStyle = 'white'
          tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height)
          
          // Draw the stage content on top
          const stageCanvas = stage.toCanvas({ pixelRatio: 1 })
          tempCtx.drawImage(stageCanvas, 0, 0)
          
          // Get data URL from temp canvas
          const dataUrl = tempCanvas.toDataURL('image/png')
          console.log('[KonvaCanvas] Data URL with white background length:', dataUrl.length)
          return dataUrl
        }
        
        // Fallback to original method
        const dataUrl = stage.toDataURL({ 
          pixelRatio: 1,
          mimeType: 'image/png'
        })
        console.log('[KonvaCanvas] Data URL length:', dataUrl.length)
        console.log('[KonvaCanvas] Data URL preview:', dataUrl.substring(0, 100))
        
        
        return dataUrl
      } catch (err) {
        console.error('[KonvaCanvas] Failed to get canvas data:', err)
        return ''
      }
    },
    getDimensions: () => dimensions,
    forceRedraw: () => {
      // Force redraw all layers
      console.log('[KonvaCanvas] forceRedraw called')
      strokeLayerRef.current?.batchDraw()
      imageLayerRef.current?.batchDraw()
      aiImageLayerRef.current?.batchDraw()
      drawingLayerRef.current?.batchDraw()
      
      // Also force update stage
      if (stageRef.current) {
        stageRef.current.batchDraw()
      }
    },
  }), [dimensions])

  // Find layer info
  const getLayerInfo = (layerId: string) => {
    return layers.find(l => l.id === layerId) || null
  }

  // Enforce correct layer ordering when layers change
  useEffect(() => {
    // Wait a bit for all layers to be rendered
    const timer = setTimeout(() => {
      const stage = stageRef.current
      if (!stage) return
      
      // Log current layer state
      console.log('[KonvaCanvas] Checking layer order after change:', {
        layerCount: layers.length,
        layers: layers.map(l => ({ 
          id: l.id, 
          type: l.type, 
          order: l.order,
          name: l.name 
        })).sort((a, b) => a.order - b.order)
      })
      
      // Force a redraw
      stage.batchDraw()
    }, 100)
    
    return () => clearTimeout(timer)
  }, [layers])

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {/* Debug overlay to show layer order */}
      {process.env.NODE_ENV === 'development' && (
        <div className="absolute top-2 right-2 bg-black/80 text-white text-xs p-2 z-50 rounded">
          <div className="font-bold mb-1">Layer Render Order:</div>
          {layers
            .sort((a, b) => a.order - b.order)
            .map((layer, idx) => (
              <div key={layer.id} className="flex items-center gap-2">
                <span className="text-gray-400">{idx}:</span>
                <span className={layer.type === 'stroke' || layer.type === 'paint' ? 'text-blue-400' : layer.type === 'ai-image' ? 'text-purple-400' : 'text-green-400'}>
                  {layer.name}
                </span>
                <span className="text-gray-500">(order: {layer.order})</span>
              </div>
            ))}
        </div>
      )}
      <Stage
        ref={stageRef}
        width={dimensions.width}
        height={dimensions.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        style={{ touchAction: 'none' }}
      >
        {/* Render layers in order */}
        {layers
          .sort((a, b) => a.order - b.order)
          .map((layer, renderIndex) => {
            if (!layer.visible) return null
            
            // Debug logging for layer order issues
            console.log(`[KonvaCanvas] Rendering layer ${renderIndex}:`, {
              id: layer.id,
              type: layer.type,
              name: layer.name,
              order: layer.order,
              visible: layer.visible,
              opacity: layer.opacity,
              isPaintLayer: layer.type === 'stroke' || layer.type === 'paint',
              isAILayer: layer.type === 'ai-image'
            })

            // Paint layer (supports both 'stroke' for backward compatibility and 'paint' for new multi-layer)
            if (layer.type === 'stroke' || layer.type === 'paint') {
              // Filter strokes for this specific paint layer
              // For paint layers, filter by layerId
              // For stroke layer (backward compatibility), show strokes without layerId
              const layerStrokes = layer.type === 'paint' 
                ? strokes.filter(stroke => stroke.layerId === layer.id)
                : strokes.filter(stroke => !stroke.layerId) // Show only strokes without layerId on the default stroke layer
              
              console.log('[KonvaCanvas] Rendering paint layer:', {
                layerId: layer.id,
                layerType: layer.type,
                allStrokesCount: strokes.length,
                layerStrokesCount: layerStrokes.length,
                firstStrokeLayerId: strokes[0]?.layerId,
                strokesWithoutLayerId: strokes.filter(s => !s.layerId).length,
                strokesWithLayerId: strokes.filter(s => s.layerId).length
              })
                
              // Debug: Log when rendering paint layer
              console.log('[KonvaCanvas] Rendering paint layer with strokes:', {
                layerId: layer.id,
                strokeCount: layerStrokes.length,
                opacity: layer.opacity,
                renderIndex,
                totalLayersCount: layers.length
              })
              
              return (
                <Layer 
                  key={layer.id} 
                  ref={strokeLayerRef} 
                  listening={selectedTool === 'pan'} 
                  opacity={layer.opacity}
                >
                  {/* Render confirmed strokes */}
                  {layerStrokes
                    .sort((a, b) => a.strokeOrder - b.strokeOrder)
                    .map((stroke) => {
                      const pathData = getStrokePathData({
                        points: stroke.points,
                        color: stroke.brushColor,
                        size: stroke.brushSize,
                        opacity: stroke.opacity,
                        isPending: false,
                      })
                      
                      if (!pathData) return null
                      
                      return (
                        <Path
                          key={stroke._id}
                          data={pathData}
                          fill={stroke.isEraser ? '#000000' : stroke.brushColor}
                          opacity={stroke.opacity}
                          globalCompositeOperation={stroke.isEraser ? 'destination-out' : 'source-over'}
                          perfectDrawEnabled={false}
                        />
                      )
                    })}
                  
                  {/* Render pending strokes */}
                  {Array.from(pendingStrokes.values()).map((pendingStroke) => {
                    const pathData = getStrokePathData(pendingStroke)
                    if (!pathData) return null
                    
                    return (
                      <Path
                        key={pendingStroke.id}
                        data={pathData}
                        fill={pendingStroke.isEraser ? '#000000' : pendingStroke.color}
                        opacity={pendingStroke.opacity || 1}
                        globalCompositeOperation={pendingStroke.isEraser ? 'destination-out' : 'source-over'}
                      />
                    )
                  })}
                  
                  {/* Render current stroke being drawn (including eraser) */}
                  {isDrawing && currentStroke.length > 0 && (layer.id === activePaintLayerId || (layer.type === 'stroke' && activeLayerId === 'painting-layer')) && (
                    <Path
                      data={getStrokePathData({
                        points: currentStroke,
                        color,
                        size,
                        opacity,
                        isLive: true,
                        isEraser: selectedTool === 'eraser',
                      })}
                      fill={selectedTool === 'eraser' ? '#000000' : color}
                      opacity={opacity}
                      listening={false}
                      globalCompositeOperation={selectedTool === 'eraser' ? 'destination-out' : 'source-over'}
                    />
                  )}
                </Layer>
              )
            }

            // Uploaded image layer
            if (layer.type === 'image') {
              const image = images?.find(img => img._id === layer.id)
              const loadedImage = konvaImages.get(layer.id)
              
              if (!image || !loadedImage) return null
              
              return (
                <Layer 
                  key={layer.id} 
                  ref={layer.id === images?.[0]?._id ? imageLayerRef : undefined} 
                  listening={selectedTool === 'pan'} 
                  opacity={layer.opacity}
                >
                  <Group>
                    <KonvaImage
                      id={layer.id}
                      image={loadedImage}
                      x={image.x}
                      y={image.y}
                      width={image.width * image.scale}
                      height={image.height * image.scale}
                      rotation={image.rotation}
                      offsetX={image.width / 2}
                      offsetY={image.height / 2}
                      draggable={selectedTool === 'pan'}
                      onDragEnd={async (e) => {
                        const node = e.target
                        await updateImageTransform({
                          imageId: layer.id as Id<"uploadedImages">,
                          x: node.x(),
                          y: node.y()
                        })
                      }}
                    />
                    
                    {/* Render eraser masks */}
                    {imageMasks.get(layer.id)?.map((maskStroke) => {
                      const pathData = getStrokePathData(maskStroke)
                      if (!pathData) return null
                      
                      return (
                        <Path
                          key={maskStroke.id}
                          data={pathData}
                          fill="#000000"
                          globalCompositeOperation="destination-out"
                        />
                      )
                    })}
                    
                    {/* Render current eraser stroke if erasing this layer */}
                    {isDrawing && currentStroke.length > 0 && selectedTool === 'eraser' && activeLayerId === layer.id && (
                      <Path
                        data={getStrokePathData({
                          points: currentStroke,
                          color: '#000000',
                          size,
                          opacity: 1,
                          isLive: true,
                          isEraser: true,
                        })}
                        fill="#000000"
                        globalCompositeOperation="destination-out"
                      />
                    )}
                  </Group>
                </Layer>
              )
            }

            // AI-generated image layer
            if (layer.type === 'ai-image') {
              const aiImage = aiImages?.find(img => img._id === layer.id)
              const loadedImage = konvaImages.get(layer.id)
              
              if (!aiImage || !loadedImage) return null
              
              // Debug: Log when rendering AI layer
              console.log('[KonvaCanvas] Rendering AI image layer:', {
                layerId: layer.id,
                imageExists: !!loadedImage,
                opacity: layer.opacity,
                renderIndex,
                imageOpacity: aiImage?.opacity
              })
              
              return (
                <Layer 
                  key={layer.id} 
                  ref={layer.id === aiImages?.[0]?._id ? aiImageLayerRef : undefined} 
                  listening={selectedTool === 'pan'} 
                  opacity={layer.opacity}
                >
                  <Group>
                    <KonvaImage
                      id={layer.id}
                      image={loadedImage}
                      x={aiImage.x}
                      y={aiImage.y}
                      width={aiImage.width * aiImage.scale}
                      height={aiImage.height * aiImage.scale}
                      rotation={aiImage.rotation}
                      offsetX={aiImage.width / 2}
                      offsetY={aiImage.height / 2}
                      draggable={selectedTool === 'pan'}
                      onDragEnd={async (e) => {
                        const node = e.target
                        await updateAIImageTransform({
                          imageId: layer.id as Id<"aiGeneratedImages">,
                          x: node.x(),
                          y: node.y()
                        })
                      }}
                    />
                    
                    {/* Render eraser masks */}
                    {imageMasks.get(layer.id)?.map((maskStroke) => {
                      const pathData = getStrokePathData(maskStroke)
                      if (!pathData) return null
                      
                      return (
                        <Path
                          key={maskStroke.id}
                          data={pathData}
                          fill="#000000"
                          globalCompositeOperation="destination-out"
                        />
                      )
                    })}
                    
                    {/* Render current eraser stroke if erasing this layer */}
                    {isDrawing && currentStroke.length > 0 && selectedTool === 'eraser' && activeLayerId === layer.id && (
                      <Path
                        data={getStrokePathData({
                          points: currentStroke,
                          color: '#000000',
                          size,
                          opacity: 1,
                          isLive: true,
                          isEraser: true,
                        })}
                        fill="#000000"
                        globalCompositeOperation="destination-out"
                      />
                    )}
                  </Group>
                </Layer>
              )
              }

              return null
            })}

          {/* Drawing layer for live strokes and cursors */}
          <Layer ref={drawingLayerRef}>
            {/* Current stroke being drawn (only for non-eraser tools on non-paint layers) */}
            {isDrawing && currentStroke.length > 0 && selectedTool === 'brush' && activeLayerId !== 'painting-layer' && (
              <Path
                data={getStrokePathData({
                  points: currentStroke,
                  color,
                  size,
                  opacity,
                  isLive: true,
                })}
                fill={color}
                opacity={opacity}
                listening={false}
              />
            )}

            {/* P2P remote strokes */}
            {isP2PConnected && Array.from(remoteStrokes.values()).map((remoteStroke) => {
              if (remoteStroke.points.length === 0) return null
              
              // Denormalize points from 0-1 to canvas coordinates
              const denormalizedPoints = remoteStroke.points.map(p => ({
                x: p.x * dimensions.width,
                y: p.y * dimensions.height,
                pressure: p.pressure
              }))
              
              const pathData = getStrokePathData({
                points: denormalizedPoints,
                color: remoteStroke.color,
                size: remoteStroke.size,
                opacity: 0.8, // Slightly transparent for preview
                isLive: true,
              })
              
              if (!pathData) return null
              
              return (
                <Path
                  key={remoteStroke.strokeId}
                  data={pathData}
                  fill={remoteStroke.color}
                  opacity={0.8}
                  listening={false}
                />
              )
            })}

            {/* Remote cursors */}
            {isP2PConnected && Array.from(remoteCursors.entries()).map(([peerId, cursor]) => {
              const x = cursor.x * dimensions.width
              const y = cursor.y * dimensions.height
              
              // Get peer color from presence
              const peerColor = presence.find(p => p.userName === peerId || p.userId?.toString() === peerId)?.userColor || '#666666'
              const peerName = presence.find(p => p.userName === peerId || p.userId?.toString() === peerId)?.userName || peerId.substring(0, 8)
              
              return (
                <Group key={peerId} x={x} y={y}>
                  <Circle
                    radius={cursor.drawing ? 8 : 5}
                    fill={peerColor}
                    stroke={cursor.drawing ? '#000000' : '#FFFFFF'}
                    strokeWidth={cursor.drawing ? 2 : 1}
                  />
                  <Text
                    text={peerName}
                    fontSize={11}
                    fontStyle="bold"
                    fill="white"
                    stroke={peerColor}
                    strokeWidth={3}
                    x={-20}
                    y={-25}
                    align="center"
                  />
                </Group>
              )
            })}
            
            {/* Cursor size indicator */}
            {cursorPosition && (selectedTool === 'brush' || selectedTool === 'eraser') && (
              <Circle
                x={cursorPosition.x}
                y={cursorPosition.y}
                radius={size / 2}
                stroke={selectedTool === 'eraser' ? '#ff0000' : color}
                strokeWidth={1}
                fill={selectedTool === 'eraser' ? 'rgba(255, 0, 0, 0.1)' : color}
                fillOpacity={selectedTool === 'eraser' ? 0.1 : 0.2}
                listening={false}
                opacity={0.8}
              />
            )}
          </Layer>
        </Stage>
      </div>
    )
}

export const KonvaCanvas = forwardRef(KonvaCanvasComponent)
KonvaCanvas.displayName = 'KonvaCanvas'