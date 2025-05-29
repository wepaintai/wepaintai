import React, { useRef, useState, useEffect } from 'react'
import { Canvas, CanvasRef } from './Canvas'
import { ToolPanel } from './ToolPanel'
import { SessionInfo } from './SessionInfo'
import { usePaintingSession } from '../hooks/usePaintingSession'
import { Id } from '../../convex/_generated/dataModel'

export function PaintingView() {
  const canvasRef = useRef<CanvasRef>(null)
  const [color, setColor] = useState('#000000')
  const [size, setSize] = useState(20)
  const [opacity, setOpacity] = useState(1.0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [sessionId, setSessionId] = useState<Id<"paintingSessions"> | null>(null)

  const { createNewSession, presence, currentUser, isLoading } = usePaintingSession(sessionId)

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

  const handleClear = () => {
    canvasRef.current?.clear()
    setHistory([])
    setHistoryIndex(-1)
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

  return (
    <div className="relative w-full h-full bg-gray-50">
      {sessionId ? (
        <Canvas
          ref={canvasRef}
          sessionId={sessionId}
          color={color}
          size={size}
          opacity={opacity}
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
    </div>
  )
}
