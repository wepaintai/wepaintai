import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { Canvas, CanvasRef } from './Canvas'
import { KonvaCanvas } from './KonvaCanvas'
import { ToolPanel, Layer } from './ToolPanel'
import { type BrushSettings } from './BrushSettingsModal'
import { AdminPanel } from './AdminPanel' // Import AdminPanel
import { SessionInfo } from './SessionInfo'
import { P2PStatus } from './P2PStatus'
import { P2PDebugPanel } from './P2PDebugPanel'
import { ImageUploadModal } from './ImageUploadModal'
import { AIGenerationModal } from './AIGenerationModal'
import { UserProfile } from './UserProfile'
import { TokenDisplay } from './TokenDisplay'
import { usePaintingSession } from '../hooks/usePaintingSession'
import { useP2PPainting } from '../hooks/useP2PPainting'
import { useSessionImages } from '../hooks/useSessionImages'
import { shouldShowAdminFeatures } from '../utils/environment'
import { Id } from '../../convex/_generated/dataModel'
import { initP2PLogger } from '../lib/p2p-logger'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useThumbnailGenerator } from '../hooks/useThumbnailGenerator'

// Wrapper component to handle canvas data capture with proper timing
function AIGenerationModalWrapper({ 
  sessionId, 
  canvasRef, 
  onClose, 
  onGenerationComplete,
  layers,
  strokes 
}: {
  sessionId: Id<"paintingSessions">
  canvasRef: React.RefObject<CanvasRef>
  onClose: () => void
  onGenerationComplete: (imageUrl: string) => void
  layers: Layer[]
  strokes: any[]
}) {
  const [canvasData, setCanvasData] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  
  useEffect(() => {
    // Check if we have any content to capture (strokes OR images)
    const hasStrokes = strokes && strokes.length > 0
    const hasImages = layers.some(layer => layer.type === 'image' || layer.type === 'ai-image')
    
    if (!hasStrokes && !hasImages) {
      // console.log('[AIGenerationModalWrapper] No content to capture (no strokes or images)')
      // Set a blank canvas data URL instead of staying in loading state
      setCanvasData('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
      setIsLoading(false)
      return
    }
    
    // Capture canvas data after a small delay to ensure layers are rendered
    const captureCanvas = () => {
      if (canvasRef.current) {
        // console.log('[AIGenerationModalWrapper] About to capture canvas data')
        // console.log('[AIGenerationModalWrapper] Layers available:', layers.length)
        // console.log('[AIGenerationModalWrapper] Strokes available:', strokes?.length || 0)
        // console.log('[AIGenerationModalWrapper] Has images:', layers.some(layer => layer.type === 'image' || layer.type === 'ai-image'))
        
        // Force canvas redraw before capturing
        canvasRef.current.forceRedraw()
        
        // Wait a bit after forcing redraw
        setTimeout(() => {
          if (canvasRef.current) {
            const data = canvasRef.current.getImageData() || ''
            const dims = canvasRef.current.getDimensions() || { width: 800, height: 600 }
            
            // console.log('[AIGenerationModalWrapper] Canvas data captured after redraw:', data.length)
            setCanvasData(data)
            setDimensions(dims)
            setIsLoading(false)
            
            // If still empty, try again after another delay
            if (!data || data.length === 0) {
              console.warn('[AIGenerationModalWrapper] Canvas data empty, retrying...')
              setTimeout(() => {
                const retryData = canvasRef.current?.getImageData() || ''
                if (retryData && retryData.length > 0) {
                  // console.log('[AIGenerationModalWrapper] Retry successful:', retryData.length)
                  setCanvasData(retryData)
                }
              }, 500)
            }
          }
        }, 200)
      }
    }
    
    // Initial delay to let canvas layers render
    const timer = setTimeout(captureCanvas, 500) // Increased delay
    return () => clearTimeout(timer)
  }, [canvasRef, strokes, layers]) // Add layers as dependency too
  
  return (
    <AIGenerationModal
      isOpen={true}
      onClose={onClose}
      sessionId={sessionId}
      canvasDataUrl={canvasData}
      canvasWidth={dimensions.width}
      canvasHeight={dimensions.height}
      onGenerationComplete={onGenerationComplete}
    />
  )
}

export function PaintingView() {
  const canvasRef = useRef<CanvasRef>(null)
  const [color, setColor] = useState('#000000')
  const [size, setSize] = useState(20) // perfect-freehand: size
  const [opacity, setOpacity] = useState(1.0)
  const [colorMode, setColorMode] = useState<'solid' | 'rainbow'>('solid')
  
  // Brush settings for perfect-freehand - load from localStorage if available
  const [brushSettings, setBrushSettings] = useState<BrushSettings>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('brushSettings')
      if (saved) {
        try {
          return JSON.parse(saved)
        } catch (e) {
          console.error('Failed to parse saved brush settings:', e)
        }
      }
    }
    return {
      smoothing: 0.75,
      thinning: 0.5,
      streamline: 0.95,
      startTaper: 0,
      endTaper: 0,
    }
  })
  
  // Feature flag to enable Konva canvas - can be toggled via environment variable or local storage
  const useKonvaCanvas = import.meta.env.VITE_USE_KONVA_CANVAS === 'true' || 
                        (typeof window !== 'undefined' && localStorage.getItem('useKonvaCanvas') === 'true')

  // Save brush settings to localStorage when they change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('brushSettings', JSON.stringify(brushSettings))
    }
  }, [brushSettings])

  // For simplicity, easing is kept constant for now.
  // If it needs to be dynamic, it requires a more complex state management.
  const easing = (t: number) => t
  // Cap settings are kept constant
  const startCap = true
  const endCap = true

  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [sessionId, setSessionId] = useState<Id<"paintingSessions"> | null>(null)
  const [showImageUpload, setShowImageUpload] = useState(false)
  const [showAIGeneration, setShowAIGeneration] = useState(false)
  const [selectedTool, setSelectedTool] = useState('brush')
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  // Check if admin features should be shown based on environment
  const adminFeaturesEnabled = shouldShowAdminFeatures()
  const [isAdminPanelVisible, setIsAdminPanelVisible] = useState(adminFeaturesEnabled)

  const { createNewSession, presence, currentUser, isLoading, clearSession, undoLastStroke, redoLastStroke, strokes } = usePaintingSession(sessionId)
  const addAIGeneratedImage = useMutation(api.images.addAIGeneratedImage)
  const updateAIImageTransform = useMutation(api.images.updateAIImageTransform)
  
  // Get images to find AI-generated ones
  const { images, updateImageTransform, deleteImage, changeLayerOrder } = useSessionImages(sessionId)
  const aiGeneratedImages = images.filter(img => (img as any).type === 'ai-generated')
  
  // Paint layer mutations
  const updatePaintLayerOrder = useMutation(api.paintLayer.updatePaintLayerOrder)
  const updatePaintLayerVisibility = useMutation(api.paintLayer.updatePaintLayerVisibility)
  
  // Thumbnail generation
  const { generateNow: generateThumbnail } = useThumbnailGenerator({
    sessionId: sessionId || undefined,
    canvasRef,
    interval: 30000, // Generate thumbnail every 30 seconds
    enabled: !!sessionId
  })
  const paintLayerSettings = useQuery(api.paintLayer.getPaintLayerSettings, sessionId ? { sessionId } : 'skip')
  
  // Multiple paint layers support
  const paintLayers = useQuery(api.paintLayers.getPaintLayers, sessionId ? { sessionId } : 'skip')
  const createPaintLayer = useMutation(api.paintLayers.createPaintLayer)
  const updatePaintLayer = useMutation(api.paintLayers.updatePaintLayer)
  const deletePaintLayer = useMutation(api.paintLayers.deletePaintLayer)
  const ensureDefaultPaintLayer = useMutation(api.paintLayers.ensureDefaultPaintLayer)
  const [activePaintLayerId, setActivePaintLayerId] = useState<string | null>(null)
  
  // Unified layer reordering
  const reorderLayer = useMutation(api.layers.reorderLayer)
  
  // Debug: Log both image sources
  // useEffect(() => {
  //   console.log('[PaintingView] Images from useSessionImages:', images)
  //   console.log('[PaintingView] AI images filtered from images:', aiGeneratedImages)
  // }, [images, aiGeneratedImages])
  
  // Debug strokes from usePaintingSession
  useEffect(() => {
    // console.log('[Layers] Strokes from usePaintingSession:', {
    //   strokesExist: !!strokes,
    //   strokesLength: strokes?.length,
    //   strokesIsArray: Array.isArray(strokes),
    //   strokesValue: strokes,
    //   sessionId,
    //   currentUser
    // })
  }, [strokes, sessionId, currentUser])
  
  // Get AI generated images separately
  const aiImages = useQuery(api.images.getAIGeneratedImages, sessionId ? { sessionId } : 'skip')
  const updateAIImageTransformMutation = useMutation(api.images.updateAIImageTransform)
  const deleteAIImageMutation = useMutation(api.images.deleteAIImage)
  const updateAIImageLayerOrderMutation = useMutation(api.images.updateAIImageLayerOrder)
  
  // Debug: Log aiImages from direct query
  useEffect(() => {
    // console.log('[PaintingView] AI images from direct query:', aiImages)
  }, [aiImages])
  
  // P2P connection status
  const { 
    isConnected: isP2PConnected, 
    connectionMode, 
    metrics: p2pMetrics,
    remoteStrokes 
  } = useP2PPainting({
    sessionId,
    userId: currentUser.id ? currentUser.id.toString() : currentUser.name, // Convert ID to string
    enabled: !!currentUser.id, // Only enable when user is created
  })

  // Initialize P2P logger in development
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      initP2PLogger();
    }
  }, []);

  // Ensure default paint layer exists
  useEffect(() => {
    if (sessionId && paintLayers !== undefined) {
      if (!paintLayers || paintLayers.length === 0) {
        ensureDefaultPaintLayer({ sessionId })
      }
    }
  }, [sessionId, paintLayers, ensureDefaultPaintLayer])

  // Set active paint layer when layers are loaded
  useEffect(() => {
    if (paintLayers && paintLayers.length > 0 && !activePaintLayerId) {
      setActivePaintLayerId(paintLayers[0]._id)
    }
  }, [paintLayers, activePaintLayerId])

  // Create a new session or join existing one on mount
  useEffect(() => {
    const initSession = async () => {
      try {
        // Check if there's a session ID in the URL
        const urlParams = new URLSearchParams(window.location.search)
        const existingSessionId = urlParams.get('session') as Id<"paintingSessions"> | null
        
        if (existingSessionId) {
          // Join existing session
          setSessionId(existingSessionId)
        } else if (createNewSession) {
          // Create new session only if createNewSession is available
          // console.log('[PaintingView] Creating new session...')
          const newSessionId = await createNewSession('Collaborative Painting', 800, 600)
          // console.log('[PaintingView] New session created:', newSessionId)
          if (newSessionId) {
            setSessionId(newSessionId)
            // Update URL with new session ID
            window.history.replaceState({}, '', `?session=${newSessionId}`)
          }
        }
      } catch (error) {
        console.error('Failed to create/join session:', error)
        // Don't set a fallback session ID - let the UI handle the loading state
      }
    }
    
    // Only run if we don't have a session yet
    if (sessionId === null) {
      initSession()
    }
  }, [createNewSession, sessionId])

  const handleStrokeEnd = () => {
    // Save canvas state for undo/redo
    const imageData = canvasRef.current?.getImageData()
    if (imageData) {
      const newHistory = history.slice(0, historyIndex + 1)
      newHistory.push(imageData)
      setHistory(newHistory)
      setHistoryIndex(newHistory.length - 1)
    }
    
    // Generate thumbnail after stroke ends
    setTimeout(() => {
      // console.log('[PaintingView] Triggering thumbnail generation after stroke')
      generateThumbnail()
    }, 1000)
  }

  const handleUndo = async () => {
    try {
      await undoLastStroke()
    } catch (error) {
      console.error('Failed to undo stroke:', error)
    }
  }

  const handleRedo = async () => {
    try {
      await redoLastStroke()
    } catch (error) {
      console.error('Failed to redo stroke:', error)
    }
  }

  const handleClear = async () => {
    // Clear local canvas immediately for responsiveness
    canvasRef.current?.clear()
    setHistory([])
    setHistoryIndex(-1)
    
    // Clear the session in the backend
    try {
      await clearSession()
    } catch (error) {
      console.error('Failed to clear session:', error)
    }
  }

  const handleExport = () => {
    const imageData = canvasRef.current?.getImageData()
    if (imageData) {
      const link = document.createElement('a')
      link.download = `wepaintai-${Date.now()}.png`
      link.href = imageData
      link.click()
      
      // Generate thumbnail after export
      generateThumbnail()
    }
  }

  const toggleAdminPanel = useCallback(() => {
    setIsAdminPanelVisible(prev => !prev)
  }, [])

  const handleImageUpload = useCallback(() => {
    setShowImageUpload(true)
  }, [])

  const handleImageUploaded = useCallback((imageId: Id<"uploadedImages">) => {
    // console.log('Image uploaded:', imageId)
    setShowImageUpload(false)
    setSelectedTool('brush') // Switch back to brush tool
  }, [])

  const handleAIGenerate = useCallback(() => {
    setShowAIGeneration(true)
  }, [])

  const handleAIGenerationComplete = useCallback(async (imageUrl: string) => {
    if (!sessionId) return
    
    // Add the generated image to the canvas
    // console.log('handleAIGenerationComplete called with URL:', imageUrl)
    // console.log('URL type:', typeof imageUrl)
    // console.log('URL length:', imageUrl.length)
    
    // Create an image element to get dimensions
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    img.onload = async () => {
      try {
        // Get canvas dimensions
        const canvasDimensions = canvasRef.current?.getDimensions() || { width: 800, height: 600 }
        
        // Add the AI-generated image to Convex
        await addAIGeneratedImage({
          sessionId,
          imageUrl,
          width: img.width,
          height: img.height,
          canvasWidth: canvasDimensions.width,
          canvasHeight: canvasDimensions.height,
        })
        
        // console.log('AI-generated image added to canvas')
        setShowAIGeneration(false)
        setSelectedTool('brush')
      } catch (error) {
        console.error('Failed to add AI-generated image:', error)
      }
    }
    
    img.onerror = (e) => {
      console.error('Failed to load generated image from URL:', imageUrl)
      console.error('Error event:', e)
      setShowAIGeneration(false)
      setSelectedTool('brush')
    }
    
    img.src = imageUrl
  }, [sessionId, addAIGeneratedImage])

  const handleToolChange = useCallback((tool: string) => {
    setSelectedTool(tool)
    if (tool === 'upload') {
      handleImageUpload()
    }
  }, [handleImageUpload])

  // Add keyboard listeners for tool shortcuts and admin panel
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if we're typing in an input field
      const isInputField = event.target instanceof Element && 
                          ['INPUT', 'TEXTAREA'].includes(event.target.tagName)
      
      // Undo/Redo shortcuts
      if ((event.ctrlKey || event.metaKey) && !isInputField) {
        if (event.key === 'z' && !event.shiftKey) {
          event.preventDefault()
          handleUndo()
          return
        } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
          event.preventDefault()
          handleRedo()
          return
        }
      }
      
      // Tool shortcuts (when not typing in an input field)
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !isInputField) {
        switch (event.key.toLowerCase()) {
          case 'b':
            event.preventDefault()
            setSelectedTool('brush')
            break
          case 'e':
            event.preventDefault()
            setSelectedTool('eraser')
            break
          case 'h':
            event.preventDefault()
            setSelectedTool('pan')
            break
          case 'u':
            event.preventDefault()
            setSelectedTool('upload')
            handleImageUpload()
            break
          case 'g':
            event.preventDefault()
            setSelectedTool('ai')
            handleAIGenerate()
            break
          case 'i':
            event.preventDefault()
            setSelectedTool('inpaint')
            break
        }
      }
      
      // Admin panel toggle (Ctrl+Shift+A) - only when admin features are enabled
      if (adminFeaturesEnabled && event.ctrlKey && event.shiftKey && event.key === 'A') {
        event.preventDefault()
        toggleAdminPanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [toggleAdminPanel, adminFeaturesEnabled, handleImageUpload, handleAIGenerate, handleUndo, handleRedo])

  // Use persisted paint layer settings or defaults
  const paintingLayerVisible = paintLayerSettings?.visible ?? true
  const paintingLayerOrder = paintLayerSettings?.layerOrder ?? 0
  
  // Create layers from strokes and images
  const layers = useMemo(() => {
    const allLayers: Layer[] = []
    
    // Add paint layers - there should always be at least one
    if (paintLayers && paintLayers.length > 0) {
      paintLayers.forEach((paintLayer) => {
        allLayers.push({
          id: paintLayer._id,
          type: 'paint',
          name: paintLayer.name,
          visible: paintLayer.visible,
          opacity: paintLayer.opacity,
          order: paintLayer.layerOrder,
        })
      })
    }
    
    // Add uploaded images
    const uploadedImages = images.filter(img => !(img as any).type || (img as any).type === 'uploaded')
    uploadedImages.forEach((img, index) => {
      allLayers.push({
        id: img._id,
        type: 'image',
        name: `Upload ${index + 1}`,
        visible: img.opacity > 0,
        opacity: img.opacity,
        order: img.layerOrder,
        thumbnailUrl: img.url || undefined,
      })
    })
    
    // Add AI-generated images
    if (aiImages) {
      // console.log('[Layers] Adding AI images to layers:', aiImages.length)
      aiImages.forEach((img, index) => {
        // console.log('[Layers] AI image:', img._id, img)
        // console.log('[Layers] AI image layerOrder:', img.layerOrder)
        allLayers.push({
          id: img._id,
          type: 'ai-image',
          name: `AI Image ${index + 1}`,
          visible: img.opacity > 0,
          opacity: img.opacity,
          order: img.layerOrder,
          thumbnailUrl: img.imageUrl,
        })
      })
    }
    
    // Debug: Log all layers with their orders
    // console.log('[Layers] All layers computed:', allLayers.map(l => ({
    //   id: l.id,
    //   type: l.type,
    //   name: l.name,
    //   order: l.order
    // })))
    
    return allLayers
  }, [strokes, images, aiImages, paintingLayerVisible, paintingLayerOrder, paintLayers])

  // Update activeLayerId when layers change (especially important for new sessions)
  useEffect(() => {
    // If no active layer is set and we have layers, select the first paint layer
    if (!activeLayerId && layers.length > 0) {
      const firstPaintLayer = layers.find(l => l.type === 'paint')
      if (firstPaintLayer) {
        console.log('[PaintingView] Setting initial activeLayerId to:', firstPaintLayer.id)
        setActiveLayerId(firstPaintLayer.id)
        setActivePaintLayerId(firstPaintLayer.id)
      }
    }
  }, [layers, activeLayerId])

  // Handle layer operations
  const handleLayerVisibilityChange = useCallback(async (layerId: string, visible: boolean) => {
    // Check if it's a paint layer
    const paintLayer = paintLayers?.find(layer => layer._id === layerId)
    if (paintLayer) {
      await updatePaintLayer({ layerId: layerId as any, visible })
      // Force canvas redraw
      canvasRef.current?.forceRedraw?.()
      return
    }
    
    // Check if it's an uploaded image
    const uploadedImage = images.find(img => img._id === layerId)
    if (uploadedImage) {
      await updateImageTransform(layerId as Id<"uploadedImages">, {
        opacity: visible ? 1 : 0
      })
      return
    }
    
    // Check if it's an AI image
    const aiImage = aiImages?.find(img => img._id === layerId)
    if (aiImage) {
      await updateAIImageTransformMutation({
        imageId: layerId as Id<"aiGeneratedImages">,
        opacity: visible ? 1 : 0
      })
    }
  }, [images, aiImages, updateImageTransform, updateAIImageTransformMutation])

  const handleLayerDelete = useCallback(async (layerId: string) => {
    // console.log('[PaintingView] handleLayerDelete called with layerId:', layerId)
    // console.log('[PaintingView] Available paint layers:', paintLayers)
    // console.log('[PaintingView] Available layers:', layers)
    
    // Check if it's a paint layer
    const paintLayer = paintLayers?.find(layer => layer._id === layerId)
    // console.log('[PaintingView] Found paint layer:', paintLayer)
    if (paintLayer) {
      // Prevent deleting the last paint layer
      const paintLayersCount = paintLayers?.length || 0
      if (paintLayersCount <= 1) {
        console.log('[PaintingView] Cannot delete the last paint layer')
        return
      }
      
      // console.log('[PaintingView] Deleting paint layer:', layerId)
      try {
        await deletePaintLayer({ layerId: layerId as Id<"paintLayers"> })
        // console.log('[PaintingView] Paint layer deleted successfully')
      } catch (error) {
        console.error('[PaintingView] Error deleting paint layer:', error)
      }
      return
    }
    
    // Check if it's an uploaded image (not AI-generated)
    const uploadedImage = images.find(img => img._id === layerId && (img as any).type !== 'ai-generated')
    if (uploadedImage) {
      // console.log('[PaintingView] Deleting uploaded image:', layerId)
      await deleteImage(layerId as Id<"uploadedImages">)
      return
    }
    
    // Check if it's an AI image (either in aiImages or in images with type 'ai-generated')
    const aiImageFromQuery = aiImages?.find(img => img._id === layerId)
    const aiImageFromImages = images.find(img => img._id === layerId && (img as any).type === 'ai-generated')
    const aiImage = aiImageFromQuery || aiImageFromImages
    
    // console.log('[PaintingView] AI images from query:', aiImages)
    // console.log('[PaintingView] Found AI image from query:', aiImageFromQuery)
    // console.log('[PaintingView] Found AI image from images:', aiImageFromImages)
    
    if (aiImage) {
      // console.log('[PaintingView] Deleting AI image:', layerId)
      try {
        await deleteAIImageMutation({ imageId: layerId as Id<"aiGeneratedImages"> })
        // console.log('[PaintingView] AI image deleted successfully')
      } catch (error) {
        console.error('[PaintingView] Error deleting AI image:', error)
      }
    } else {
      console.warn('[PaintingView] Layer not found for deletion:', layerId)
    }
  }, [images, aiImages, paintLayers, clearSession, deleteImage, deletePaintLayer, deleteAIImageMutation])

  const handleLayerReorder = useCallback(async (layerId: string, newOrder: number) => {
    if (!sessionId) return
    
    // Clamp newOrder to valid range
    const maxOrder = layers.length - 1
    const clampedOrder = Math.max(0, Math.min(newOrder, maxOrder))
    
    // Use the unified reorderLayer mutation
    await reorderLayer({
      sessionId,
      layerId,
      newOrder: clampedOrder
    })
    
    // Force canvas redraw to reflect new layer order
    canvasRef.current?.forceRedraw?.()
  }, [sessionId, layers, reorderLayer])

  const handleLayerOpacityChange = useCallback(async (layerId: string, opacity: number) => {
    // Check if it's a paint layer
    const paintLayer = paintLayers?.find(layer => layer._id === layerId)
    if (paintLayer) {
      await updatePaintLayer({ layerId: layerId as any, opacity })
      // Force canvas redraw
      canvasRef.current?.forceRedraw?.()
      return
    }
    
    // Check if it's an uploaded image
    const uploadedImage = images.find(img => img._id === layerId)
    if (uploadedImage) {
      await updateImageTransform(layerId as Id<"uploadedImages">, { opacity })
      return
    }
    
    // Check if it's an AI image
    const aiImage = aiImages?.find(img => img._id === layerId)
    if (aiImage) {
      await updateAIImageTransformMutation({
        imageId: layerId as Id<"aiGeneratedImages">,
        opacity
      })
    }
  }, [images, aiImages, updateImageTransform, updateAIImageTransformMutation])

  // Handle creating new paint layer
  const handleCreatePaintLayer = useCallback(async () => {
    if (!sessionId) return
    
    // Generate a name for the new layer
    const paintLayerCount = paintLayers?.filter(l => l.name.startsWith('Layer')).length || 0
    const newLayerName = `Layer ${paintLayerCount + 2}` // +2 because we already have Layer 1
    
    const layerId = await createPaintLayer({ sessionId, name: newLayerName })
    
    // Set the new layer as active
    if (layerId) {
      setActivePaintLayerId(layerId)
    }
  }, [sessionId, paintLayers, createPaintLayer])

  return (
    <div className="relative w-full h-full bg-gray-50">
      {/* Button to toggle Admin Panel - only shown when admin features are enabled */}
      {adminFeaturesEnabled && (
        <>
          <button 
            onClick={toggleAdminPanel} 
            className="absolute top-2 right-28 z-50 bg-black/90 backdrop-blur-md border border-white/20 hover:bg-black/80 text-white font-bold py-1 px-2 rounded text-xs"
            title="Toggle Admin Panel (Ctrl+Shift+A)"
          >
            {isAdminPanelVisible ? 'Hide' : 'Show'} Admin
          </button>
          
          {/* Canvas implementation toggle - only in development */}
          {process.env.NODE_ENV === 'development' && (
            <button
              onClick={() => {
                const newValue = !useKonvaCanvas
                localStorage.setItem('useKonvaCanvas', String(newValue))
                window.location.reload()
              }}
              className="absolute top-2 right-2 z-50 bg-purple-600/90 backdrop-blur-md border border-white/20 hover:bg-purple-700/80 text-white font-bold py-1 px-2 rounded text-xs"
              title="Toggle between Canvas implementations"
            >
              {useKonvaCanvas ? 'Konva' : 'Canvas'} Mode
            </button>
          )}
        </>
      )}

      {sessionId ? (
        useKonvaCanvas ? (
          <KonvaCanvas
            ref={canvasRef}
            sessionId={sessionId}
            color={color}
            size={size}
            opacity={opacity}
            colorMode={colorMode}
            layers={layers}
            selectedTool={selectedTool}
            activeLayerId={activeLayerId}
            activePaintLayerId={activePaintLayerId}
            // perfect-freehand options
            smoothing={brushSettings.smoothing}
            thinning={brushSettings.thinning}
            streamline={brushSettings.streamline}
            easing={easing}
            startTaper={brushSettings.startTaper}
            startCap={startCap}
            endTaper={brushSettings.endTaper}
            endCap={endCap}
            onStrokeEnd={handleStrokeEnd}
          />
        ) : (
          <Canvas
            ref={canvasRef}
            sessionId={sessionId}
            color={color}
            size={size}
            opacity={opacity}
            colorMode={colorMode}
            layers={layers}
            activePaintLayerId={activePaintLayerId}
            // perfect-freehand options
            smoothing={brushSettings.smoothing}
            thinning={brushSettings.thinning}
            streamline={brushSettings.streamline}
            easing={easing}
            startTaper={brushSettings.startTaper}
            startCap={startCap}
            endTaper={brushSettings.endTaper}
            endCap={endCap}
            onStrokeEnd={handleStrokeEnd}
          />
        )
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Creating painting session...</p>
          </div>
        </div>
      )}
      {adminFeaturesEnabled && (
        <SessionInfo
          sessionId={sessionId}
          userCount={presence.length + 1}
          currentUser={currentUser}
        />
      )}
      {adminFeaturesEnabled && (
        <P2PStatus
          isConnected={isP2PConnected}
          connectionMode={connectionMode}
          metrics={p2pMetrics}
          className="absolute bottom-2 left-2 z-10"
        />
      )}
      {/* Debug panel - only in development and when admin features are enabled */}
      {process.env.NODE_ENV === 'development' && adminFeaturesEnabled && (
        <P2PDebugPanel
          isConnected={isP2PConnected}
          connectionMode={connectionMode}
          metrics={p2pMetrics}
          remoteStrokesCount={remoteStrokes.size}
        />
      )}
      <ToolPanel
        color={color}
        size={size}
        opacity={opacity}
        onColorChange={setColor}
        onSizeChange={setSize}
        onOpacityChange={setOpacity}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClear={handleClear}
        onExport={handleExport}
        onImageUpload={handleImageUpload}
        onAIGenerate={handleAIGenerate}
        selectedTool={selectedTool}
        onToolChange={handleToolChange}
        layers={layers}
        activeLayerId={activeLayerId}
        onActiveLayerChange={(layerId) => {
          setActiveLayerId(layerId)
          // If a paint layer is selected, update the active paint layer
          const layer = layers.find(l => l.id === layerId)
          if (layer && layer.type === 'paint') {
            setActivePaintLayerId(layerId)
          }
        }}
        onLayerVisibilityChange={handleLayerVisibilityChange}
        onLayerReorder={handleLayerReorder}
        onLayerDelete={handleLayerDelete}
        onLayerOpacityChange={handleLayerOpacityChange}
        onCreatePaintLayer={handleCreatePaintLayer}
        colorMode={colorMode}
        onColorModeChange={setColorMode}
        brushSettings={brushSettings}
        onBrushSettingsChange={setBrushSettings}
      />
      {showImageUpload && (
        <ImageUploadModal
          sessionId={sessionId}
          userId={currentUser.id}
          onImageUploaded={handleImageUploaded}
          onClose={() => {
            setShowImageUpload(false)
            setSelectedTool('brush')
          }}
          canvasWidth={canvasRef.current?.getDimensions().width}
          canvasHeight={canvasRef.current?.getDimensions().height}
        />
      )}
      {showAIGeneration && sessionId && (
        <AIGenerationModalWrapper
          sessionId={sessionId}
          canvasRef={canvasRef as React.RefObject<CanvasRef>}
          onClose={() => {
            setShowAIGeneration(false)
            setSelectedTool('brush')
          }}
          onGenerationComplete={handleAIGenerationComplete}
          layers={layers}
          strokes={strokes}
        />
      )}
      {/* Admin Panel - only rendered when admin features are enabled */}
      {adminFeaturesEnabled && (
        <AdminPanel
          isVisible={isAdminPanelVisible}
          onClose={toggleAdminPanel}
          size={size}
          onSizeChange={setSize}
          smoothing={brushSettings.smoothing}
          onSmoothingChange={(value) => setBrushSettings(prev => ({ ...prev, smoothing: value }))}
          thinning={brushSettings.thinning}
          onThinningChange={(value) => setBrushSettings(prev => ({ ...prev, thinning: value }))}
          streamline={brushSettings.streamline}
          onStreamlineChange={(value) => setBrushSettings(prev => ({ ...prev, streamline: value }))}
          startTaper={brushSettings.startTaper}
          onStartTaperChange={(value) => setBrushSettings(prev => ({ ...prev, startTaper: value }))}
          startCap={startCap}
          onStartCapChange={() => {}} // Cap settings are constant for now
          endTaper={brushSettings.endTaper}
          onEndTaperChange={(value) => setBrushSettings(prev => ({ ...prev, endTaper: value }))}
          endCap={endCap}
          onEndCapChange={() => {}} // Cap settings are constant for now
        />
      )}
      
      {/* User profile display - only show if admin features are enabled */}
      {adminFeaturesEnabled && <UserProfile />}
    </div>
  )
}
