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
}

interface KonvaCanvasProps {
  sessionId: Id<"paintingSessions"> | null
  color: string
  size: number
  opacity: number
  onStrokeEnd?: () => void
  layers: LayerType[]
  selectedTool?: string
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
    selectedTool = 'brush',
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
  
  // Get AI generated images separately
  const aiImages = useQuery(api.images.getAIGeneratedImages, sessionId ? { sessionId } : 'skip')
  
  // Mutations for updating positions
  const updateImageTransform = useMutation(api.images.updateImageTransform)
  const updateAIImageTransform = useMutation(api.aiGeneration.updateImageTransform)

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
    
    const point = getPointerPosition(e)
    
    // Normal brush behavior
    setIsDrawing(true)
    strokeEndedRef.current = false

    setCurrentStroke([point])
    updateUserPresence(point.x, point.y, true, 'brush')

    // Initialize stroke ID for P2P
    const strokeId = crypto.randomUUID()
    setCurrentStrokeId(strokeId)

    // Send first point via P2P if connected
    if (isP2PConnected && dimensions.width > 0) {
      const normalizedX = point.x / dimensions.width
      const normalizedY = point.y / dimensions.height
      sendStrokePoint(strokeId, normalizedX, normalizedY, point.pressure || 0.5)
    }
  }, [getPointerPosition, updateUserPresence, isP2PConnected, dimensions, sendStrokePoint, selectedTool])

  // Handle pointer move
  const handlePointerMove = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    const point = getPointerPosition(e)

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
          container.style.cursor = selectedTool === 'pan' ? 'grab' : 'crosshair'
        }
      }
      return
    }

    // Handle drawing (only if brush tool is selected)
    if (selectedTool !== 'brush') return
    
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
    updateUserPresence(point.x, point.y, isDrawing, 'brush')
  }, [isDrawing, currentStroke, getPointerPosition, updateUserPresence, isP2PConnected, currentStrokeId, dimensions, sendStrokePoint, sendCursorPosition, selectedTool])

  // Handle pointer up
  const handlePointerUp = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    if (!isDrawing || strokeEndedRef.current || selectedTool !== 'brush') return
    strokeEndedRef.current = true

    setIsDrawing(false)

    const point = getPointerPosition(e)
    const finalStrokePoints = [...currentStroke, point]

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
      
      // Track the pending stroke and update when we get the backend ID
      pendingStrokeIdsRef.current.set(tempId, null)
      addStrokeToSession(finalStrokePoints, color, size, opacity).then(strokeId => {
        if (strokeId) {
          pendingStrokeIdsRef.current.set(tempId, strokeId)
        }
      })
    }

    setCurrentStroke([])
    setCurrentStrokeId(null)
    onStrokeEnd?.()
  }, [isDrawing, currentStroke, getPointerPosition, color, size, opacity, addStrokeToSession, onStrokeEnd, selectedTool])

  // Fallback global listener to ensure drawing stops if pointer capture fails
  useEffect(() => {
    if (!isDrawing) return

    const handleGlobalPointerUp = () => {
      if (strokeEndedRef.current) return
      strokeEndedRef.current = true

      setIsDrawing(false)
      
      if (currentStroke.length > 0) {
        const tempId = crypto.randomUUID()
        const newPendingStroke: LocalStroke = {
          points: currentStroke,
          color,
          size,
          opacity,
          id: tempId,
          isPending: true,
        }
        setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
        
        // Track the pending stroke and update when we get the backend ID
        pendingStrokeIdsRef.current.set(tempId, null)
        addStrokeToSession(currentStroke, color, size, opacity).then(strokeId => {
          if (strokeId) {
            pendingStrokeIdsRef.current.set(tempId, strokeId)
          }
        })
      }

      setCurrentStroke([])
      setCurrentStrokeId(null)
      onStrokeEnd?.()
    }

    document.addEventListener('pointerup', handleGlobalPointerUp)
    return () => document.removeEventListener('pointerup', handleGlobalPointerUp)
  }, [isDrawing, currentStroke, color, size, opacity, addStrokeToSession, onStrokeEnd])

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
    },
    undo: () => {
      console.warn('KonvaCanvas.undo() is deprecated. Use session-level undo instead.')
    },
    getImageData: () => {
      const stage = stageRef.current
      if (!stage) return ''
      
      try {
        return stage.toDataURL({ pixelRatio: 1 })
      } catch (err) {
        console.error('Failed to get canvas data:', err)
        return ''
      }
    },
    getDimensions: () => dimensions,
    forceRedraw: () => {
      // Force redraw all layers
      strokeLayerRef.current?.batchDraw()
      imageLayerRef.current?.batchDraw()
      aiImageLayerRef.current?.batchDraw()
      drawingLayerRef.current?.batchDraw()
    },
  }), [dimensions])

  // Find layer info
  const getLayerInfo = (layerId: string) => {
    return layers.find(l => l.id === layerId) || null
  }

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <Stage
        ref={stageRef}
        width={dimensions.width}
        height={dimensions.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ touchAction: 'none' }}
      >
        {/* Render layers in order */}
        {layers
          .sort((a, b) => a.order - b.order)
          .map((layer) => {
            if (!layer.visible) return null

            // Stroke layer
            if (layer.type === 'stroke') {
              return (
                <Layer key={layer.id} ref={strokeLayerRef} listening={selectedTool === 'pan'} opacity={layer.opacity}>
                  {/* Render confirmed strokes */}
                  {strokes
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
                          fill={stroke.brushColor}
                          opacity={stroke.opacity}
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
                        fill={pendingStroke.color}
                        opacity={pendingStroke.opacity || 1}
                      />
                    )
                  })}
                </Layer>
              )
            }

            // Uploaded image layer
            if (layer.type === 'image') {
              const image = images?.find(img => img._id === layer.id)
              const loadedImage = konvaImages.get(layer.id)
              
              if (!image || !loadedImage) return null
              
              return (
                <Layer key={layer.id} ref={layer.id === images?.[0]?._id ? imageLayerRef : undefined} listening={selectedTool === 'pan'} opacity={layer.opacity}>
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
                    opacity={image.opacity}
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
                </Layer>
              )
            }

            // AI-generated image layer
            if (layer.type === 'ai-image') {
              const aiImage = aiImages?.find(img => img._id === layer.id)
              const loadedImage = konvaImages.get(layer.id)
              
              if (!aiImage || !loadedImage) return null
              
              return (
                <Layer key={layer.id} ref={layer.id === aiImages?.[0]?._id ? aiImageLayerRef : undefined} listening={selectedTool === 'pan'} opacity={layer.opacity}>
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
                    opacity={aiImage.opacity}
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
                  </Layer>
                )
              }

              return null
            })}

          {/* Drawing layer for live strokes and cursors */}
          <Layer ref={drawingLayerRef}>
            {/* Current stroke being drawn */}
            {isDrawing && currentStroke.length > 0 && (
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
          </Layer>
        </Stage>
      </div>
    )
}

export const KonvaCanvas = forwardRef(KonvaCanvasComponent)
KonvaCanvas.displayName = 'KonvaCanvas'