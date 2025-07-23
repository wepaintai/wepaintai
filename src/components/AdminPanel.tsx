import React, { useState, useEffect, useRef } from 'react'

interface AdminPanelProps {
  size: number
  onSizeChange: (value: number) => void
  smoothing: number
  onSmoothingChange: (value: number) => void
  thinning: number
  onThinningChange: (value: number) => void
  streamline: number
  onStreamlineChange: (value: number) => void
  startTaper: number
  onStartTaperChange: (value: number) => void
  startCap: boolean
  onStartCapChange: (value: boolean) => void
  endTaper: number
  onEndTaperChange: (value: number) => void
  endCap: boolean
  onEndCapChange: (value: boolean) => void
  isVisible: boolean
  onClose: () => void
}

export const AdminPanel: React.FC<AdminPanelProps> = ({
  size, onSizeChange,
  smoothing, onSmoothingChange,
  thinning, onThinningChange,
  streamline, onStreamlineChange,
  startTaper, onStartTaperChange,
  startCap, onStartCapChange,
  endTaper, onEndTaperChange,
  endCap, onEndCapChange,
  isVisible,
  onClose,
}) => {
  const [position, setPosition] = useState({ x: 50, y: 50 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !panelRef.current) return
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      setPosition(prev => ({
        x: prev.x + dx,
        y: prev.y + dy,
      }))
      dragStartRef.current = { x: e.clientX, y: e.clientY }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only drag if clicking on the header
    if ((e.target as HTMLElement).closest('.admin-panel-header')) {
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY }
    }
  }
  
  const inputStyle = "w-full p-1 border border-gray-300 rounded text-sm"
  const labelStyle = "block text-xs font-medium text-gray-700 mb-0.5"

  if (!isVisible) return null

  return (
    <div
      ref={panelRef}
      className="absolute bg-white p-4 rounded-lg shadow-xl border border-gray-300 w-64 text-sm"
      style={{ top: `${position.y}px`, left: `${position.x}px`, cursor: isDragging ? 'grabbing' : 'default', zIndex: 1000 }}
      onMouseDown={handleMouseDown}
    >
      <div 
        className="admin-panel-header flex justify-between items-center mb-3 pb-2 border-b border-gray-200"
        style={{ cursor: 'grab' }}
      >
        <h3 className="text-base font-semibold">Admin Controls</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-lg">&times;</button>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="size" className={labelStyle}>Size: {size.toFixed(2)}</label>
          <input type="range" id="size" min="1" max="100" step="1" value={size} onChange={(e) => onSizeChange(parseFloat(e.target.value))} className="w-full" />
        </div>
        <div>
          <label htmlFor="smoothing" className={labelStyle}>Smoothing: {smoothing.toFixed(2)}</label>
          <input type="range" id="smoothing" min="0" max="1" step="0.01" value={smoothing} onChange={(e) => onSmoothingChange(parseFloat(e.target.value))} className="w-full" />
        </div>
        <div>
          <label htmlFor="thinning" className={labelStyle}>Thinning: {thinning.toFixed(2)}</label>
          <input type="range" id="thinning" min="-1" max="1" step="0.01" value={thinning} onChange={(e) => onThinningChange(parseFloat(e.target.value))} className="w-full" />
        </div>
        <div>
          <label htmlFor="streamline" className={labelStyle}>Streamline: {streamline.toFixed(2)}</label>
          <input type="range" id="streamline" min="0" max="1" step="0.01" value={streamline} onChange={(e) => onStreamlineChange(parseFloat(e.target.value))} className="w-full" />
        </div>
        <div>
          <label htmlFor="startTaper" className={labelStyle}>Start Taper: {startTaper.toFixed(2)}</label>
          <input type="range" id="startTaper" min="0" max="100" step="1" value={startTaper} onChange={(e) => onStartTaperChange(parseFloat(e.target.value))} className="w-full" />
        </div>
        <div className="flex items-center">
          <input type="checkbox" id="startCap" checked={startCap} onChange={(e) => onStartCapChange(e.target.checked)} className="mr-2" />
          <label htmlFor="startCap" className={labelStyle + " mb-0"}>Start Cap</label>
        </div>
        <div>
          <label htmlFor="endTaper" className={labelStyle}>End Taper: {endTaper.toFixed(2)}</label>
          <input type="range" id="endTaper" min="0" max="100" step="1" value={endTaper} onChange={(e) => onEndTaperChange(parseFloat(e.target.value))} className="w-full" />
        </div>
        <div className="flex items-center">
          <input type="checkbox" id="endCap" checked={endCap} onChange={(e) => onEndCapChange(e.target.checked)} className="mr-2" />
          <label htmlFor="endCap" className={labelStyle + " mb-0"}>End Cap</label>
        </div>
      </div>
    </div>
  )
}
