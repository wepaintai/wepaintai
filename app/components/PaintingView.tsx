import React, { useRef, useState, useEffect, useCallback } from 'react'
import { Canvas, CanvasRef } from './Canvas'
import { ToolPanel } from './ToolPanel'
import { AdminPanel } from './AdminPanel' // Import AdminPanel
import { SessionInfo } from './SessionInfo'
import { P2PStatus } from './P2PStatus'
import { P2PDebugPanel } from './P2PDebugPanel'
import { ImageUploadModal } from './ImageUploadModal'
import { AIGenerationModal } from './AIGenerationModal'
import { usePaintingSession } from '../hooks/usePaintingSession'
import { useP2PPainting } from '../hooks/useP2PPainting'
import { useSessionImages } from '../hooks/useSessionImages'
import { shouldShowAdminFeatures } from '../utils/environment'
import { Id } from '../../convex/_generated/dataModel'
import { initP2PLogger } from '../lib/p2p-logger'
import { useMutation } from 'convex/react'
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
  const [aiImageOpacity, setAIImageOpacity] = useState(1)
  const [showAIImage, setShowAIImage] = useState(true)
  const [hasInitializedAIOpacity, setHasInitializedAIOpacity] = useState(false)
  // Check if admin features should be shown based on environment
  const adminFeaturesEnabled = shouldShowAdminFeatures()
  const [isAdminPanelVisible, setIsAdminPanelVisible] = useState(adminFeaturesEnabled)

  const { createNewSession, presence, currentUser, isLoading, clearSession, undoLastStroke, redoLastStroke } = usePaintingSession(sessionId)
  const addAIGeneratedImage = useMutation(api.images.addAIGeneratedImage)
  const updateAIImageTransform = useMutation(api.images.updateAIImageTransform)
  
  // Get images to find AI-generated ones
  const { images } = useSessionImages(sessionId)
  const aiGeneratedImages = images.filter(img => (img as any).type === 'ai-generated')
  
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

  // Update AI image opacity when toggle changes
  useEffect(() => {
    // Skip the first run to avoid setting opacity to 0 on initial load
    if (!hasInitializedAIOpacity && aiGeneratedImages.length > 0) {
      setHasInitializedAIOpacity(true)
      return
    }
    
    const updateOpacity = async () => {
      for (const aiImage of aiGeneratedImages) {
        try {
          // Check if it's an AI-generated image and use the appropriate mutation
          if ((aiImage as any).type === 'ai-generated') {
            await updateAIImageTransform({
              imageId: aiImage._id as Id<"aiGeneratedImages">,
              opacity: showAIImage ? aiImageOpacity : 0
            })
          }
        } catch (error) {
          console.error('Failed to update AI image opacity:', error, aiImage)
        }
      }
    }
    
    if (aiGeneratedImages.length > 0 && hasInitializedAIOpacity) {
      updateOpacity()
    }
  }, [showAIImage, aiImageOpacity, aiGeneratedImages, updateAIImageTransform, hasInitializedAIOpacity]);

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

  return (
    <div className="relative w-full h-full bg-gray-50">
      {/* AI Image Toggle - shown when there are AI images */}
      {aiGeneratedImages.length > 0 && (
        <div className="absolute top-2 right-40 z-50 flex items-center gap-2">
          <button 
            onClick={() => setShowAIImage(!showAIImage)} 
            className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-1 px-2 rounded text-xs"
            title="Toggle AI image visibility"
          >
            {showAIImage ? 'Hide' : 'Show'} AI
          </button>
          {showAIImage && (
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={aiImageOpacity}
              onChange={(e) => setAIImageOpacity(parseFloat(e.target.value))}
              className="w-20 h-4"
              title={`AI image opacity: ${Math.round(aiImageOpacity * 100)}%`}
            />
          )}
        </div>
      )}

      {/* Button to toggle Admin Panel - only shown when admin features are enabled */}
      {adminFeaturesEnabled && (
        <button 
          onClick={toggleAdminPanel} 
          className="absolute top-2 right-28 z-50 bg-blue-500 hover:bg-blue-700 text-white font-bold py-1 px-2 rounded text-xs"
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
      <SessionInfo
        sessionId={sessionId}
        userCount={presence.length + 1}
        currentUser={currentUser}
      />
      <P2PStatus
        isConnected={isP2PConnected}
        connectionMode={connectionMode}
        metrics={p2pMetrics}
        className="absolute bottom-2 left-2 z-10"
      />
      {/* Debug panel - only in development */}
      {process.env.NODE_ENV === 'development' && (
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
    </div>
  )
}
