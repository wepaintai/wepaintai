import React, { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle, memo } from 'react'
import { Stage, Layer, Path, Image as KonvaImage, Circle, Text, Group, Arc, Transformer } from 'react-konva'
import Konva from 'konva'
import { getStroke } from 'perfect-freehand'
import { usePaintingSession, type PaintPoint, type Stroke, type UserPresence, type LiveStroke } from '../hooks/usePaintingSession'
import { useP2PPainting } from '../hooks/useP2PPainting'
import { useSessionImages } from '../hooks/useSessionImages'
import { Id } from '../../convex/_generated/dataModel'
import { Layer as LayerType } from './ToolPanel'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { shouldShowAdminFeatures } from '../utils/environment'
import { uploadImageFile, validateImageFile, ACCEPTED_TYPES } from '../utils/imageUpload'
import { useClipboardContext } from '../context/ClipboardContext'

const average = (a: number, b: number): number => (a + b) / 2

// Generate a rainbow color based on position along the stroke
const getRainbowColor = (progress: number): string => {
  const hue = progress * 360
  return `hsl(${hue}, 100%, 50%)`
}

// Memoized stroke component to prevent unnecessary re-renders
interface StrokePathProps {
  stroke: Stroke
  pathData: string
  strokeData?: any // perfect-freehand stroke data for rainbow rendering
}

// Component for rendering rainbow strokes as multiple segments
const RainbowStroke = memo(({ stroke }: { stroke: Stroke }) => {
  const segments: React.ReactElement[] = []
  const points = stroke.points
  
  if (points.length < 2) return null
  
  // Fixed segment length in pixels for consistent rainbow effect
  const SEGMENT_LENGTH = 15 // Fixed length for each color segment
  const SEGMENT_OVERLAP = 5 // Overlap between segments for smooth transitions
  
  // Track total distance for color progression
  let totalDistanceTraveled = 0
  let currentSegmentDistance = 0
  let segmentStartIdx = 0
  
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    const distance = Math.sqrt(dx * dx + dy * dy)
    currentSegmentDistance += distance
    totalDistanceTraveled += distance
    
    // When we've traveled enough distance, create a segment
    if (currentSegmentDistance >= SEGMENT_LENGTH - SEGMENT_OVERLAP || i === points.length - 1) {
      const segmentPoints = points.slice(segmentStartIdx, i + 1)
      
      if (segmentPoints.length >= 2) {
        // Calculate color based on total distance traveled
        const segmentMidDistance = totalDistanceTraveled - (currentSegmentDistance / 2)
        const colorProgress = (segmentMidDistance / 200) % 1 // Cycle every 200 pixels
        const color = getRainbowColor(colorProgress)
        
        // Use perfect-freehand to get the stroke outline for this segment
        const options = {
          size: stroke.brushSize,
          smoothing: 0.35,
          thinning: 0.2,
          streamline: 0.4,
          easing: (t: number) => t,
          start: { taper: 0, cap: true },
          end: { taper: 0, cap: true },
          last: i === points.length - 1,
        }
        
        const outlinePoints = getStroke(segmentPoints, options)
        const pathData = getSvgPathFromStroke(outlinePoints)
        
        segments.push(
          <Path
            key={`${stroke._id}-${segmentStartIdx}`}
            data={pathData}
            fill={color}
            opacity={stroke.opacity}
            perfectDrawEnabled={false}
          />
        )
      }
      
      // Start next segment with overlap
      segmentStartIdx = Math.max(0, i - 2) // Small overlap
      currentSegmentDistance = SEGMENT_OVERLAP // Reset segment distance but keep total
    }
  }
  
  return <>{segments}</>
})

const StrokePath = memo(({ stroke, pathData }: StrokePathProps) => {
  if (stroke.isEraser) {
    console.log('[StrokePath] Rendering eraser stroke:', stroke._id, 'with destination-out')
  }
  
  // If it's a rainbow stroke, use the RainbowStroke component
  if (stroke.colorMode === 'rainbow' && !stroke.isEraser) {
    return <RainbowStroke stroke={stroke} />
  }
  
  // Otherwise render as a normal path
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
}, (prevProps, nextProps) => {
  // Only re-render if stroke data changes
  return prevProps.stroke._id === nextProps.stroke._id &&
         prevProps.pathData === nextProps.pathData &&
         prevProps.stroke.colorMode === nextProps.stroke.colorMode
})

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
  colorMode?: 'solid' | 'rainbow'
  targetLayerId?: string
}

interface KonvaCanvasProps {
  sessionId: Id<"paintingSessions"> | null
  color: string
  size: number
  opacity: number
  colorMode?: 'solid' | 'rainbow'
  onStrokeEnd?: () => void
  layers: LayerType[]
  selectedTool?: string
  activeLayerId?: string
  activePaintLayerId?: string | null
  onImageUploaded?: (imageId: Id<"uploadedImages">) => void
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
    colorMode = 'solid',
    onStrokeEnd,
    layers,
    activePaintLayerId,
    selectedTool = 'brush',
    activeLayerId,
    onImageUploaded,
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
  const transformerRef = useRef<Konva.Transformer>(null)
  // Node refs for attaching transformer
  const paintGroupRefs = useRef<Map<string, Konva.Group>>(new Map())
  const imageNodeRefs = useRef<Map<string, Konva.Image>>(new Map())
  const aiImageNodeRefs = useRef<Map<string, Konva.Image>>(new Map())
    
  const [isDrawing, setIsDrawing] = useState(false)
  const [currentStroke, setCurrentStroke] = useState<Point[]>([])
  const [pendingStrokes, setPendingStrokes] = useState<Map<string, LocalStroke>>(new Map())
  const strokeEndedRef = useRef(false)
  const loadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [konvaImages, setKonvaImages] = useState<Map<string, HTMLImageElement>>(new Map())
  // Track which images we have auto-fitted to avoid re-fitting after user moves/scales
  const autoFittedRef = useRef<Set<string>>(new Set())
  // Map to track pending strokes by their temporary IDs to backend IDs
  const pendingStrokeIdsRef = useRef<Map<string, Id<"strokes"> | null>>(new Map())
  // Cursor position for brush size indicator
  const [cursorPosition, setCursorPosition] = useState<Point | null>(null)
  // Track if mouse is over the canvas stage (via shared context)
  const { isMouseOverCanvas, setIsMouseOverCanvas, isMouseOverToolbox, isAIModalOpen } = useClipboardContext()
  // Eraser masks for image layers - maps layer ID to array of eraser strokes
  const [imageMasks, setImageMasks] = useState<Map<string, LocalStroke[]>>(new Map())
  // Drag and drop state
  const [isDragOver, setIsDragOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

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
  // useEffect(() => {
  //   console.log('[KonvaCanvas] strokes updated:', {
  //     sessionId,
  //     strokesLength: strokes?.length || 0,
  //     strokes: strokes?.slice(0, 2), // Log first 2 strokes
  //     activePaintLayerId,
  //     activeLayerId,
  //     layers: layers.map(l => ({ id: l.id, type: l.type, name: l.name }))
  //   })
  // }, [strokes, sessionId, activePaintLayerId, activeLayerId, layers])

  // Use the session images hook
  const { images } = useSessionImages(sessionId)
  
  // Get AI generated images separately
  const aiImages = useQuery(api.images.getAIGeneratedImages, sessionId ? { sessionId, guestKey: (typeof window !== 'undefined' ? (JSON.parse(localStorage.getItem('wepaint_guest_keys_v1') || '{}') || {})[sessionId as any] : undefined) } : 'skip')
  // Get paint layers for transforms
  const paintLayersData = useQuery(api.paintLayers.getPaintLayers, sessionId ? { sessionId, guestKey: (typeof window !== 'undefined' ? (JSON.parse(localStorage.getItem('wepaint_guest_keys_v1') || '{}') || {})[sessionId as any] : undefined) } : 'skip')
  
  // Mutations for updating positions
  const updateImageTransform = useMutation(api.images.updateImageTransform)
  const updateAIImageTransform = useMutation(api.images.updateAIImageTransform)
  const updatePaintLayerTransform = useMutation(api.paintLayers.updatePaintLayer)
  
  // Mutations for image upload
  const generateUploadUrl = useMutation(api.images.generateUploadUrl)
  const uploadImage = useMutation(api.images.uploadImage)

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
          // console.error('Failed to load image:', id, url)
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

    // Use RAF to ensure DOM is ready
    requestAnimationFrame(updateDimensions)
    
    // Also update on resize
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // Auto-fit newly loaded uploaded images to current canvas dimensions once
  useEffect(() => {
    if (!images || dimensions.width === 0 || dimensions.height === 0) return
    images
      .filter((img: any) => !img.type || img.type === 'uploaded')
      .forEach((img: any) => {
        if (!img || autoFittedRef.current.has(img._id)) return
        // Use "cover" fit so the image fills the canvas (may crop on one axis), never upscale above 1
        const desiredScale = Math.min(Math.max(dimensions.width / img.width, dimensions.height / img.height), 1)
        const desiredX = dimensions.width / 2
        const desiredY = dimensions.height / 2
        const currentScale = typeof img.scale === 'number' ? img.scale : 1
        if (Math.abs(currentScale - desiredScale) > 0.02 || Math.abs(img.x - desiredX) > 2 || Math.abs(img.y - desiredY) > 2) {
          updateImageTransform({
            imageId: img._id as Id<"uploadedImages">,
            scale: desiredScale,
            scaleX: desiredScale,
            scaleY: desiredScale,
            x: desiredX,
            y: desiredY
          } as any)
          autoFittedRef.current.add(img._id)
        }
      })
  }, [images, dimensions.width, dimensions.height, updateImageTransform])

  // Auto-fit newly loaded AI images once as well
  useEffect(() => {
    if (!aiImages || dimensions.width === 0 || dimensions.height === 0) return
    aiImages.forEach((img: any) => {
      if (!img || autoFittedRef.current.has(img._id)) return
      // Use "cover" fit for AI images as well
      const desiredScale = Math.min(Math.max(dimensions.width / img.width, dimensions.height / img.height), 1)
      const desiredX = dimensions.width / 2
      const desiredY = dimensions.height / 2
      const currentScale = typeof img.scale === 'number' ? img.scale : 1
      if (Math.abs(currentScale - desiredScale) > 0.02 || Math.abs(img.x - desiredX) > 2 || Math.abs(img.y - desiredY) > 2) {
        updateAIImageTransform({
          imageId: img._id as Id<"aiGeneratedImages">,
          scale: desiredScale,
          scaleX: desiredScale,
          scaleY: desiredScale,
          x: desiredX,
          y: desiredY
        } as any)
        autoFittedRef.current.add(img._id)
      }
    })
  }, [aiImages, dimensions.width, dimensions.height, updateAIImageTransform])

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
    if (strokeData.points.length === 0) return { pathData: '', strokePoints: [] }

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
    return {
      pathData: getSvgPathFromStroke(outlinePoints),
      strokePoints: outlinePoints
    }
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
    // console.log('[KonvaCanvas] handlePointerDown:', {
    //   selectedTool,
    //   activeLayerId,
    //   activePaintLayerId,
    //   layers: layers.map(l => ({ id: l.id, type: l.type }))
    // })
    
    // Don't start drawing if transform tool is selected
    if (selectedTool === 'transform') {
      return
    }
    
    // Brush now allowed on all layer types; target layer is resolved on stroke end
    
    // Check if erasing on a valid layer
    if (selectedTool === 'eraser') {
      const activeLayer = layers.find(l => l.id === activeLayerId)
      if (!activeLayer || !['paint', 'image', 'ai-image'].includes(activeLayer.type)) {
        console.log('[KonvaCanvas] Eraser blocked - invalid layer type:', activeLayer?.type)
        return
      }
    }
    
    const stagePoint = getPointerPosition(e)
    // If painting on a transformed paint layer, convert to layer-local coords for drawing only
    const activeLayer = layers.find(l => l.id === activeLayerId)
    const point = ((selectedTool === 'brush' || selectedTool === 'eraser') && activeLayer?.type === 'paint')
      ? toActivePaintLayerLocal(stagePoint)
      : stagePoint
    
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
  }, [getPointerPosition, updateUserPresence, isP2PConnected, dimensions, sendStrokePoint, selectedTool, activeLayerId, layers])

  // Handle pointer move
  const handlePointerMove = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    const stagePoint = getPointerPosition(e)
    const activeLayer = layers.find(l => l.id === activeLayerId)
    const point = ((selectedTool === 'brush' || selectedTool === 'eraser') && activeLayer?.type === 'paint')
      ? toActivePaintLayerLocal(stagePoint)
      : stagePoint

    // Update cursor position for brush size indicator (use stage coords)
    if (selectedTool === 'brush' || selectedTool === 'eraser') {
      // Use untransformed stage coordinates so the indicator overlays the actual cursor
      setCursorPosition(stagePoint)
    } else {
      setCursorPosition(null)
    }

    if (!isDrawing) {
      // Still update presence even if not drawing, for cursor tracking
      if (isP2PConnected && dimensions.width > 0) {
      const normalizedX = stagePoint.x / dimensions.width
      const normalizedY = stagePoint.y / dimensions.height
      sendCursorPosition(normalizedX, normalizedY, false)
    }
    updateUserPresence(stagePoint.x, stagePoint.y, false, 'brush')
      
      // Update cursor based on tool
      const stage = e.target.getStage()
      if (stage) {
        const container = stage.container()
        if (container) {
          if (selectedTool === 'transform') {
            // Determine cursor by hovered transformer anchor or target
            const target: any = e.target
            const parent = target?.getParent?.()
            const isTransformerChild = parent?.getClassName?.() === 'Transformer'
            if (isTransformerChild) {
              const name = target?.name?.() || ''
              // Rotation handle
              if (name === 'rotater') {
                container.style.cursor = "url('/cursors/rotate.svg') 12 12, crosshair"
              } else if (name === 'top-left' || name === 'bottom-right') {
                container.style.cursor = 'nwse-resize'
              } else if (name === 'top-right' || name === 'bottom-left') {
                container.style.cursor = 'nesw-resize'
              } else if (name === 'middle-left' || name === 'middle-right') {
                container.style.cursor = 'ew-resize'
              } else if (name === 'top-center' || name === 'bottom-center') {
                container.style.cursor = 'ns-resize'
              } else {
                container.style.cursor = "url('/cursors/move.svg') 12 12, move"
              }
            } else {
              const className = target?.getClassName?.()
              if (className === 'Image' || className === 'Group') {
                // Over the node itself => move
                container.style.cursor = "url('/cursors/move.svg') 12 12, move"
              } else {
                // Empty canvas area
                container.style.cursor = 'default'
              }
            }
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
      const normalizedX = stagePoint.x / dimensions.width
      const normalizedY = stagePoint.y / dimensions.height
      sendStrokePoint(currentStrokeId, normalizedX, normalizedY, point.pressure || 0.5)
    }

    // Update presence
    if (isP2PConnected && dimensions.width > 0) {
      const normalizedX = stagePoint.x / dimensions.width
      const normalizedY = stagePoint.y / dimensions.height
      sendCursorPosition(normalizedX, normalizedY, true)
    }
    updateUserPresence(stagePoint.x, stagePoint.y, isDrawing, selectedTool)
  }, [isDrawing, currentStroke, getPointerPosition, updateUserPresence, isP2PConnected, currentStrokeId, dimensions, sendStrokePoint, sendCursorPosition, selectedTool])

  // Handle pointer up
  const handlePointerUp = useCallback((e: Konva.KonvaEventObject<PointerEvent>) => {
    if (!isDrawing || strokeEndedRef.current || (selectedTool !== 'brush' && selectedTool !== 'eraser')) return
    strokeEndedRef.current = true

    setIsDrawing(false)

    const stagePoint = getPointerPosition(e)
    const activeLayer = layers.find(l => l.id === activeLayerId)
    const drawPoint = ((selectedTool === 'brush' || selectedTool === 'eraser') && activeLayer?.type === 'paint')
      ? toActivePaintLayerLocal(stagePoint)
      : stagePoint
    const finalStrokePoints = [...currentStroke, drawPoint]

    if (finalStrokePoints.length > 0) {
      // Check if we're erasing on an image layer (not a paint layer)
      const activeLayer = layers.find(l => l.id === activeLayerId)
      const isErasingOnImageLayer = selectedTool === 'eraser' && activeLayer && activeLayer.type !== 'stroke' && activeLayer.type !== 'paint'
      
      if (isErasingOnImageLayer) {
        const tempId = crypto.randomUUID()
        const newPendingStroke: LocalStroke = {
          points: finalStrokePoints,
          color: '#000000',
          size,
          opacity: 1,
          id: tempId,
          isPending: true,
          isEraser: true,
          colorMode: 'solid',
          targetLayerId: activeLayerId,
        }
        setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
        pendingStrokeIdsRef.current.set(tempId, null)
        const layerIdToUse = activeLayerId || null
        addStrokeToSession(finalStrokePoints, '#000000', size, 1, true, layerIdToUse, 'solid').then(strokeId => {
          if (strokeId) {
            pendingStrokeIdsRef.current.set(tempId, strokeId)
          }
        }).catch(err => {
          console.error('[KonvaCanvas] Error saving eraser stroke on image layer:', err)
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
          colorMode: selectedTool === 'eraser' ? 'solid' : colorMode,
        }
        setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
        
        // Track the pending stroke and update when we get the backend ID
        pendingStrokeIdsRef.current.set(tempId, null)
        // Use activeLayerId when erasing on a paint layer, otherwise use activePaintLayerId for brush
        // If activePaintLayerId is null and we're using brush, fall back to activeLayerId if it's a paint layer
        let layerIdToUse: string | null = null
        if (activeLayer) {
          if (selectedTool === 'brush' && (activeLayer.type === 'image' || activeLayer.type === 'ai-image')) {
            layerIdToUse = activeLayerId || null
          } else if (selectedTool === 'eraser' && activeLayer.type === 'paint') {
            layerIdToUse = activeLayerId || null
          } else if (activeLayer.type === 'paint') {
            layerIdToUse = (activePaintLayerId || activeLayerId) || null
          }
        }
        // Fallbacks for paint layer when nothing selected/resolved
        if (!layerIdToUse) {
          const firstPaintLayer = layers.find(l => l.type === 'paint')
          if (firstPaintLayer) {
            layerIdToUse = firstPaintLayer.id
          } else if (paintLayersData && (paintLayersData as any[]).length > 0) {
            const firstFromData = (paintLayersData as any[])[0]?._id
            if (firstFromData) layerIdToUse = firstFromData
          }
        }

        // Set target layer for pending preview
        setPendingStrokes(prev => {
          const map = new Map(prev)
          const ps = map.get(tempId)
          if (ps) ps.targetLayerId = layerIdToUse || undefined
          return map
        })
        
        console.log('[KonvaCanvas] Saving stroke with layerId:', layerIdToUse, 'isEraser:', selectedTool === 'eraser', 'activeLayerId:', activeLayerId, 'activePaintLayerId:', activePaintLayerId, 'activeLayer:', activeLayer)
        addStrokeToSession(finalStrokePoints, color, size, opacity, selectedTool === 'eraser', layerIdToUse, selectedTool === 'eraser' ? 'solid' : colorMode).then(strokeId => {
          console.log('[KonvaCanvas] Stroke saved with ID:', strokeId)
          if (strokeId) {
            pendingStrokeIdsRef.current.set(tempId, strokeId)
          }
        }).catch(err => {
          console.error('[KonvaCanvas] Error saving stroke:', err)
        })
      }
    }

    setCurrentStroke([])
    setCurrentStrokeId(null)
    onStrokeEnd?.()
  }, [isDrawing, currentStroke, getPointerPosition, color, size, opacity, addStrokeToSession, onStrokeEnd, selectedTool, activeLayerId, activePaintLayerId, layers])

  // Fallback global listener to ensure drawing stops if pointer capture fails
  useEffect(() => {
    if (!isDrawing) return

    const handleGlobalPointerUp = () => {
      if (strokeEndedRef.current) return
      strokeEndedRef.current = true

      setIsDrawing(false)
      
      if (currentStroke.length > 0) {
        // Check if we're erasing on an image layer (not a paint layer)
        const activeLayer = layers.find(l => l.id === activeLayerId)
        const isErasingOnImageLayer = selectedTool === 'eraser' && activeLayer && activeLayer.type !== 'stroke' && activeLayer.type !== 'paint'
        
        if (isErasingOnImageLayer) {
          const tempId = crypto.randomUUID()
          const newPendingStroke: LocalStroke = {
            points: currentStroke,
            color: '#000000',
            size,
            opacity: 1,
            id: tempId,
            isPending: true,
            isEraser: true,
            colorMode: 'solid',
            targetLayerId: activeLayerId,
          }
          setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
          pendingStrokeIdsRef.current.set(tempId, null)
          const layerIdToUse = activeLayerId || null
          addStrokeToSession(currentStroke, '#000000', size, 1, true, layerIdToUse, 'solid').then(strokeId => {
            if (strokeId) {
              pendingStrokeIdsRef.current.set(tempId, strokeId)
            }
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
            colorMode: selectedTool === 'eraser' ? 'solid' : colorMode,
          }
          setPendingStrokes(prev => new Map(prev).set(tempId, newPendingStroke))
          
          // Track the pending stroke and update when we get the backend ID
          pendingStrokeIdsRef.current.set(tempId, null)
          // Use activeLayerId when erasing on a paint layer, otherwise use activePaintLayerId for brush
          // If activePaintLayerId is null and we're using brush, fall back to activeLayerId if it's a paint layer
          let layerIdToUse: string | null = null
          if (activeLayer) {
            if (selectedTool === 'brush' && (activeLayer.type === 'image' || activeLayer.type === 'ai-image')) {
              layerIdToUse = activeLayerId || null
            } else if (selectedTool === 'eraser' && (activeLayer.type === 'paint' || activeLayer.type === 'stroke')) {
              layerIdToUse = activeLayerId || null
            } else if (activeLayer.type === 'paint' || activeLayer.type === 'stroke') {
              layerIdToUse = (activePaintLayerId || activeLayerId) || null
            }
          }
          // Ensure we have a target layer id; fallback to first known paint layer
          if (!layerIdToUse) {
            const firstPaintLayer = layers.find(l => l.type === 'paint')
            if (firstPaintLayer) {
              layerIdToUse = firstPaintLayer.id
            } else if (paintLayersData && (paintLayersData as any[]).length > 0) {
              const firstFromData = (paintLayersData as any[])[0]?._id
              if (firstFromData) layerIdToUse = firstFromData
            }
          }
          // Set target layer for pending preview
          setPendingStrokes(prev => {
            const map = new Map(prev)
            const ps = map.get(tempId)
            if (ps) ps.targetLayerId = layerIdToUse || undefined
            return map
          })

          addStrokeToSession(currentStroke, color, size, opacity, selectedTool === 'eraser', layerIdToUse, selectedTool === 'eraser' ? 'solid' : colorMode).then(strokeId => {
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
  }, [isDrawing, currentStroke, color, size, opacity, addStrokeToSession, onStrokeEnd, selectedTool, activeLayerId, activePaintLayerId, layers])

  // Handle pointer leave - hide cursor  
  const handlePointerLeave = useCallback(() => {
    // Stage pointer leave handled by container div now
  }, [])

  // Handle document mouse leave - hide cursor when mouse leaves window
  useEffect(() => {
    const handleDocumentMouseLeave = (e: MouseEvent) => {
      // Check if mouse is leaving the document/window
      if (e.clientY <= 0 || e.clientX <= 0 || 
          e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        setCursorPosition(null)
        setIsMouseOverCanvas(false)
      }
    }

    document.addEventListener('mouseleave', handleDocumentMouseLeave)
    document.addEventListener('mouseout', handleDocumentMouseLeave)
    
    return () => {
      document.removeEventListener('mouseleave', handleDocumentMouseLeave)
      document.removeEventListener('mouseout', handleDocumentMouseLeave)
    }
  }, [])

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Check if the dragged item contains files
    const hasFiles = e.dataTransfer.types.includes('Files')
    if (hasFiles) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Only hide drag over state if we're leaving the container entirely
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      const isOutside = e.clientX < rect.left || e.clientX > rect.right || 
                       e.clientY < rect.top || e.clientY > rect.bottom
      if (isOutside) {
        setIsDragOver(false)
      }
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    if (!sessionId || isUploading) return

    const files = Array.from(e.dataTransfer.files)
    const imageFile = files.find(file => file.type.startsWith('image/'))
    
    if (!imageFile) return

    // Validate the file
    const validation = validateImageFile(imageFile)
    if (!validation.valid) {
      console.error('Invalid file:', validation.error)
      return
    }

    setIsUploading(true)

    try {
      const result = await uploadImageFile(
        imageFile,
        {
          sessionId,
          userId: currentUser.id,
          canvasWidth: dimensions.width || 800,
          canvasHeight: dimensions.height || 600,
          onImageUploaded,
        },
        generateUploadUrl,
        uploadImage
      )

      if (!result.success) {
        console.error('Upload failed:', result.error)
      }
    } catch (error) {
      console.error('Drag and drop upload error:', error)
    } finally {
      setIsUploading(false)
    }
  }, [sessionId, isUploading, currentUser.id, dimensions, onImageUploaded, generateUploadUrl, uploadImage])

  // Clipboard paste handler: allow when over canvas or toolbox and when AI modal not open
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (!sessionId || isUploading) return;

      // Block if AI modal is open
      try {
        if (isAIModalOpen) return;
      } catch {}

      // Allow paste if mouse is over canvas or toolbox
      if (!isMouseOverCanvas && !isMouseOverToolbox) return;

      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }

      const dt = e.clipboardData;
      if (!dt) return;

      const items = Array.from(dt.items || []);
      const imageItem = items.find(it => it.type && it.type.startsWith('image/'));
      if (!imageItem) return;

      const file = imageItem.getAsFile();
      if (!file) return;

      e.preventDefault();

      const ext = (file.type?.split('/')[1] || 'png').toLowerCase();
      const filename = file.name && file.name.trim().length > 0 ? file.name : `pasted-image-${Date.now()}.${ext}`;

      let fileWithName: File;
      try {
        fileWithName = new File([file], filename, { type: file.type || 'image/png' });
      } catch {
        (file as any).name = filename;
        fileWithName = file as File;
      }

      const validation = validateImageFile(fileWithName);
      if (!validation.valid) {
        console.error('Invalid pasted image:', validation.error);
        return;
      }

      setIsUploading(true);
      try {
        const result = await uploadImageFile(
          fileWithName,
          {
            sessionId,
            userId: currentUser.id,
            canvasWidth: dimensions.width || 800,
            canvasHeight: dimensions.height || 600,
            onImageUploaded,
          },
          generateUploadUrl,
          uploadImage
        );
        if (!result.success) {
          console.error('Pasted image upload failed:', result.error);
        }
      } catch (err) {
        console.error('Clipboard paste upload error:', err);
      } finally {
        setIsUploading(false);
      }
    };

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [
    sessionId,
    isUploading,
    isMouseOverCanvas,
    isMouseOverToolbox,
    isAIModalOpen,
    currentUser.id,
    dimensions.width,
    dimensions.height,
    onImageUploaded,
    generateUploadUrl,
    uploadImage,
  ]);

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
      // console.warn('KonvaCanvas.undo() is deprecated. Use session-level undo instead.')
    },
    getImageData: () => {
      const stage = stageRef.current
      if (!stage) {
        return ''
      }
      
      try {
        // Determine export pixel ratio based on the most downscaled visible image
        const imgScales: number[] = []
        if (images && Array.isArray(images)) {
          images.forEach((img: any) => {
            if (img && typeof img.scale === 'number' && (img.opacity === undefined || img.opacity > 0)) {
              imgScales.push(img.scale)
            }
          })
        }
        if (aiImages && Array.isArray(aiImages)) {
          aiImages.forEach((img: any) => {
            if (img && typeof img.scale === 'number' && (img.opacity === undefined || img.opacity > 0)) {
              imgScales.push(img.scale)
            }
          })
        }
        const minScale = imgScales.length ? Math.min(...imgScales) : 1
        // Export at native pixels of the smallest-scaled image; never downscale
        const exportPixelRatio = Math.max(1, (minScale > 0 && isFinite(minScale)) ? (1 / minScale) : 1)

        // Ensure latest render before capture
        stage.batchDraw()
        
        // Render stage to high-res canvas
        const stageCanvas = stage.toCanvas({ pixelRatio: exportPixelRatio })
        
        // Create a temporary canvas with white background at the export size
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = stageCanvas.width
        tempCanvas.height = stageCanvas.height
        const tempCtx = tempCanvas.getContext('2d')
        
        if (tempCtx) {
          // Fill with white background (avoid transparent PNG checkerboard look)
          tempCtx.fillStyle = 'white'
          tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height)
          
          // Draw the stage content on top
          tempCtx.drawImage(stageCanvas, 0, 0)
          
          // Return PNG data URL
          return tempCanvas.toDataURL('image/png')
        }
        
        // Fallback to Konva direct export
        return stage.toDataURL({ 
          pixelRatio: exportPixelRatio,
          mimeType: 'image/png'
        })
      } catch {
        return ''
      }
    },
    getDimensions: () => {
      // If dimensions haven't been set yet, try to get them from the container
      if (dimensions.width === 0 || dimensions.height === 0) {
        if (containerRef.current) {
          const { clientWidth, clientHeight } = containerRef.current
          return { width: clientWidth || 800, height: clientHeight || 600 }
        }
      }
      return dimensions
    },
    forceRedraw: () => {
      // Force redraw all layers
      // console.log('[KonvaCanvas] forceRedraw called')
      strokeLayerRef.current?.batchDraw()
      imageLayerRef.current?.batchDraw()
      aiImageLayerRef.current?.batchDraw()
      drawingLayerRef.current?.batchDraw()
      
      // Also force update stage
      if (stageRef.current) {
        stageRef.current.batchDraw()
      }
    },
  }), [dimensions, images, aiImages])

  // Find layer info
  const getLayerInfo = (layerId: string) => {
    return layers.find(l => l.id === layerId) || null
  }

  // Attach transformer to active layer node when in transform mode
  useEffect(() => {
    const transformer = transformerRef.current
    const stage = stageRef.current
    if (!transformer || !stage) return
    if (selectedTool !== 'transform' || !activeLayerId) {
      transformer.nodes([])
      stage.batchDraw()
      return
    }

    // Determine node by layer type
    const activeLayer = layers.find(l => l.id === activeLayerId)
    let node: Konva.Node | undefined
    if (activeLayer?.type === 'paint') {
      node = paintGroupRefs.current.get(activeLayerId)
    } else if (activeLayer?.type === 'image') {
      node = imageNodeRefs.current.get(activeLayerId)
    } else if (activeLayer?.type === 'ai-image') {
      node = aiImageNodeRefs.current.get(activeLayerId)
    }
    if (node) {
      transformer.nodes([node])
      transformer.getLayer()?.batchDraw()
    } else {
      transformer.nodes([])
      stage.batchDraw()
    }
  }, [selectedTool, activeLayerId, layers, images, aiImages])

  // Helper: map stage point to active paint layer local coordinates
  const toActivePaintLayerLocal = useCallback((pt: Point): Point => {
    if (!activeLayerId) return pt
    const activeLayer = layers.find(l => l.id === activeLayerId)
    if (!activeLayer || activeLayer.type !== 'paint') return pt
    const node = paintGroupRefs.current.get(activeLayerId)
    const stage = stageRef.current
    if (!node || !stage) return pt
    const abs = node.getAbsoluteTransform().copy()
    abs.invert()
    const p = abs.point({ x: pt.x, y: pt.y })
    return { x: p.x, y: p.y, pressure: pt.pressure }
  }, [activeLayerId, layers])

  // Enforce correct layer ordering when layers change
  useEffect(() => {
    // Wait a bit for all layers to be rendered
    const timer = setTimeout(() => {
      const stage = stageRef.current
      if (!stage) return
      
      // Log current layer state
      // console.log('[KonvaCanvas] Checking layer order after change:', {
      //   layerCount: layers.length,
      //   layers: layers.map(l => ({ 
      //     id: l.id, 
      //     type: l.type, 
      //     order: l.order,
      //     name: l.name 
      //   })).sort((a, b) => a.order - b.order)
      // })
      
      // Force a redraw
      stage.batchDraw()
    }, 100)
    
    return () => clearTimeout(timer)
  }, [layers])

  return (
    <div 
      ref={containerRef} 
      className={`relative w-full h-full transition-all duration-200 ${
        isDragOver ? 'ring-4 ring-blue-400 ring-opacity-50 bg-blue-50/20' : ''
      }`}
      onMouseEnter={() => setIsMouseOverCanvas(true)}
      onMouseLeave={() => {
        setIsMouseOverCanvas(false)
        setCursorPosition(null)
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag and drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-500/10 border-4 border-dashed border-blue-400 flex items-center justify-center z-40 pointer-events-none">
          <div className="bg-white/90 backdrop-blur-sm rounded-lg p-6 text-center shadow-lg">
            <div className="text-2xl mb-2">📁</div>
            <div className="text-lg font-semibold text-gray-800">Drop image here</div>
            <div className="text-sm text-gray-600">PNG, JPG, GIF, WebP • Max 5MB</div>
          </div>
        </div>
      )}

      {/* Upload progress overlay */}
      {isUploading && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 text-center shadow-lg">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <div className="text-lg font-semibold text-gray-800">Uploading image...</div>
          </div>
        </div>
      )}

      {/* Debug overlay to show layer order */}
      {process.env.NODE_ENV === 'development' && shouldShowAdminFeatures() && (
        <div className="absolute top-2 right-2 bg-black/80 text-white text-xs p-2 z-50 rounded">
          <div className="font-bold mb-1">Layer Render Order:</div>
          {layers
            .sort((a, b) => a.order - b.order)
            .map((layer, idx) => (
              <div key={layer.id} className="flex items-center gap-2">
                <span className="text-gray-400">{idx}:</span>
                <span className={layer.type === 'paint' ? 'text-blue-400' : layer.type === 'ai-image' ? 'text-purple-400' : 'text-green-400'}>
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
        {/* Content layers render first; transformer should be above them */}
        {/* Render layers in order */}
        {layers
          .sort((a, b) => a.order - b.order)
          .map((layer, renderIndex) => {
            if (!layer.visible) return null
            
            // Debug logging for layer order issues
            // console.log(`[KonvaCanvas] Rendering layer ${renderIndex}:`, {
            //   id: layer.id,
            //   type: layer.type,
            //   name: layer.name,
            //   order: layer.order,
            //   visible: layer.visible,
            //   opacity: layer.opacity,
            //   isPaintLayer: layer.type === 'paint',
            //   isAILayer: layer.type === 'ai-image'
            // })

            // Paint layer
            if (layer.type === 'paint') {
              // Read transform for this paint layer (defaults center + identity)
              const paintLayer = paintLayersData?.find((pl: any) => pl._id === layer.id)
              const plX = paintLayer?.x ?? dimensions.width / 2
              const plY = paintLayer?.y ?? dimensions.height / 2
              const plScaleX = (paintLayer as any)?.scaleX ?? paintLayer?.scale ?? 1
              const plScaleY = (paintLayer as any)?.scaleY ?? paintLayer?.scale ?? 1
              const plRotation = paintLayer?.rotation ?? 0
              // Filter strokes for this specific paint layer
              const layerStrokes = strokes.filter(stroke => stroke.layerId === layer.id)
              // console.log('[KonvaCanvas] Paint layer strokes:', {
              //   layerId: layer.id,
              //   totalStrokes: strokes.length,
              //   layerStrokes: layerStrokes.length,
              //   eraserStrokes: layerStrokes.filter(s => s.isEraser).length,
              //   paintStrokes: layerStrokes.filter(s => !s.isEraser).length
              // })
              
              // console.log('[KonvaCanvas] Rendering paint layer:', {
              //   layerId: layer.id,
              //   layerType: layer.type,
              //   allStrokesCount: strokes.length,
              //   layerStrokesCount: layerStrokes.length,
              //   firstStrokeLayerId: strokes[0]?.layerId,
              //   strokesWithoutLayerId: strokes.filter(s => !s.layerId).length,
              //   strokesWithLayerId: strokes.filter(s => s.layerId).length,
              //   activeLayerId,
              //   isDrawing,
              //   currentStrokeLength: currentStroke.length,
              //   willRenderCurrentStroke: isDrawing && currentStroke.length > 0 && layer.id === activeLayerId,
              //   eraserStrokes: layerStrokes.filter(s => s.isEraser).length
              // })
                
              // Debug: Log when rendering paint layer
              // console.log('[KonvaCanvas] Rendering paint layer with strokes:', {
              //   layerId: layer.id,
              //   strokeCount: layerStrokes.length,
              //   opacity: layer.opacity,
              //   renderIndex,
              //   totalLayersCount: layers.length
              // })
              
              return (
                <Layer 
                  key={layer.id} 
                  ref={strokeLayerRef} 
                  listening={selectedTool === 'transform'} 
                  opacity={layer.opacity}
                >
                  <Group
                    ref={(node) => {
                      if (node) paintGroupRefs.current.set(layer.id, node)
                      else paintGroupRefs.current.delete(layer.id)
                    }}
                    x={plX}
                    y={plY}
                    rotation={plRotation}
                    scaleX={plScaleX}
                    scaleY={plScaleY}
                    draggable={selectedTool === 'transform'}
                    dragCursor={"url('/cursors/move.svg') 12 12, grabbing"}
                    onDragEnd={async (e) => {
                      const node = e.target as Konva.Group
                      await updatePaintLayerTransform({
                        layerId: layer.id as any,
                        x: node.x(),
                        y: node.y(),
                      })
                    }}
                    onTransformEnd={async (e) => {
                      const node = e.target as Konva.Group
                      const newScaleX = node.scaleX()
                      const newScaleY = node.scaleY()
                      const newRotation = node.rotation()
                      await updatePaintLayerTransform({
                        layerId: layer.id as any,
                        scaleX: newScaleX,
                        scaleY: newScaleY,
                        rotation: newRotation,
                        x: node.x(),
                        y: node.y(),
                      } as any)
                      // Do not reset node scale here; let controlled props re-render with persisted values
                    }}
                    onTransformStart={() => {
                      const tr = transformerRef.current
                      const active = tr?.getActiveAnchor?.()
                      const isCorner = active === 'top-left' || active === 'top-right' || active === 'bottom-left' || active === 'bottom-right'
                      tr?.setAttr('keepRatio', !!isCorner)
                    }}
                  >
                  {/* Render confirmed strokes */}
                  {layerStrokes
                    .sort((a, b) => a.strokeOrder - b.strokeOrder)
                    .map((stroke) => {
                      const { pathData, strokePoints } = getStrokePathData({
                        points: stroke.points,
                        color: stroke.brushColor,
                        size: stroke.brushSize,
                        opacity: stroke.opacity,
                        isPending: false,
                        colorMode: stroke.colorMode,
                      })
                      
                      if (!pathData) return null
                      
                      // console.log('[KonvaCanvas] Rendering stroke:', {
                      //   strokeId: stroke._id,
                      //   isEraser: stroke.isEraser,
                      //   layerId: stroke.layerId,
                      //   strokeOrder: stroke.strokeOrder
                      // })
                      
                      return <StrokePath key={stroke._id} stroke={stroke} pathData={pathData} />
                    })}
                  
                  {/* Render pending strokes (only those targeting this paint layer) */}
                  {Array.from(pendingStrokes.values()).filter(ps => ps.targetLayerId === layer.id).map((pendingStroke) => {
                    if (pendingStroke.colorMode === 'rainbow' && !pendingStroke.isEraser && pendingStroke.points.length >= 2) {
                      // Render rainbow pending stroke
                      const segments: React.ReactElement[] = []
                      const SEGMENT_LENGTH = 15
                      const SEGMENT_OVERLAP = 5
                      
                      let totalDistanceTraveled = 0
                      let currentSegmentDistance = 0
                      let segmentStartIdx = 0
                      
                      for (let i = 1; i < pendingStroke.points.length; i++) {
                        const dx = pendingStroke.points[i].x - pendingStroke.points[i - 1].x
                        const dy = pendingStroke.points[i].y - pendingStroke.points[i - 1].y
                        const distance = Math.sqrt(dx * dx + dy * dy)
                        currentSegmentDistance += distance
                        totalDistanceTraveled += distance
                        
                        if (currentSegmentDistance >= SEGMENT_LENGTH - SEGMENT_OVERLAP || i === pendingStroke.points.length - 1) {
                          const segmentPoints = pendingStroke.points.slice(segmentStartIdx, i + 1)
                          
                          if (segmentPoints.length >= 2) {
                            const segmentMidDistance = totalDistanceTraveled - (currentSegmentDistance / 2)
                            const colorProgress = (segmentMidDistance / 200) % 1
                            const rainbowColor = getRainbowColor(colorProgress)
                            
                            const options = {
                              size: pendingStroke.size,
                              smoothing: 0.35,
                              thinning: 0.2,
                              streamline: 0.4,
                              easing: (t: number) => t,
                              start: { taper: 0, cap: true },
                              end: { taper: 0, cap: true },
                              last: i === pendingStroke.points.length - 1,
                            }
                            
                            const outlinePoints = getStroke(segmentPoints, options)
                            const pathData = getSvgPathFromStroke(outlinePoints)
                            
                            segments.push(
                              <Path
                                key={`${pendingStroke.id}-${segmentStartIdx}`}
                                data={pathData}
                                fill={rainbowColor}
                                opacity={pendingStroke.opacity || 1}
                              />
                            )
                          }
                          
                          segmentStartIdx = Math.max(0, i - 2)
                          currentSegmentDistance = SEGMENT_OVERLAP
                        }
                      }
                      return <React.Fragment key={pendingStroke.id}>{segments}</React.Fragment>
                    } else {
                      // Normal pending stroke
                      const { pathData } = getStrokePathData(pendingStroke)
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
                    }
                  })}
                  
                  {/* Render current stroke being drawn (including eraser) */}
                  {isDrawing && currentStroke.length > 0 && 
                    ((selectedTool === 'eraser' && layer.id === activeLayerId) || 
                     (selectedTool === 'brush' && (layer.id === activePaintLayerId || (!activePaintLayerId && layer.id === activeLayerId)))) && (() => {
                      const strokeResult = getStrokePathData({
                        points: currentStroke,
                        color,
                        size,
                        opacity,
                        isLive: true,
                        isEraser: selectedTool === 'eraser',
                        colorMode: selectedTool === 'eraser' ? 'solid' : colorMode,
                      })
                      
                      // For rainbow strokes during live drawing
                      if (colorMode === 'rainbow' && selectedTool === 'brush' && currentStroke.length >= 2) {
                        const segments: React.ReactElement[] = []
                        const SEGMENT_LENGTH = 15
                        const SEGMENT_OVERLAP = 5
                        
                        // Track total distance for proper color progression
                        let totalDistanceTraveled = 0
                        let currentSegmentDistance = 0
                        let segmentStartIdx = 0
                        
                        for (let i = 1; i < currentStroke.length; i++) {
                          const dx = currentStroke[i].x - currentStroke[i - 1].x
                          const dy = currentStroke[i].y - currentStroke[i - 1].y
                          const distance = Math.sqrt(dx * dx + dy * dy)
                          currentSegmentDistance += distance
                          totalDistanceTraveled += distance
                          
                          if (currentSegmentDistance >= SEGMENT_LENGTH - SEGMENT_OVERLAP || i === currentStroke.length - 1) {
                            const segmentPoints = currentStroke.slice(segmentStartIdx, i + 1)
                            
                            if (segmentPoints.length >= 2) {
                              const segmentMidDistance = totalDistanceTraveled - (currentSegmentDistance / 2)
                              const colorProgress = (segmentMidDistance / 200) % 1
                              const rainbowColor = getRainbowColor(colorProgress)
                              
                              const options = {
                                size,
                                smoothing: 0.35,
                                thinning: 0.2,
                                streamline: 0.4,
                                easing: (t: number) => t,
                                start: { taper: 0, cap: true },
                                end: { taper: 0, cap: true },
                                last: i === currentStroke.length - 1,
                              }
                              
                              const outlinePoints = getStroke(segmentPoints, options)
                              const pathData = getSvgPathFromStroke(outlinePoints)
                              
                              segments.push(
                                <Path
                                  key={`live-${segmentStartIdx}`}
                                  data={pathData}
                                  fill={rainbowColor}
                                  opacity={opacity}
                                  listening={false}
                                />
                              )
                            }
                            
                            segmentStartIdx = Math.max(0, i - 2)
                            currentSegmentDistance = SEGMENT_OVERLAP
                          }
                        }
                        return <>{segments}</>
                      }
                      
                      // Normal stroke
                      return (
                        <Path
                          data={strokeResult.pathData}
                          fill={selectedTool === 'eraser' ? '#000000' : color}
                          opacity={opacity}
                          listening={false}
                          globalCompositeOperation={selectedTool === 'eraser' ? 'destination-out' : 'source-over'}
                        />
                      )
                    })()
                  }
                  </Group>
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
                  listening={selectedTool === 'transform'} 
                  opacity={layer.opacity}
                >
                  <Group>
                    <KonvaImage
                      id={layer.id}
                      ref={(node) => {
                        if (node) imageNodeRefs.current.set(layer.id, node)
                        else imageNodeRefs.current.delete(layer.id)
                      }}
                      image={loadedImage}
                      x={image.x}
                      y={image.y}
                      width={image.width}
                      height={image.height}
                      rotation={image.rotation}
                      scaleX={(image as any).scaleX ?? image.scale}
                      scaleY={(image as any).scaleY ?? image.scale}
                      offsetX={image.width / 2}
                      offsetY={image.height / 2}
                      draggable={selectedTool === 'transform'}
                      dragCursor={"url('/cursors/move.svg') 12 12, grabbing"}
                      onDragEnd={async (e) => {
                        const node = e.target
                        await updateImageTransform({
                          imageId: layer.id as Id<"uploadedImages">,
                          x: node.x(),
                          y: node.y()
                        })
                      }}
                      onTransformEnd={async (e) => {
                        const node = e.target as Konva.Image
                        const newScaleX = node.scaleX()
                        const newScaleY = node.scaleY()
                        const newRotation = node.rotation()
                        await updateImageTransform({
                          imageId: layer.id as Id<"uploadedImages">,
                          scaleX: newScaleX,
                          scaleY: newScaleY,
                          rotation: newRotation,
                          x: node.x(),
                          y: node.y(),
                        } as any)
                        // Do not reset node scale here; let controlled props re-render with persisted values
                      }}
                      onTransformStart={() => {
                        const tr = transformerRef.current
                        const active = tr?.getActiveAnchor?.()
                        const isCorner = active === 'top-left' || active === 'top-right' || active === 'bottom-left' || active === 'bottom-right'
                        tr?.setAttr('keepRatio', !!isCorner)
                      }}
                    />
                    
                    {/* Render persisted strokes for this image layer */}
                    {strokes
                      .filter(s => s.layerId === layer.id)
                      .sort((a, b) => a.strokeOrder - b.strokeOrder)
                      .map((stroke) => {
                        const { pathData } = getStrokePathData({
                          points: stroke.points,
                          color: stroke.brushColor,
                          size: stroke.brushSize,
                          opacity: stroke.opacity,
                          isPending: false,
                          colorMode: stroke.colorMode,
                        })
                        if (!pathData) return null
                        return (
                          <Path
                            key={stroke._id}
                            data={pathData}
                            fill={stroke.isEraser ? '#000000' : stroke.brushColor}
                            opacity={stroke.opacity}
                            globalCompositeOperation={stroke.isEraser ? 'destination-out' : 'source-over'}
                          />
                        )
                      })}
                    
                    {/* Render pending strokes targeting this image layer */}
                    {Array.from(pendingStrokes.values()).filter(ps => ps.targetLayerId === layer.id).map((pendingStroke) => {
                      if (pendingStroke.colorMode === 'rainbow' && !pendingStroke.isEraser && pendingStroke.points.length >= 2) {
                        const segments: React.ReactElement[] = []
                        const SEGMENT_LENGTH = 15
                        const SEGMENT_OVERLAP = 5
                        let totalDistanceTraveled = 0
                        let currentSegmentDistance = 0
                        let segmentStartIdx = 0
                        for (let i = 1; i < pendingStroke.points.length; i++) {
                          const dx = pendingStroke.points[i].x - pendingStroke.points[i - 1].x
                          const dy = pendingStroke.points[i].y - pendingStroke.points[i - 1].y
                          const distance = Math.sqrt(dx * dx + dy * dy)
                          currentSegmentDistance += distance
                          totalDistanceTraveled += distance
                          if (currentSegmentDistance >= SEGMENT_LENGTH - SEGMENT_OVERLAP || i === pendingStroke.points.length - 1) {
                            const segmentPoints = pendingStroke.points.slice(segmentStartIdx, i + 1)
                            if (segmentPoints.length >= 2) {
                              const segmentMidDistance = totalDistanceTraveled - (currentSegmentDistance / 2)
                              const colorProgress = (segmentMidDistance / 200) % 1
                              const rainbowColor = getRainbowColor(colorProgress)
                              const options = {
                                size: pendingStroke.size,
                                smoothing: 0.35,
                                thinning: 0.2,
                                streamline: 0.4,
                                easing: (t: number) => t,
                                start: { taper: 0, cap: true },
                                end: { taper: 0, cap: true },
                                last: i === pendingStroke.points.length - 1,
                              }
                              const outlinePoints = getStroke(segmentPoints, options)
                              const pathData = getSvgPathFromStroke(outlinePoints)
                              segments.push(
                                <Path
                                  key={`${pendingStroke.id}-${segmentStartIdx}`}
                                  data={pathData}
                                  fill={rainbowColor}
                                  opacity={pendingStroke.opacity || 1}
                                />
                              )
                            }
                            segmentStartIdx = Math.max(0, i - 2)
                            currentSegmentDistance = SEGMENT_OVERLAP
                          }
                        }
                        return <React.Fragment key={pendingStroke.id}>{segments}</React.Fragment>
                      } else {
                        const { pathData } = getStrokePathData(pendingStroke)
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
                      }
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
                        }).pathData}
                        fill="#000000"
                        globalCompositeOperation="destination-out"
                      />
                    )}
                    {/* Render current brush stroke if painting this image layer */}
                    {isDrawing && currentStroke.length > 0 && selectedTool === 'brush' && activeLayerId === layer.id && (
                      <Path
                        data={getStrokePathData({
                          points: currentStroke,
                          color,
                          size,
                          opacity,
                          isLive: true,
                          isEraser: false,
                          colorMode,
                        }).pathData}
                        fill={color}
                        opacity={opacity}
                        globalCompositeOperation="source-over"
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
              
              return (
                <Layer 
                  key={layer.id} 
                  ref={layer.id === aiImages?.[0]?._id ? aiImageLayerRef : undefined} 
                  listening={selectedTool === 'transform'} 
                  opacity={layer.opacity}
                >
                  <Group>
                    <KonvaImage
                      id={layer.id}
                      ref={(node) => {
                        if (node) aiImageNodeRefs.current.set(layer.id, node)
                        else aiImageNodeRefs.current.delete(layer.id)
                      }}
                      image={loadedImage}
                      x={aiImage.x}
                      y={aiImage.y}
                      width={aiImage.width}
                      height={aiImage.height}
                      rotation={aiImage.rotation}
                      scaleX={(aiImage as any).scaleX ?? aiImage.scale}
                      scaleY={(aiImage as any).scaleY ?? aiImage.scale}
                      offsetX={aiImage.width / 2}
                      offsetY={aiImage.height / 2}
                      draggable={selectedTool === 'transform'}
                      dragCursor={"url('/cursors/move.svg') 12 12, grabbing"}
                      onDragEnd={async (e) => {
                        const node = e.target
                        await updateAIImageTransform({
                          imageId: layer.id as Id<"aiGeneratedImages">,
                          x: node.x(),
                          y: node.y()
                        })
                      }}
                      onTransformEnd={async (e) => {
                        const node = e.target as Konva.Image
                        const newScaleX = node.scaleX()
                        const newScaleY = node.scaleY()
                        const newRotation = node.rotation()
                        await updateAIImageTransform({
                          imageId: layer.id as Id<"aiGeneratedImages">,
                          scaleX: newScaleX,
                          scaleY: newScaleY,
                          rotation: newRotation,
                          x: node.x(),
                          y: node.y(),
                        } as any)
                        // Do not reset node scale here; let controlled props re-render with persisted values
                      }}
                      onTransformStart={() => {
                        const tr = transformerRef.current
                        const active = tr?.getActiveAnchor?.()
                        const isCorner = active === 'top-left' || active === 'top-right' || active === 'bottom-left' || active === 'bottom-right'
                        tr?.setAttr('keepRatio', !!isCorner)
                      }}
                    />
                    
                    {/* Render persisted strokes for this AI image layer */}
                    {strokes
                      .filter(s => s.layerId === layer.id)
                      .sort((a, b) => a.strokeOrder - b.strokeOrder)
                      .map((stroke) => {
                        const { pathData } = getStrokePathData({
                          points: stroke.points,
                          color: stroke.brushColor,
                          size: stroke.brushSize,
                          opacity: stroke.opacity,
                          isPending: false,
                          colorMode: stroke.colorMode,
                        })
                        if (!pathData) return null
                        return (
                          <Path
                            key={stroke._id}
                            data={pathData}
                            fill={stroke.isEraser ? '#000000' : stroke.brushColor}
                            opacity={stroke.opacity}
                            globalCompositeOperation={stroke.isEraser ? 'destination-out' : 'source-over'}
                          />
                        )
                      })}
                    
                    {/* Render pending strokes targeting this AI image layer */}
                    {Array.from(pendingStrokes.values()).filter(ps => ps.targetLayerId === layer.id).map((pendingStroke) => {
                      if (pendingStroke.colorMode === 'rainbow' && !pendingStroke.isEraser && pendingStroke.points.length >= 2) {
                        const segments: React.ReactElement[] = []
                        const SEGMENT_LENGTH = 15
                        const SEGMENT_OVERLAP = 5
                        let totalDistanceTraveled = 0
                        let currentSegmentDistance = 0
                        let segmentStartIdx = 0
                        for (let i = 1; i < pendingStroke.points.length; i++) {
                          const dx = pendingStroke.points[i].x - pendingStroke.points[i - 1].x
                          const dy = pendingStroke.points[i].y - pendingStroke.points[i - 1].y
                          const distance = Math.sqrt(dx * dx + dy * dy)
                          currentSegmentDistance += distance
                          totalDistanceTraveled += distance
                          if (currentSegmentDistance >= SEGMENT_LENGTH - SEGMENT_OVERLAP || i === pendingStroke.points.length - 1) {
                            const segmentPoints = pendingStroke.points.slice(segmentStartIdx, i + 1)
                            if (segmentPoints.length >= 2) {
                              const segmentMidDistance = totalDistanceTraveled - (currentSegmentDistance / 2)
                              const colorProgress = (segmentMidDistance / 200) % 1
                              const rainbowColor = getRainbowColor(colorProgress)
                              const options = {
                                size: pendingStroke.size,
                                smoothing: 0.35,
                                thinning: 0.2,
                                streamline: 0.4,
                                easing: (t: number) => t,
                                start: { taper: 0, cap: true },
                                end: { taper: 0, cap: true },
                                last: i === pendingStroke.points.length - 1,
                              }
                              const outlinePoints = getStroke(segmentPoints, options)
                              const pathData = getSvgPathFromStroke(outlinePoints)
                              segments.push(
                                <Path
                                  key={`${pendingStroke.id}-${segmentStartIdx}`}
                                  data={pathData}
                                  fill={rainbowColor}
                                  opacity={pendingStroke.opacity || 1}
                                />
                              )
                            }
                            segmentStartIdx = Math.max(0, i - 2)
                            currentSegmentDistance = SEGMENT_OVERLAP
                          }
                        }
                        return <React.Fragment key={pendingStroke.id}>{segments}</React.Fragment>
                      } else {
                        const { pathData } = getStrokePathData(pendingStroke)
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
                      }
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
                        }).pathData}
                        fill="#000000"
                        globalCompositeOperation="destination-out"
                      />
                    )}
                    {/* Render current brush stroke if painting this AI image layer */}
                    {isDrawing && currentStroke.length > 0 && selectedTool === 'brush' && activeLayerId === layer.id && (
                      <Path
                        data={getStrokePathData({
                          points: currentStroke,
                          color,
                          size,
                          opacity,
                          isLive: true,
                          isEraser: false,
                          colorMode,
                        }).pathData}
                        fill={color}
                        opacity={opacity}
                        globalCompositeOperation="source-over"
                      />
                    )}
                  </Group>
                </Layer>
              )
              }

              return null
            })}

          {/* Drawing layer for live strokes and cursors */}
          <Layer ref={drawingLayerRef} listening={false}>
            {/* Current stroke being drawn (only for non-eraser tools on non-paint layers) */}
            {isDrawing && currentStroke.length > 0 && selectedTool === 'brush' && 
              (() => {
                const activeLayer = layers.find(l => l.id === activeLayerId)
                return !activeLayer || (activeLayer.type !== 'paint' && activeLayer.type !== 'stroke')
              })() && (
              <Path
                data={getStrokePathData({
                  points: currentStroke,
                  color,
                  size,
                  opacity,
                  isLive: true,
                  colorMode,
                }).pathData}
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
              
              const { pathData } = getStrokePathData({
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
            {cursorPosition && isMouseOverCanvas && (selectedTool === 'brush' || selectedTool === 'eraser') && (
              colorMode === 'rainbow' && selectedTool === 'brush' ? (
                // Rainbow cursor for rainbow mode
                <Group x={cursorPosition.x} y={cursorPosition.y} listening={false}>
                  {/* Create rainbow ring using arc segments */}
                  {Array.from({ length: 12 }, (_, i) => {
                    const startAngle = (i * 30) * Math.PI / 180
                    const endAngle = ((i + 1) * 30) * Math.PI / 180
                    const color = getRainbowColor(i / 12)
                    
                    return (
                      <Arc
                        key={i}
                        angle={30}
                        rotation={i * 30}
                        innerRadius={size / 2 - 1}
                        outerRadius={size / 2}
                        fill={color}
                        opacity={0.8}
                      />
                    )
                  })}
                  {/* Semi-transparent center */}
                  <Circle
                    radius={size / 2 - 1}
                    fill="rgba(255, 255, 255, 0.1)"
                    listening={false}
                  />
                </Group>
              ) : (
                // Normal cursor
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
              )
            )}
          </Layer>
        {/* Shared transformer for transform tool (render on top for hit-testing) */}
        {selectedTool === 'transform' && (
          <Layer>
            <Transformer
              ref={transformerRef}
              rotateEnabled
              resizeEnabled
              padding={12}
              anchorSize={16}
              anchorCornerRadius={2}
              anchorStrokeWidth={2}
              rotateAnchorOffset={48}
              // Allow non-uniform by default; enforce uniform only for corner anchors
              keepRatio={false}
              enabledAnchors={["top-left","top-right","bottom-left","bottom-right","middle-right","middle-left","top-center","bottom-center"]}
              boundBoxFunc={(oldBox, newBox) => {
                const minSize = 10
                if (Math.abs(newBox.width) < minSize || Math.abs(newBox.height) < minSize) {
                  return oldBox
                }
                // If dragging a corner, enforce uniform scaling and lock motion to the uniform path
                try {
                  const tr = transformerRef.current
                  const active = tr?.getActiveAnchor?.()
                  const isCorner = active === 'top-left' || active === 'top-right' || active === 'bottom-left' || active === 'bottom-right'
                  if (isCorner) {
                    const ow = oldBox.width
                    const oh = oldBox.height
                    if (ow === 0 || oh === 0) return oldBox
                    const sW = newBox.width / ow
                    const sH = newBox.height / oh
                    if (!isFinite(sW) || !isFinite(sH)) return oldBox
                    // Choose magnitude that best matches intent and keep signs from newBox
                    const mag = Math.max(Math.abs(sW), Math.abs(sH))
                    const signW = Math.sign(newBox.width) || 1
                    const signH = Math.sign(newBox.height) || 1
                    const nw = signW * Math.abs(ow) * mag
                    const nh = signH * Math.abs(oh) * mag
                    // Do not override x/y; let Konva keep the opposite corner fixed
                    return { ...newBox, width: nw, height: nh }
                  }
                } catch {}
                return newBox
              }}
            />
          </Layer>
        )}
        </Stage>
      </div>
    )
}

export const KonvaCanvas = forwardRef(KonvaCanvasComponent)
KonvaCanvas.displayName = 'KonvaCanvas'
