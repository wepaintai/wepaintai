import React, { useRef, useState, useEffect, useCallback } from 'react'
import { Canvas, CanvasRef } from './Canvas'
import { ToolPanel } from './ToolPanel'
import { AdminPanel } from './AdminPanel' // Import AdminPanel
import { SessionInfo } from './SessionInfo'
import { usePaintingSession } from '../hooks/usePaintingSession'
import { shouldShowAdminFeatures } from '../utils/environment'
import { Id } from '../../convex/_generated/dataModel'

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
  // Check if admin features should be shown based on environment
  const adminFeaturesEnabled = shouldShowAdminFeatures()
  const [isAdminPanelVisible, setIsAdminPanelVisible] = useState(adminFeaturesEnabled)

  const { createNewSession, presence, currentUser, isLoading, clearSession } = usePaintingSession(sessionId)

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

  const handleUndo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1)
      // TODO: Implement restore from history
    } else {
      canvasRef.current?.undo()
    }
  }

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1)
      // TODO: Implement restore from history
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
      link.download = `ipaintai-${Date.now()}.png`
      link.href = imageData
      link.click()
    }
  }

  const toggleAdminPanel = useCallback(() => {
    setIsAdminPanelVisible(prev => !prev)
  }, [])

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
      />
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
