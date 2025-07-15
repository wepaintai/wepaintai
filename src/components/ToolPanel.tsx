import React from 'react'
import {
  Paintbrush,
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
  Sparkles,
  MoreVertical,
  User,
  Layers,
  Settings,
  EyeOff,
  Trash2,
  GripVertical,
  Hand,
  Eraser,
  Plus,
  PlusCircle,
  Library,
  Sliders
} from 'lucide-react'
import { AuthModal } from './AuthModal'
import { LibraryModal } from './LibraryModal'
import { BrushSettingsModal, type BrushSettings } from './BrushSettingsModal'
import { useAuth, useUser } from '@clerk/tanstack-start'
import { useLibrary } from '../hooks/useLibrary'

// Types
export interface Layer {
  id: string
  type: 'stroke' | 'image' | 'ai-image' | 'paint'
  name: string
  visible: boolean
  opacity: number
  order: number
  thumbnailUrl?: string
}

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
  layers?: Layer[]
  activeLayerId?: string
  onActiveLayerChange?: (layerId: string) => void
  onLayerVisibilityChange?: (layerId: string, visible: boolean) => void
  onLayerReorder?: (layerId: string, newOrder: number) => void
  onLayerDelete?: (layerId: string) => void
  onLayerOpacityChange?: (layerId: string, opacity: number) => void
  onCreatePaintLayer?: () => void
  colorMode?: 'solid' | 'rainbow'
  onColorModeChange?: (mode: 'solid' | 'rainbow') => void
  brushSettings?: BrushSettings
  onBrushSettingsChange?: (settings: BrushSettings) => void
  canUndo?: boolean
  canRedo?: boolean
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
  { id: 'eraser', icon: Eraser, label: 'Eraser', ariaLabel: 'Eraser tool', keyboardShortcut: 'E' },
  { id: 'pan', icon: Hand, label: 'Pan', ariaLabel: 'Pan/Move layers', keyboardShortcut: 'H' },
  { id: 'upload', icon: ImagePlus, label: 'Upload', ariaLabel: 'Upload image', keyboardShortcut: 'U' },
  // { id: 'ai', icon: Sparkles, label: 'AI', ariaLabel: 'AI Generation', keyboardShortcut: 'G' },
  // { id: 'inpaint', icon: Palette, label: 'Inpaint', ariaLabel: 'Inpaint tool', keyboardShortcut: 'I' },
]

// Slider component for better reusability
const Slider = React.memo(({ value, min, max, onChange, icon: Icon, label, color }: SliderProps) => {
  // Normalize value for display
  const normalizedValue = ((value - min) / (max - min)) * 100
  
  return (
    <div className="flex items-center gap-2 mb-3" role="group" aria-labelledby={`${label.toLowerCase()}-slider-label`}>
      <Icon className="w-4 h-4 text-white/60 flex-shrink-0" aria-hidden="true" />
      <div className="relative flex-1 h-6 flex items-center">
        <div 
          className="h-1 w-full bg-white/20 rounded-full overflow-hidden"
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
  onClick,
  disabled = false
}: { 
  tool: Tool, 
  isSelected: boolean, 
  onClick: () => void,
  disabled?: boolean
}) => {
  // Debug logging for AI tool
  // if (tool.id === 'ai') {
  //   console.log('[ToolButton] AI tool rendering:', {
  //     disabled,
  //     isSelected,
  //     className: disabled ? 'disabled' : isSelected ? 'selected' : 'normal'
  //   })
  // }
  
  return (
    <button
      key={tool.id}
      onClick={(e) => {
        if (tool.id === 'ai') {
          console.log('[ToolButton] AI tool clicked, disabled:', disabled)
        }
        onClick()
      }}
      disabled={disabled}
      className={`w-8 h-8 flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 ${
        disabled
          ? 'bg-white/5 text-white/30 cursor-not-allowed'
          : isSelected 
          ? 'bg-blue-500 text-white' 
          : 'bg-white/10 text-white hover:bg-white/20'
      }`}
      title={`${tool.label}${tool.keyboardShortcut ? ` (${tool.keyboardShortcut})` : ''}${disabled ? ' (Sign in required)' : ''}`}
      aria-label={tool.ariaLabel}
      aria-pressed={isSelected}
      aria-disabled={disabled}
    >
      <tool.icon className={`w-4 h-4 ${isSelected && !disabled ? 'scale-110 transition-transform' : ''}`} />
    </button>
  )
})

ToolButton.displayName = 'ToolButton'

// Action button component
const ActionButton = React.memo(({ 
  icon: Icon, 
  label, 
  onClick, 
  isPrimary = false,
  disabled = false 
}: { 
  icon: React.ElementType, 
  label: string, 
  onClick: () => void, 
  isPrimary?: boolean,
  disabled?: boolean 
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`w-8 h-8 flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 ${
      disabled
        ? 'bg-white/5 text-white/30 cursor-not-allowed'
        : isPrimary 
        ? 'bg-blue-500 text-white hover:bg-blue-600' 
        : 'bg-white/10 text-white hover:bg-white/20'
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
  onColorChange,
  colorMode = 'solid',
  onColorModeChange
}: { 
  color: string, 
  onColorChange: (color: string) => void,
  colorMode?: 'solid' | 'rainbow',
  onColorModeChange?: (mode: 'solid' | 'rainbow') => void
}) => {
  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onColorChange(e.target.value)
  }
  
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3" role="group" aria-labelledby="color-mixer-label">
        <Pipette className="w-4 h-4 text-white/60 flex-shrink-0" aria-hidden="true" />
        <div className="flex-1 relative">
          <div
            className="w-full h-6 border border-white/20 rounded transition-all duration-100 hover:border-blue-400 overflow-hidden"
            style={{ 
              backgroundColor: colorMode === 'rainbow' 
                ? 'transparent' 
                : color,
              backgroundImage: colorMode === 'rainbow' 
                ? 'linear-gradient(to right, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)'
                : undefined
            }}
            title={colorMode === 'rainbow' ? 'Rainbow color mode' : 'Click to change color'}
          >
            <span className="sr-only">
              {colorMode === 'rainbow' ? 'Rainbow color mode' : `Current color: ${color}`}
            </span>
          </div>
          {colorMode === 'solid' && (
            <input
              type="color"
              value={color}
              onChange={handleColorChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              aria-label="Color picker"
            />
          )}
        </div>
        <span id="color-mixer-label" className="sr-only">Color mixer</span>
      </div>
      
      {onColorModeChange && (
        <div className="flex items-center gap-2 px-0.5">
          <button
            onClick={() => onColorModeChange('solid')}
            className={`flex-1 py-1 px-2 text-xs rounded transition-colors ${
              colorMode === 'solid'
                ? 'bg-blue-500 text-white'
                : 'bg-white/10 text-white/60 hover:bg-white/20'
            }`}
            aria-pressed={colorMode === 'solid'}
          >
            Solid
          </button>
          <button
            onClick={() => onColorModeChange('rainbow')}
            className={`flex-1 py-1 px-2 text-xs rounded transition-colors ${
              colorMode === 'rainbow'
                ? 'bg-blue-500 text-white'
                : 'bg-white/10 text-white/60 hover:bg-white/20'
            }`}
            aria-pressed={colorMode === 'rainbow'}
          >
            Rainbow
          </button>
        </div>
      )}
    </div>
  )
})

ColorMixer.displayName = 'ColorMixer'

// Tab definitions
type TabId = 'tools' | 'layers' | 'ai' | 'settings'

interface Tab {
  id: TabId
  label: string
  icon: React.ElementType
}

const tabs: Tab[] = [
  { id: 'tools', label: 'Tools', icon: Paintbrush },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings },
]

// Layer item component
const LayerItem = React.memo(({ 
  layer,
  isActive,
  onActivate,
  onVisibilityChange,
  onDelete,
  onReorder,
  onOpacityChange,
  totalLayers,
  isTopLayer = false,
  isBottomLayer = false
}: {
  layer: Layer
  isActive: boolean
  onActivate: () => void
  onVisibilityChange: (visible: boolean) => void
  onDelete: () => void
  onReorder: (direction: 'up' | 'down') => void
  onOpacityChange?: (opacity: number) => void
  totalLayers: number
  isTopLayer?: boolean
  isBottomLayer?: boolean
}) => {
  const [showOpacitySlider, setShowOpacitySlider] = React.useState(false)
  
  return (
    <div className="space-y-1">
      <div 
        className={`flex items-center gap-1 p-1 rounded transition-all cursor-pointer ${
          isActive 
            ? 'bg-blue-500/30 border border-blue-400/50' 
            : 'bg-white/5 hover:bg-white/10 border border-transparent'
        }`}
        onClick={onActivate}
      >
        <GripVertical className="w-3 h-3 text-white/40 cursor-move" />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onVisibilityChange(!layer.visible)
          }}
          className="p-0.5 hover:bg-white/20 rounded transition-colors"
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
        >
          {layer.visible ? (
            <Eye className="w-3.5 h-3.5 text-white/80" />
          ) : (
            <EyeOff className="w-3.5 h-3.5 text-white/40" />
          )}
        </button>
        <span className={`flex-1 text-xs truncate ${layer.name.includes('(empty)') ? 'text-white/40' : 'text-white/80'}`}>
          {layer.name}
          {isActive && <span className="ml-1 text-blue-400">(Active)</span>}
        </span>
        {layer.type !== 'stroke' && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setShowOpacitySlider(!showOpacitySlider)
            }}
            className="p-0.5 hover:bg-white/20 rounded transition-colors"
            aria-label="Adjust opacity"
            title={`Opacity: ${Math.round(layer.opacity * 100)}%`}
          >
            <Circle className="w-3 h-3 text-white/60" style={{ opacity: layer.opacity }} />
          </button>
        )}
        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onReorder('up')
            }}
            disabled={isTopLayer}
            className="p-0.5 hover:bg-white/20 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Move layer up"
          >
            <ChevronUp className="w-3 h-3 text-white/60" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onReorder('down')
            }}
            disabled={isBottomLayer}
            className="p-0.5 hover:bg-white/20 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Move layer down"
          >
            <ChevronUp className="w-3 h-3 text-white/60 rotate-180" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              console.log('[LayerItem] Delete button clicked for layer:', layer.id, layer.name)
              onDelete()
            }}
            className="p-0.5 hover:bg-white/20 rounded transition-colors"
            aria-label="Delete layer"
          >
            <Trash2 className="w-3 h-3 text-white/60 hover:text-red-400" />
          </button>
        </div>
      </div>
      {showOpacitySlider && layer.type !== 'stroke' && onOpacityChange && (
        <div className="px-2">
          <input
            type="range"
            min="0"
            max="100"
            value={layer.opacity * 100}
            onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
            className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, hsl(0, 0%, 50%) 0%, hsl(0, 0%, 50%) ${layer.opacity * 100}%, rgba(255, 255, 255, 0.2) ${layer.opacity * 100}%, rgba(255, 255, 255, 0.2) 100%)`
            }}
          />
        </div>
      )}
    </div>
  )
})

LayerItem.displayName = 'LayerItem'

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
  layers = [],
  activeLayerId,
  onActiveLayerChange,
  onLayerVisibilityChange,
  onLayerReorder,
  onLayerDelete,
  onLayerOpacityChange,
  onCreatePaintLayer,
  colorMode = 'solid',
  onColorModeChange,
  brushSettings,
  onBrushSettingsChange,
  canUndo = true,
  canRedo = true,
}: ToolPanelProps) {
  const { userId, isLoaded } = useAuth()
  const { isSignedIn, user } = useUser()
  const [internalSelectedTool, setInternalSelectedTool] = React.useState('brush')
  const selectedTool = externalSelectedTool || internalSelectedTool
  
  // Check if auth is disabled via environment variable
  const authDisabled = import.meta.env.VITE_AUTH_DISABLED === 'true'
  
  // If auth is disabled, treat user as signed in
  const effectiveIsSignedIn = authDisabled || isSignedIn
  
  // Debug logging
  React.useEffect(() => {
    // console.log('[ToolPanel] Auth state:', {
    //   userId,
    //   isLoaded,
    //   isSignedIn,
    //   effectiveIsSignedIn,
    //   authDisabled,
    //   userEmail: user?.primaryEmailAddress?.emailAddress,
    //   hasUser: !!user,
    //   VITE_AUTH_DISABLED: import.meta.env.VITE_AUTH_DISABLED
    // })
  }, [userId, isLoaded, isSignedIn, effectiveIsSignedIn, authDisabled, user])
  const [isCollapsed, setIsCollapsed] = React.useState(false)
  const [showMenu, setShowMenu] = React.useState(false)
  const [showAuthModal, setShowAuthModal] = React.useState(false)
  const [menuPosition, setMenuPosition] = React.useState({ x: 0, y: 0 })
  const [activeTab, setActiveTab] = React.useState<TabId>('tools')
  const { isLibraryModalOpen, openLibrary, closeLibrary } = useLibrary()
  const [showBrushSettings, setShowBrushSettings] = React.useState(false)
  
  // Drag functionality state
  const [isDragging, setIsDragging] = React.useState(false)
  const [position, setPosition] = React.useState({ x: 24, y: 200 })
  const [dragOffset, setDragOffset] = React.useState({ x: 0, y: 0 })
  const panelRef = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

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
    // Check if AI tool requires authentication
    if (toolId === 'ai' && !effectiveIsSignedIn) {
      // Don't select the tool, just show a message or do nothing
      // console.log('AI tool requires authentication. effectiveIsSignedIn:', effectiveIsSignedIn, 'authDisabled:', authDisabled)
      return
    }
    
    // For upload tool, don't change the selected tool state
    // It will be handled by the parent component after upload/cancel
    if (toolId === 'upload' && onImageUpload) {
      onImageUpload()
      return
    }
    
    // For AI tool, trigger AI generation AND set it as selected
    if (toolId === 'ai') {
      console.log('[handleToolSelect] AI tool selected, onAIGenerate:', !!onAIGenerate)
      
      // Set AI as the selected tool
      if (onToolChange) {
        onToolChange(toolId)
      } else {
        setInternalSelectedTool(toolId)
      }
      
      // Then trigger AI generation
      if (onAIGenerate) {
        onAIGenerate()
      } else {
        console.warn('[handleToolSelect] onAIGenerate callback is not defined!')
      }
      return
    }
    
    if (onToolChange) {
      onToolChange(toolId)
    } else {
      setInternalSelectedTool(toolId)
    }
  }, [onToolChange, onImageUpload, onAIGenerate, effectiveIsSignedIn, authDisabled])

  // Keyboard shortcuts for tools
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }
      
      const key = e.key.toUpperCase()
      const tool = tools.find(t => t.keyboardShortcut === key)
      
      if (tool) {
        // Skip AI tool if not authenticated
        if (tool.id === 'ai' && !effectiveIsSignedIn) {
          return
        }
        handleToolSelect(tool.id)
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleToolSelect, effectiveIsSignedIn])

  // Handle menu toggle
  const handleMenuToggle = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setMenuPosition({ x: rect.right - rect.left, y: rect.bottom - rect.top })
    setShowMenu(!showMenu)
  }, [showMenu])

  // Close menu on outside click
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showMenu])

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
        className="bg-black/90 backdrop-blur-md border border-white/20 overflow-hidden"
        style={{ width: '180px' }}
      >
        {/* Header - Draggable */}
        <div
          className={`flex items-center justify-between px-2 py-1.5 border-b border-white/20 ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
          aria-label="Drag to move panel"
          role="button"
        >
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-white/80">wepaint.ai</span>
            <button
              onClick={handleMenuToggle}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="p-0.5 hover:bg-white/20 rounded transition-colors"
              aria-label="More options"
            >
              <MoreVertical className="w-3.5 h-3.5 text-white/60" />
            </button>
            <span className="text-[10px] font-medium text-white/50 uppercase tracking-wider">Beta</span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setIsCollapsed(!isCollapsed)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            className="p-1 hover:bg-white/20 transition-colors"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? "Expand tools panel" : "Collapse tools panel"}
          >
            <ChevronUp 
              className={`w-3.5 h-3.5 text-white/60 transition-transform ${
                isCollapsed ? '' : 'rotate-180'
              }`} 
            />
          </button>
        </div>

        {!isCollapsed && (
          <div>
            {/* Tab Navigation */}
            <div className="flex border-b border-white/20">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
                    activeTab === tab.id
                      ? 'bg-white/20 text-white'
                      : 'text-white/60 hover:text-white hover:bg-white/10'
                  }`}
                  aria-selected={activeTab === tab.id}
                  role="tab"
                >
                  <tab.icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="p-2">
              {activeTab === 'tools' && (
                <>
                  {/* Tool Selection */}
                  <div className="grid grid-cols-4 mb-[10px]">
                    {tools.map((tool, index) => {
                      // Only disable AI tool for unauthenticated users
                      const isAIDisabled = tool.id === 'ai' && !effectiveIsSignedIn
                      
                      // if (tool.id === 'ai') {
                      //   console.log('[ToolPanel] AI tool button - effectiveIsSignedIn:', effectiveIsSignedIn, 'authDisabled:', authDisabled, 'disabled:', isAIDisabled)
                      // }
                      
                      return (
                        <div 
                          key={tool.id} 
                          className={`${index < tools.length - 1 ? 'border-r border-white/20' : ''}`}
                        >
                          <ToolButton
                            tool={tool}
                            isSelected={selectedTool === tool.id}
                            onClick={() => handleToolSelect(tool.id)}
                            disabled={isAIDisabled}
                          />
                        </div>
                      )
                    })}
                  </div>

                  {/* Color Mixer */}
                  <ColorMixer
                    color={color}
                    onColorChange={onColorChange}
                    colorMode={colorMode}
                    onColorModeChange={onColorModeChange}
                  />

                  {/* Sliders */}
                  <div className="border-b border-white/20 mb-3 pb-3">
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
                    <div className="border-r border-white/20">
                      <ActionButton icon={Undo2} label="Undo" onClick={onUndo} disabled={!canUndo} />
                    </div>
                    <div className="border-r border-white/20">
                      <ActionButton icon={Redo2} label="Redo" onClick={onRedo} disabled={!canRedo} />
                    </div>
                    <div className="border-r border-white/20">
                      <ActionButton icon={X} label="Clear Canvas" onClick={onClear} />
                    </div>
                    <div>
                      <ActionButton icon={Save} label="Export" onClick={onExport} />
                    </div>
                  </div>
                </>
              )}

              {activeTab === 'layers' && (
                <div className="space-y-2">
                  {layers.length === 0 ? (
                    <p className="text-xs text-white/60 text-center py-4">No layers yet</p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs font-medium text-white/80">Layers ({layers.length})</div>
                        {onCreatePaintLayer && (
                          <button
                            onClick={onCreatePaintLayer}
                            className="p-0.5 hover:bg-white/20 rounded transition-colors flex items-center gap-1"
                            aria-label="Add new paint layer"
                            title="Add new paint layer"
                          >
                            <Plus className="w-3.5 h-3.5 text-white/60 hover:text-white" />
                            <span className="text-[10px] text-white/60">New</span>
                          </button>
                        )}
                      </div>
                      <div className="space-y-1 max-h-[300px] overflow-y-auto">
                        {[...layers].sort((a, b) => b.order - a.order).map((layer, index) => (
                          <LayerItem
                            key={layer.id}
                            layer={layer}
                            isActive={activeLayerId === layer.id}
                            onActivate={() => onActiveLayerChange?.(layer.id)}
                            onVisibilityChange={(visible) => onLayerVisibilityChange?.(layer.id, visible)}
                            onDelete={() => onLayerDelete?.(layer.id)}
                            onReorder={(direction) => {
                              // Layers are displayed from top to bottom (highest order to lowest)
                              // Moving "up" in the UI means increasing the order value
                              // Moving "down" in the UI means decreasing the order value
                              
                              if (direction === 'up') {
                                // Increase order to move layer up in the visual stack
                                onLayerReorder?.(layer.id, layer.order + 1)
                              } else if (direction === 'down') {
                                // Decrease order to move layer down in the visual stack
                                onLayerReorder?.(layer.id, layer.order - 1)
                              }
                            }}
                            onOpacityChange={(opacity) => onLayerOpacityChange?.(layer.id, opacity)}
                            totalLayers={layers.length}
                            isTopLayer={index === 0}
                            isBottomLayer={index === [...layers].sort((a, b) => b.order - a.order).length - 1}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'ai' && (
                <div className="space-y-2">
                  {!effectiveIsSignedIn ? (
                    <>
                      <div className="text-center py-4">
                        <p className="text-sm text-white/60 mb-2">Sign in to use AI generation</p>
                        <button
                          onClick={() => !authDisabled && setShowAuthModal(true)}
                          className="text-blue-400 hover:text-blue-300 text-sm underline"
                        >
                          Sign in
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={onAIGenerate}
                        className="w-full py-2 px-3 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        <Sparkles className="w-4 h-4" />
                        Generate AI Image
                      </button>
                      <p className="text-xs text-white/60 text-center">Use AI to transform your canvas</p>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'settings' && (
                <div className="space-y-2">
                  <p className="text-xs text-white/60 text-center py-4">Settings coming soon...</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      
      {/* Context Menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute bg-black/90 backdrop-blur-md border border-white/20 rounded-md shadow-xl py-1 min-w-[150px]"
          style={{
            left: `${menuPosition.x}px`,
            top: `${menuPosition.y}px`
          }}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors flex items-center gap-2"
            onClick={() => {
              console.log('[ToolPanel] Account button clicked, authDisabled:', authDisabled, 'VITE_AUTH_DISABLED:', import.meta.env.VITE_AUTH_DISABLED)
              setShowMenu(false)
              if (!authDisabled) {
                console.log('[ToolPanel] Showing auth modal')
                setShowAuthModal(true)
              } else {
                console.log('[ToolPanel] Auth is disabled, not showing modal')
              }
            }}
          >
            <User className="w-4 h-4" />
            Account
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors flex items-center gap-2"
            onClick={() => {
              setShowMenu(false)
              // Clear the session parameter to create a new one
              const url = new URL(window.location.href);
              url.searchParams.delete('session');
              window.history.pushState({}, '', url.toString());
              // Reload to trigger new session creation
              window.location.reload();
            }}
          >
            <PlusCircle className="w-4 h-4" />
            New Canvas
          </button>
          {effectiveIsSignedIn ? (
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors flex items-center gap-2"
              onClick={() => {
                setShowMenu(false)
                openLibrary()
              }}
            >
              <Library className="w-4 h-4" />
              Library
            </button>
          ) : null}
          <div className="border-t border-white/20 my-1" />
          {/* <button
            className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors"
            onClick={() => {
              setShowMenu(false)
              // Add about/help functionality here
              alert('wepaint.ai - Collaborative painting app')
            }}
          >
            About
          </button> */}
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors"
            onClick={() => {
              setShowMenu(false)
              window.open('https://github.com/wepaintai/wepaintai', '_blank')
            }}
          >
            GitHub
          </button>
          <div className="border-t border-white/20 my-1" />
          {onBrushSettingsChange && (
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors flex items-center gap-2"
              onClick={() => {
                setShowMenu(false)
                setShowBrushSettings(true)
              }}
            >
              <Sliders className="w-4 h-4" />
              Brush Settings
            </button>
          )}
          {/* <button
            className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors"
            onClick={() => {
              setShowMenu(false)
              // Add settings functionality here
            }}
          >
            Settings
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors"
            onClick={() => {
              setShowMenu(false)
              // Add keyboard shortcuts modal here
            }}
          >
            Keyboard Shortcuts
          </button> */}
        </div>
      )}
      
      {/* Auth Modal - Only show if auth is not disabled */}
      {!authDisabled && (
        <AuthModal 
          isOpen={showAuthModal} 
          onClose={() => setShowAuthModal(false)} 
        />
      )}
      <LibraryModal
        isOpen={isLibraryModalOpen}
        onClose={closeLibrary}
        onCreateNew={() => {
          // Clear the session parameter to create a new one
          const url = new URL(window.location.href);
          url.searchParams.delete('session');
          window.history.pushState({}, '', url.toString());
          // Reload to trigger new session creation
          window.location.reload();
        }}
      />
      {brushSettings && onBrushSettingsChange && (
        <BrushSettingsModal
          isOpen={showBrushSettings}
          onClose={() => setShowBrushSettings(false)}
          settings={brushSettings}
          onSettingsChange={onBrushSettingsChange}
        />
      )}
    </div>
  )
}
