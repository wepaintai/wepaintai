import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { Canvas, CanvasRef } from './Canvas'
import { ToolPanel, Layer } from './ToolPanel'
import { AdminPanel } from './AdminPanel' // Import AdminPanel
import { SessionInfo } from './SessionInfo'
import { P2PStatus } from './P2PStatus'
import { P2PDebugPanel } from './P2PDebugPanel'
import { ImageUploadModal } from './ImageUploadModal'
import { AIGenerationModal } from './AIGenerationModal'
import { UserProfile } from './UserProfile'
import { usePaintingSession } from '../hooks/usePaintingSession'
import { useP2PPainting } from '../hooks/useP2PPainting'
import { useSessionImages } from '../hooks/useSessionImages'
import { shouldShowAdminFeatures } from '../utils/environment'
import { Id } from '../../convex/_generated/dataModel'
import { initP2PLogger } from '../lib/p2p-logger'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

export function PaintingView() {
  const canvasRef = useRef<CanvasRef>(null)
  const [color, setColor] = useState('#000000')
  const [size, setSize] = useState(20) // perfect-freehand: size
  const [opacity, setOpacity] = useState(1.0)

  // perfect-freehand options
  const [smoothing, setSmoothing] = useState(0.35)
  const [thinning, setThinning] = useState(0.2)
  const [streamline, setStreamline] = useState(0.4)
  const [startTaper, setStartTaper] = useState(0)
  const [startCap, setStartCap] = useState(true)
  const [endTaper, setEndTaper] = useState(0)
  const [endCap, setEndCap] = useState(true)
  // For simplicity, easing is kept constant for now.
  // If it needs to be dynamic, it requires a more complex state management.
  const easing = (t: number) => t

  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [sessionId, setSessionId] = useState<Id<"paintingSessions"> | null>(null)
  const [showImageUpload, setShowImageUpload] = useState(false)
  const [showAIGeneration, setShowAIGeneration] = useState(false)
  const [selectedTool, setSelectedTool] = useState('brush')
  // Check if admin features should be shown based on environment
  const adminFeaturesEnabled = shouldShowAdminFeatures()
  const [isAdminPanelVisible, setIsAdminPanelVisible] = useState(adminFeaturesEnabled)

  const { createNewSession, presence, currentUser, isLoading, clearSession, undoLastStroke, redoLastStroke, strokes } = usePaintingSession(sessionId)
  const addAIGeneratedImage = useMutation(api.images.addAIGeneratedImage)
  const updateAIImageTransform = useMutation(api.images.updateAIImageTransform)
  
  // Get images to find AI-generated ones
  const { images, updateImageTransform, deleteImage, changeLayerOrder } = useSessionImages(sessionId)
  const aiGeneratedImages = images.filter(img => (img as any).type === 'ai-generated')
  
  // Debug strokes from usePaintingSession
  useEffect(() => {
    console.log('[Layers] Strokes from usePaintingSession:', {
      strokesExist: !!strokes,
      strokesLength: strokes?.length,
      strokesIsArray: Array.isArray(strokes),
      strokesValue: strokes,
      sessionId,
      currentUser
    })
  }, [strokes, sessionId, currentUser])
  
  // Get AI generated images separately
  const aiImages = useQuery(api.images.getAIGeneratedImages, sessionId ? { sessionId } : 'skip')
  const updateAIImageTransformMutation = useMutation(api.images.updateAIImageTransform)
  const deleteAIImageMutation = useMutation(api.images.deleteAIImage)
  const updateAIImageLayerOrderMutation = useMutation(api.images.updateAIImageLayerOrder)
  
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

;

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
        } else {
          // Create new session
          const newSessionId = await createNewSession('Collaborative Painting', 800, 600)
          setSessionId(newSessionId)
          // Update URL with new session ID
          window.history.replaceState({}, '', `?session=${newSessionId}`)
        }
      } catch (error) {
        console.error('Failed to create/join session:', error)
      }
    }
    
    initSession()
  }, [createNewSession])

  const handleStrokeEnd = () => {
    // Save canvas state for undo/redo
    const imageData = canvasRef.current?.getImageData()
    if (imageData) {
      const newHistory = history.slice(0, historyIndex + 1)
      newHistory.push(imageData)
      setHistory(newHistory)
      setHistoryIndex(newHistory.length - 1)
    }
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
    }
  }

  const toggleAdminPanel = useCallback(() => {
    setIsAdminPanelVisible(prev => !prev)
  }, [])

  const handleImageUpload = useCallback(() => {
    setShowImageUpload(true)
  }, [])

  const handleImageUploaded = useCallback((imageId: Id<"uploadedImages">) => {
    console.log('Image uploaded:', imageId)
    setShowImageUpload(false)
    setSelectedTool('brush') // Switch back to brush tool
  }, [])

  const handleAIGenerate = useCallback(() => {
    setShowAIGeneration(true)
  }, [])

  const handleAIGenerationComplete = useCallback(async (imageUrl: string) => {
    if (!sessionId) return
    
    // Add the generated image to the canvas
    console.log('handleAIGenerationComplete called with URL:', imageUrl)
    console.log('URL type:', typeof imageUrl)
    console.log('URL length:', imageUrl.length)
    
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
        
        console.log('AI-generated image added to canvas')
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

  // Add keyboard listener for toggling admin panel (e.g., Ctrl+Shift+A) - only when admin features are enabled
  useEffect(() => {
    if (!adminFeaturesEnabled) return
    
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === 'A') {
        event.preventDefault()
        toggleAdminPanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [toggleAdminPanel, adminFeaturesEnabled])

  // Track painting layer visibility and order
  const [paintingLayerVisible, setPaintingLayerVisible] = useState(true)
  const [paintingLayerOrder, setPaintingLayerOrder] = useState(0)
  
  // Create layers from strokes and images
  const layers = useMemo<Layer[]>(() => {
    const allLayers: Layer[] = []
    
    // Add painting layer (all strokes combined)
    // Always show the painting layer, even if there are no strokes yet
    const hasStrokes = Array.isArray(strokes) && strokes.length > 0
    console.log('[Layers] Computing layers:', {
      strokesInMemo: strokes,
      strokesLength: strokes?.length,
      hasStrokes,
      isArray: Array.isArray(strokes)
    })
    allLayers.push({
      id: 'painting-layer',
      type: 'stroke',
      name: hasStrokes ? 'Painting' : 'Painting (empty)',
      visible: paintingLayerVisible,
      opacity: 1,
      order: paintingLayerOrder,
    })
    
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
        thumbnailUrl: img.url,
      })
    })
    
    // Add AI-generated images
    if (aiImages) {
      aiImages.forEach((img, index) => {
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
    
    return allLayers
  }, [strokes, images, aiImages, paintingLayerVisible, paintingLayerOrder])

  // Handle layer operations
  const handleLayerVisibilityChange = useCallback(async (layerId: string, visible: boolean) => {
    // Check if it's the painting layer
    if (layerId === 'painting-layer') {
      setPaintingLayerVisible(visible)
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
    // Check if it's the painting layer
    if (layerId === 'painting-layer') {
      // Clear all strokes
      await clearSession()
      return
    }
    
    // Check if it's an uploaded image
    const uploadedImage = images.find(img => img._id === layerId)
    if (uploadedImage) {
      await deleteImage(layerId as Id<"uploadedImages">)
      return
    }
    
    // Check if it's an AI image
    const aiImage = aiImages?.find(img => img._id === layerId)
    if (aiImage) {
      await deleteAIImageMutation({ imageId: layerId as Id<"aiGeneratedImages"> })
    }
  }, [images, aiImages, clearSession, deleteImage, deleteAIImageMutation])

  const handleLayerReorder = useCallback(async (layerId: string, newOrder: number) => {
    // Clamp newOrder to valid range
    const maxOrder = layers.length - 1
    const clampedOrder = Math.max(0, Math.min(newOrder, maxOrder))
    
    // Check if it's the painting layer
    if (layerId === 'painting-layer') {
      setPaintingLayerOrder(clampedOrder)
      // Force canvas redraw to reflect new layer order
      canvasRef.current?.forceRedraw?.()
      return
    }
    
    // Check if it's an uploaded image
    const uploadedImage = images.find(img => img._id === layerId)
    if (uploadedImage) {
      await changeLayerOrder(layerId as Id<"uploadedImages">, clampedOrder)
      return
    }
    
    // Check if it's an AI image
    const aiImage = aiImages?.find(img => img._id === layerId)
    if (aiImage) {
      await updateAIImageLayerOrderMutation({
        imageId: layerId as Id<"aiGeneratedImages">,
        newLayerOrder: clampedOrder
      })
    }
  }, [layers, images, aiImages, changeLayerOrder, updateAIImageLayerOrderMutation])

  const handleLayerOpacityChange = useCallback(async (layerId: string, opacity: number) => {
    // Check if it's the painting layer
    if (layerId === 'painting-layer') {
      // TODO: Implement painting layer opacity
      console.log('Painting layer opacity not yet implemented')
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

  return (
    <div className="relative w-full h-full bg-gray-50">
      {/* Button to toggle Admin Panel - only shown when admin features are enabled */}
      {adminFeaturesEnabled && (
        <button 
          onClick={toggleAdminPanel} 
          className="absolute top-2 right-28 z-50 bg-black/90 backdrop-blur-md border border-white/20 hover:bg-black/80 text-white font-bold py-1 px-2 rounded text-xs"
          title="Toggle Admin Panel (Ctrl+Shift+A)"
        >
          {isAdminPanelVisible ? 'Hide' : 'Show'} Admin
        </button>
      )}

      {sessionId ? (
        <Canvas
          ref={canvasRef}
          sessionId={sessionId}
          color={color}
          size={size}
          opacity={opacity}
          paintingLayerVisible={paintingLayerVisible}
          paintingLayerOrder={paintingLayerOrder}
          // perfect-freehand options
          smoothing={smoothing}
          thinning={thinning}
          streamline={streamline}
          easing={easing}
          startTaper={startTaper}
          startCap={startCap}
          endTaper={endTaper}
          endCap={endCap}
          onStrokeEnd={handleStrokeEnd}
        />
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
        onLayerVisibilityChange={handleLayerVisibilityChange}
        onLayerReorder={handleLayerReorder}
        onLayerDelete={handleLayerDelete}
        onLayerOpacityChange={handleLayerOpacityChange}
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
      {showAIGeneration && sessionId && (() => {
        // Capture canvas data when modal is shown
        const canvasData = canvasRef.current?.getImageData() || '';
        console.log('[PaintingView] Canvas ref exists:', !!canvasRef.current);
        console.log('[PaintingView] Canvas data for AI generation:', canvasData.substring(0, 100) + '...');
        console.log('[PaintingView] Canvas data length:', canvasData.length);
        console.log('[PaintingView] Canvas data is empty:', canvasData === '' || canvasData.length === 0);
        
        // If canvas data is empty, try to get it again after a short delay
        if (!canvasData || canvasData.length === 0) {
          console.error('[PaintingView] ERROR: Canvas data is empty!');
          setTimeout(() => {
            const retryData = canvasRef.current?.getImageData() || '';
            console.log('[PaintingView] Retry canvas data length:', retryData.length);
          }, 100);
        }
        
        const canvasDimensions = canvasRef.current?.getDimensions() || { width: 800, height: 600 };
        
        return (
          <AIGenerationModal
            isOpen={showAIGeneration}
            onClose={() => {
              setShowAIGeneration(false)
              setSelectedTool('brush')
            }}
            sessionId={sessionId}
            canvasDataUrl={canvasData}
            canvasWidth={canvasDimensions.width}
            canvasHeight={canvasDimensions.height}
            onGenerationComplete={handleAIGenerationComplete}
          />
        );
      })()}
      {/* Admin Panel - only rendered when admin features are enabled */}
      {adminFeaturesEnabled && (
        <AdminPanel
          isVisible={isAdminPanelVisible}
          onClose={toggleAdminPanel}
          size={size}
          onSizeChange={setSize}
          smoothing={smoothing}
          onSmoothingChange={setSmoothing}
          thinning={thinning}
          onThinningChange={setThinning}
          streamline={streamline}
          onStreamlineChange={setStreamline}
          startTaper={startTaper}
          onStartTaperChange={setStartTaper}
          startCap={startCap}
          onStartCapChange={setStartCap}
          endTaper={endTaper}
          onEndTaperChange={setEndTaper}
          endCap={endCap}
          onEndCapChange={setEndCap}
        />
      )}
      
      {/* User profile display */}
      <UserProfile />
    </div>
  )
}
