import React, { useRef, useState } from 'react'
import { Canvas, CanvasRef } from './Canvas'
import { ToolPanel } from './ToolPanel'

export function PaintingView() {
  const canvasRef = useRef<CanvasRef>(null)
  const [color, setColor] = useState('#000000')
  const [size, setSize] = useState(20)
  const [opacity, setOpacity] = useState(1.0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

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
      <Canvas
        ref={canvasRef}
        color={color}
        size={size}
        opacity={opacity}
        onStrokeEnd={handleStrokeEnd}
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
