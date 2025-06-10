import React from 'react'
import {
  Paintbrush,
  RotateCcw,
  FolderOpen,
  Save,
  Palette,
  Undo2,
  Redo2,
  X,
  ChevronUp,
  Circle,
  Eye,
  Pipette,
  ImagePlus,
  Sparkles
} from 'lucide-react'

// Types
interface ToolPanelProps {
  color: string
  size: number
  opacity: number
  onColorChange: (color: string) => void
  onSizeChange: (size: number) => void
  onOpacityChange: (opacity: number) => void
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  onExport: () => void
  onImageUpload?: () => void
  onAIGenerate?: () => void
  selectedTool?: string
  onToolChange?: (tool: string) => void
}

interface Tool {
  id: string
  icon: React.ElementType
  label: string
  ariaLabel: string
  keyboardShortcut?: string
}

interface SliderProps {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  icon: React.ElementType
  label: string
  color: string
}

// Tool definitions
const tools: Tool[] = [
  { id: 'brush', icon: Paintbrush, label: 'Brush', ariaLabel: 'Select brush tool', keyboardShortcut: 'B' },
  { id: 'upload', icon: ImagePlus, label: 'Upload', ariaLabel: 'Upload image', keyboardShortcut: 'U' },
  { id: 'ai', icon: Sparkles, label: 'AI', ariaLabel: 'AI Generation', keyboardShortcut: 'G' },
  { id: 'rotate', icon: RotateCcw, label: 'Rotate', ariaLabel: 'Rotate canvas', keyboardShortcut: 'R' },
  { id: 'inpaint', icon: Palette, label: 'Inpaint', ariaLabel: 'Inpaint tool', keyboardShortcut: 'I' },
]

// Slider component for better reusability
const Slider = React.memo(({ value, min, max, onChange, icon: Icon, label, color }: SliderProps) => {
  // Normalize value for display
  const normalizedValue = ((value - min) / (max - min)) * 100
  
  return (
    <div className="flex items-center gap-2 mb-3" role="group" aria-labelledby={`${label.toLowerCase()}-slider-label`}>
      <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
      <div className="relative flex-1 h-6 flex items-center">
        <div 
          className="h-1 w-full bg-secondary rounded-full overflow-hidden"
          role="presentation"
        >
          <div
            className="h-full transition-all duration-100"
            style={{ width: `${normalizedValue}%`, backgroundColor: color }}
          />
        </div>
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full pointer-events-none"
          style={{ 
            left: `calc(${normalizedValue}% - 6px)`, 
            backgroundColor: color 
          }}
          role="presentation"
        />
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-labelledby={`${label.toLowerCase()}-slider-label`}
        />
        <span id={`${label.toLowerCase()}-slider-label`} className="sr-only">{label} slider</span>
      </div>
    </div>
  )
})

Slider.displayName = 'Slider'

// Tool button component
const ToolButton = React.memo(({ 
  tool, 
  isSelected, 
  onClick 
}: { 
  tool: Tool, 
  isSelected: boolean, 
  onClick: () => void 
}) => (
  <button
    key={tool.id}
    onClick={onClick}
    className={`w-8 h-8 flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
      isSelected 
        ? 'bg-gray-200 text-gray-900' 
        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
    }`}
    title={`${tool.label}${tool.keyboardShortcut ? ` (${tool.keyboardShortcut})` : ''}`}
    aria-label={tool.ariaLabel}
    aria-pressed={isSelected}
  >
    <tool.icon className={`w-4 h-4 ${isSelected ? 'scale-110 transition-transform' : ''}`} />
  </button>
))

ToolButton.displayName = 'ToolButton'

// Action button component
const ActionButton = React.memo(({ 
  icon: Icon, 
  label, 
  onClick, 
  isPrimary = false 
}: { 
  icon: React.ElementType, 
  label: string, 
  onClick: () => void, 
  isPrimary?: boolean 
}) => (
  <button
    onClick={onClick}
    className={`w-8 h-8 flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
      isPrimary 
        ? 'bg-primary text-primary-foreground hover:bg-primary/90' 
        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
    }`}
    title={label}
    aria-label={label}
  >
    <Icon className="w-4 h-4" />
  </button>
))

ActionButton.displayName = 'ActionButton'

// Color Mixer component
const ColorMixer = React.memo(({ 
  color, 
  onColorChange 
}: { 
  color: string, 
  onColorChange: (color: string) => void 
}) => {
  const colorInputRef = React.useRef<HTMLInputElement>(null)
  
  const handleColorClick = () => {
    colorInputRef.current?.click()
  }
  
  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onColorChange(e.target.value)
  }
  
  return (
    <div className="flex items-center gap-2 mb-3" role="group" aria-labelledby="color-mixer-label">
      <Pipette className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
      <button
        onClick={handleColorClick}
        className="flex-1 h-6 border border-border rounded transition-all duration-100 hover:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        style={{ backgroundColor: color }}
        title="Click to change color"
        aria-label="Current brush color, click to change"
      >
        <span className="sr-only">Current color: {color}</span>
      </button>
      <input
        ref={colorInputRef}
        type="color"
        value={color}
        onChange={handleColorChange}
        className="sr-only"
        aria-label="Color picker"
      />
      <span id="color-mixer-label" className="sr-only">Color mixer</span>
    </div>
  )
})

ColorMixer.displayName = 'ColorMixer'

// Main ToolPanel component
export function ToolPanel({
  color,
  size,
  opacity,
  onColorChange,
  onSizeChange,
  onOpacityChange,
  onUndo,
  onRedo,
  onClear,
  onExport,
  onImageUpload,
  onAIGenerate,
  selectedTool: externalSelectedTool,
  onToolChange,
}: ToolPanelProps) {
  const [internalSelectedTool, setInternalSelectedTool] = React.useState('brush')
  const selectedTool = externalSelectedTool || internalSelectedTool
  const [isCollapsed, setIsCollapsed] = React.useState(false)
  
  // Drag functionality state
  const [isDragging, setIsDragging] = React.useState(false)
  const [position, setPosition] = React.useState({ x: 24, y: 200 })
  const [dragOffset, setDragOffset] = React.useState({ x: 0, y: 0 })
  const panelRef = React.useRef<HTMLDivElement>(null)

  // Initialize position based on window size after component mounts
  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      setPosition({ x: 24, y: window.innerHeight / 2 - 150 })
    }
  }, [])

  // Handle drag start
  const handleDragStart = React.useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    setIsDragging(true)
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    
    if (panelRef.current) {
      const rect = panelRef.current.getBoundingClientRect()
      setDragOffset({
        x: clientX - rect.left,
        y: clientY - rect.top
      })
    }
  }, [])

  // Handle drag move
  const handleDragMove = React.useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging) return
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    
    const newX = clientX - dragOffset.x
    const newY = clientY - dragOffset.y
    
    // Keep panel within viewport bounds
    const maxX = window.innerWidth - (panelRef.current?.offsetWidth || 200)
    const maxY = window.innerHeight - (panelRef.current?.offsetHeight || 300)
    
    setPosition({
      x: Math.max(0, Math.min(newX, maxX)),
      y: Math.max(0, Math.min(newY, maxY))
    })
  }, [isDragging, dragOffset])

  // Handle drag end
  const handleDragEnd = React.useCallback(() => {
    setIsDragging(false)
  }, [])

  // Add event listeners for drag
  React.useEffect(() => {
    if (isDragging) {
      const handleMouseMove = (e: MouseEvent) => handleDragMove(e)
      const handleMouseUp = () => handleDragEnd()
      const handleTouchMove = (e: TouchEvent) => handleDragMove(e)
      const handleTouchEnd = () => handleDragEnd()

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.addEventListener('touchmove', handleTouchMove, { passive: false })
      document.addEventListener('touchend', handleTouchEnd)

      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
      }
    }
  }, [isDragging, handleDragMove, handleDragEnd])

  // Update position when window resizes
  React.useEffect(() => {
    const handleResize = () => {
      const maxX = window.innerWidth - (panelRef.current?.offsetWidth || 200)
      const maxY = window.innerHeight - (panelRef.current?.offsetHeight || 300)
      
      setPosition(prev => ({
        x: Math.max(0, Math.min(prev.x, maxX)),
        y: Math.max(0, Math.min(prev.y, maxY))
      }))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Handle tool selection
  const handleToolSelect = React.useCallback((toolId: string) => {
    // For upload tool, don't change the selected tool state
    // It will be handled by the parent component after upload/cancel
    if (toolId === 'upload' && onImageUpload) {
      onImageUpload()
      return
    }
    
    // For AI tool, trigger AI generation
    if (toolId === 'ai' && onAIGenerate) {
      onAIGenerate()
      return
    }
    
    if (onToolChange) {
      onToolChange(toolId)
    } else {
      setInternalSelectedTool(toolId)
    }
  }, [onToolChange, onImageUpload, onAIGenerate])

  // Keyboard shortcuts for tools
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }
      
      const key = e.key.toUpperCase()
      const tool = tools.find(t => t.keyboardShortcut === key)
      
      if (tool) {
        handleToolSelect(tool.id)
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleToolSelect])

  return (
    <div
      ref={panelRef}
      className="fixed z-50 select-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transition: isDragging ? 'none' : 'transform 0.15s ease-out'
      }}
      role="toolbar"
      aria-label="wepaint.ai tools"
    >
      <div 
        className="bg-background/95 backdrop-blur-sm border border-border overflow-hidden"
        style={{ width: '180px' }}
      >
        {/* Header - Draggable */}
        <div
          className={`flex items-center justify-between px-2 py-1.5 border-b border-border ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
          aria-label="Drag to move panel"
          role="button"
        >
          <div className="flex items-center">
            <span className="text-xs font-medium text-foreground/80">wepaint.ai</span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setIsCollapsed(!isCollapsed)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            className="p-1 hover:bg-secondary/80 transition-colors"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? "Expand tools panel" : "Collapse tools panel"}
          >
            <ChevronUp 
              className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${
                isCollapsed ? '' : 'rotate-180'
              }`} 
            />
          </button>
        </div>

        {!isCollapsed && (
          <div className="p-2">
            {/* Tool Selection */}
            <div className="grid grid-cols-4 border-b border-border mb-3">
              {tools.map((tool, index) => (
                <div 
                  key={tool.id} 
                  className={`${index < tools.length - 1 ? 'border-r border-border' : ''}`}
                >
                  <ToolButton
                    tool={tool}
                    isSelected={selectedTool === tool.id}
                    onClick={() => handleToolSelect(tool.id)}
                  />
                </div>
              ))}
            </div>

            {/* Color Mixer */}
            <div className="border-b border-border mb-3 pb-3">
              <ColorMixer
                color={color}
                onColorChange={onColorChange}
              />
            </div>

            {/* Sliders */}
            <div className="border-b border-border mb-3 pb-3">
              <Slider
                value={size}
                min={1}
                max={100}
                onChange={onSizeChange}
                icon={Circle}
                label="Brush Size"
                color="hsl(var(--primary))"
              />
              
              <Slider
                value={opacity * 100}
                min={0}
                max={100}
                onChange={(value) => onOpacityChange(value / 100)}
                icon={Eye}
                label="Opacity"
                color="hsl(0, 0%, 50%)"
              />
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-4">
              <div className="border-r border-border">
                <ActionButton icon={Undo2} label="Undo" onClick={onUndo} />
              </div>
              <div className="border-r border-border">
                <ActionButton icon={Redo2} label="Redo" onClick={onRedo} />
              </div>
              <div className="border-r border-border">
                <ActionButton icon={X} label="Clear Canvas" onClick={onClear} />
              </div>
              <div>
                <ActionButton icon={Save} label="Export" onClick={onExport} isPrimary />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
