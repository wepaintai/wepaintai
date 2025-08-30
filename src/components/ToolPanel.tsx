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
  EyeOff,
  Trash2,
  GripVertical,
  Eraser,
  Plus,
  Scissors,
  PlusCircle,
  Library,
  Sliders,
  Merge,
  Scan
} from 'lucide-react'
import { AuthModal } from './AuthModal'
import { LibraryModal } from './LibraryModal'
import { BrushSettingsModal, type BrushSettings } from './BrushSettingsModal'
import { useAuth, useUser } from '@clerk/tanstack-start'
import { useLibrary } from '../hooks/useLibrary'
import { useClipboardContext } from '../context/ClipboardContext'
import { DraggableWindow } from './DraggableWindow'
import { ShareModal } from './ShareModal'
import { Id } from '../../convex/_generated/dataModel'

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
  sessionId?: Id<'paintingSessions'> | null
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
  onBackgroundRemoval?: () => void
  onMergeTwo?: () => void
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
  { id: 'transform', icon: Scan, label: 'Transform', ariaLabel: 'Move/Rotate/Scale layer', keyboardShortcut: 'H' },
  { id: 'upload', icon: ImagePlus, label: 'Upload', ariaLabel: 'Upload image', keyboardShortcut: 'U' },
  // { id: 'ai', icon: Sparkles, label: 'AI', ariaLabel: 'AI Generation', keyboardShortcut: 'G' },
  // { id: 'inpaint', icon: Palette, label: 'Inpaint', ariaLabel: 'Inpaint tool', keyboardShortcut: 'I' },
]

// Slider component for better reusability
const Slider = React.memo(({ value, min, max, onChange, icon: Icon, label, color }: SliderProps) => {
  // Track live drag to keep UI perfectly in sync with pointer
  const [isDragging, setIsDragging] = React.useState(false)
  const [tempValue, setTempValue] = React.useState<number | null>(null)

  // Layout refs/sizing for precise thumb alignment
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = React.useState(0)

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerWidth(el.clientWidth)
    update()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => update())
      ro.observe(el)
    } else {
      window.addEventListener('resize', update)
    }
    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', update)
    }
  }, [])

  const displayedValue = isDragging && tempValue != null ? tempValue : value
  const fraction = Math.min(1, Math.max(0, (displayedValue - min) / (max - min)))
  const thumbSize = 16
  const trackPadding = 8 // keep thumb inside gutters to align with column margins
  const usableWidth = Math.max(0, containerWidth - 2 * trackPadding)
  const thumbLeftPx = trackPadding + fraction * usableWidth - thumbSize / 2
  const clampedThumbLeftPx = Math.min(
    Math.max(thumbLeftPx, trackPadding - thumbSize / 2),
    trackPadding + usableWidth - thumbSize / 2
  )
  const fillWidthPx = Math.max(0, fraction * usableWidth)
  
  return (
    <div className="flex items-center gap-2 mb-3 last:mb-1 min-h-[2rem]" role="group" aria-labelledby={`${label.toLowerCase()}-slider-label`}>
      <Icon className="w-4 h-4 text-white/60 flex-shrink-0" aria-hidden="true" />
      <div ref={containerRef} className="relative flex-1 h-8 flex items-center">
        {/* Track */}
        <div
          className="absolute rounded-full"
          style={{ left: trackPadding, right: trackPadding, height: 4, background: 'rgba(255,255,255,0.2)' }}
          role="presentation"
        />
        {/* Fill */}
        <div
          className={`absolute h-1 rounded-full ${isDragging ? 'transition-none' : 'transition-all duration-100'}`}
          style={{ left: trackPadding, width: fillWidthPx, backgroundColor: color }}
          role="presentation"
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full pointer-events-none shadow-[0_0_0_1px_rgba(255,255,255,0.5)]"
          style={{ left: clampedThumbLeftPx, backgroundColor: color }}
          role="presentation"
        />
        <input
          type="range"
          min={min}
          max={max}
          value={displayedValue}
          onInput={(e: React.FormEvent<HTMLInputElement>) => {
            const v = Number((e.target as HTMLInputElement).value)
            setTempValue(v)
            onChange(v)
          }}
          onChange={(e) => {
            // Fallback for environments only emitting change
            const v = Number(e.target.value)
            setTempValue(v)
            onChange(v)
          }}
          onPointerDown={() => setIsDragging(true)}
          onPointerUp={() => { setIsDragging(false); setTempValue(null) }}
          onBlur={() => { setIsDragging(false); setTempValue(null) }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={displayedValue}
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
  const [showModeMenu, setShowModeMenu] = React.useState(false)

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onColorChange(e.target.value)
  }

  // Close popover on outside click
  const containerRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) {
        setShowModeMenu(false)
      }
    }
    if (showModeMenu) {
      document.addEventListener('mousedown', onDocClick)
      return () => document.removeEventListener('mousedown', onDocClick)
    }
  }, [showModeMenu])
  
  return (
    <div className="mb-3" ref={containerRef}>
      {/* Row: color swatch (1/2) + mode display (1/2) */}
      <div className="grid grid-cols-2 gap-2 items-center" role="group" aria-labelledby="color-mixer-label">
        {/* Color swatch / picker */}
        <div className="relative">
          <div
            className="w-full h-8 border border-white/40 rounded transition-all duration-100 hover:border-blue-400 overflow-hidden"
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
          {/* Overlay dropper icon on the swatch */}
          <Pipette className="pointer-events-none absolute right-1 top-1 w-3.5 h-3.5 text-white/80 drop-shadow" aria-hidden="true" />
          {colorMode === 'solid' && (
            <input
              type="color"
              value={color}
              onChange={handleColorChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              aria-label="Color picker"
            />
          )}
          <span id="color-mixer-label" className="sr-only">Color mixer</span>
        </div>

        {/* Mode display with popover switcher */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowModeMenu((v) => !v)}
            className="w-full h-8 px-2 text-[11px] rounded border border-white/20 bg-white/5 text-white/80 hover:bg-white/10 flex items-center justify-center"
            aria-haspopup="menu"
            aria-expanded={showModeMenu}
            aria-label="Color mode"
            title="Click to switch color mode"
          >
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block w-3.5 h-3.5 rounded-sm border border-white/30"
                style={{
                  backgroundImage: colorMode === 'rainbow'
                    ? 'linear-gradient(to right, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)'
                    : undefined,
                  backgroundColor: colorMode === 'rainbow' ? 'transparent' : color
                }}
                aria-hidden="true"
              />
              {colorMode === 'rainbow' ? 'Rainbow' : 'Solid'}
            </span>
          </button>
          {showModeMenu && onColorModeChange && (
            <div
              role="menu"
              className="absolute z-10 mt-1 right-0 w-28 bg-black/95 border border-white/20 rounded shadow-lg py-1"
            >
              <button
                onClick={() => { onColorModeChange('solid'); setShowModeMenu(false) }}
                className={`w-full text-left px-2 py-1 text-xs transition-colors flex items-center gap-1 ${colorMode === 'solid' ? 'text-white bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
                role="menuitem"
              >
                <span
                  className="inline-block w-3.5 h-3.5 rounded-sm border border-white/30"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                Solid
              </button>
              <button
                onClick={() => { onColorModeChange('rainbow'); setShowModeMenu(false) }}
                className={`w-full text-left px-2 py-1 text-xs transition-colors flex items-center gap-1 ${colorMode === 'rainbow' ? 'text-white bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
                role="menuitem"
              >
                <span
                  className="inline-block w-3.5 h-3.5 rounded-sm border border-white/30"
                  style={{ backgroundImage: 'linear-gradient(to right, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)' }}
                  aria-hidden="true"
                />
                Rainbow
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

ColorMixer.displayName = 'ColorMixer'

// Tab definitions
type TabId = 'tools' | 'layers' | 'ai'

interface Tab {
  id: TabId
  label: string
  icon: React.ElementType
}

const tabs: Tab[] = [
  { id: 'tools', label: 'Tools', icon: Paintbrush },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'ai', label: 'AI', icon: Sparkles },
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
          type="button"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            console.log('[LayerItem] onPointerDown visibility toggle', {
              layerId: layer.id,
              layerName: layer.name,
              currentVisible: layer.visible,
              nextVisible: !layer.visible,
            })
            onVisibilityChange(!layer.visible)
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            console.log('[LayerItem] onClick visibility toggle', {
              layerId: layer.id,
              layerName: layer.name,
              currentVisible: layer.visible,
              nextVisible: !layer.visible,
            })
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
  sessionId,
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
  onBackgroundRemoval,
  onMergeTwo,
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
  const { setIsMouseOverToolbox } = useClipboardContext()
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
  // Detachable tabs state: when a tab is detached, it won't render in the toolbox
  const [detachedTabs, setDetachedTabs] = React.useState<Partial<Record<TabId, { x: number; y: number }>>>({})
  const [draggingTab, setDraggingTab] = React.useState<null | { id: TabId; startX: number; startY: number }>(null)
  const [draggingDetached, setDraggingDetached] = React.useState<null | { id: TabId; offsetX: number; offsetY: number }>(null)
  const [autoCollapsed, setAutoCollapsed] = React.useState(false)
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
    // Restore detached tabs from localStorage
    try {
      const raw = localStorage.getItem('wepaint.detachedTabs')
      if (raw) {
        const parsed = JSON.parse(raw)
        setDetachedTabs(parsed || {})
        // Ensure activeTab is visible
        const visible = (id: TabId) => !parsed?.[id]
        if (!visible(activeTab)) {
          const fallback = (['tools', 'layers', 'ai'] as TabId[]).find(t => visible(t as TabId)) || 'tools'
          setActiveTab(fallback as TabId)
        }
      }
    } catch {}
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

  // Persist detached tabs positions
  React.useEffect(() => {
    try {
      localStorage.setItem('wepaint.detachedTabs', JSON.stringify(detachedTabs))
    } catch {}
  }, [detachedTabs])

  // Auto collapse when all tabs are detached; auto expand when any docks back
  React.useEffect(() => {
    const allDetached = ['tools', 'layers', 'ai'].every(t => Boolean((detachedTabs as any)[t]))
    if (allDetached && !autoCollapsed) {
      setIsCollapsed(true)
      setAutoCollapsed(true)
    } else if (!allDetached && autoCollapsed) {
      setIsCollapsed(false)
      setAutoCollapsed(false)
    }
  }, [detachedTabs, autoCollapsed])

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

  // Handle menu open/close. If already open, close. Otherwise open and position.
  const handleMenuToggle = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (showMenu) {
      setShowMenu(false)
      return
    }
    const triggerRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const panelRect = panelRef.current?.getBoundingClientRect()
    const x = panelRect ? triggerRect.left - panelRect.left : 0
    const y = panelRect ? triggerRect.bottom - panelRect.top : 0
    setMenuPosition({ x, y })
    setShowMenu(true)
  }, [showMenu])

  // Close menu on outside pointer down (capture) and suppress canvas paint for that click
  React.useEffect(() => {
    const handleOutsidePointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      const clickedMenu = !!menuRef.current && menuRef.current.contains(target)
      const clickedTrigger = target instanceof Element && !!target.closest('[data-menu-trigger="true"]')
      const clickedInsidePanel = !!panelRef.current && panelRef.current.contains(target)
      if (!clickedMenu && !clickedTrigger) {
        setShowMenu(false)
        // If click is outside the toolbox panel entirely and was on the canvas, prevent drawing
        if (!clickedInsidePanel) {
          const isCanvasTarget = target instanceof HTMLCanvasElement || (target instanceof Element && !!target.closest('canvas'))
          if (isCanvasTarget) {
            e.preventDefault()
            e.stopPropagation()
          }
        }
      }
    }

    if (showMenu) {
      document.addEventListener('pointerdown', handleOutsidePointerDown, { capture: true })
      return () => {
        document.removeEventListener('pointerdown', handleOutsidePointerDown, { capture: true } as any)
      }
    }
  }, [showMenu])

  // Tab detach drag handlers
  const onTabMouseDown = React.useCallback((e: React.MouseEvent, id: TabId) => {
    setDraggingTab({ id, startX: e.clientX, startY: e.clientY })
  }, [])

  React.useEffect(() => {
    if (!draggingTab) return
    const onMove = (e: MouseEvent) => {
      if (!panelRef.current) return
      const rect = panelRef.current.getBoundingClientRect()
      const { clientX, clientY } = e
      const movedEnough = Math.hypot(clientX - draggingTab.startX, clientY - draggingTab.startY) > 10
      const outside = clientX < rect.left - 8 || clientX > rect.right + 8 || clientY < rect.top - 8 || clientY > rect.bottom + 8
      if (movedEnough && outside) {
        // Detach this tab near cursor
        const offsetX = 12
        const offsetY = 12
        const x = Math.min(Math.max(0, clientX - offsetX), window.innerWidth - 220)
        const y = Math.min(Math.max(0, clientY - offsetY), window.innerHeight - 280)
        const nextDetached = { ...detachedTabs, [draggingTab.id]: { x, y } }
        setDetachedTabs(nextDetached)
        // If the active tab was detached, switch to first attached tab
        if (activeTab === draggingTab.id) {
          const firstAttached = (['tools', 'layers', 'ai'] as TabId[]).find(t => !nextDetached[t as TabId]) || 'tools'
          setActiveTab(firstAttached as TabId)
        }
        setDraggingTab(null)
        // Continue dragging the newly detached window with the mouse until mouseup
        setDraggingDetached({ id: draggingTab.id, offsetX, offsetY })
      }
    }
    const onUp = () => setDraggingTab(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [draggingTab, activeTab, detachedTabs])

  // Handle continuing drag after detaching a tab
  React.useEffect(() => {
    if (!draggingDetached) return
    const onMove = (e: MouseEvent) => {
      const clientX = e.clientX
      const clientY = e.clientY
      const x = Math.min(Math.max(0, clientX - draggingDetached.offsetX), window.innerWidth - 240)
      const y = Math.min(Math.max(0, clientY - draggingDetached.offsetY), window.innerHeight - 300)
      setDetachedTabs(prev => ({ ...prev, [draggingDetached.id]: { x, y } }))
    }
    const onUp = (e: MouseEvent) => {
      // If mouse released over toolbox, snap back (dock)
      const rect = panelRef.current?.getBoundingClientRect()
      if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        setDetachedTabs(prev => {
          const n = { ...prev }
          delete (n as any)[draggingDetached.id]
          return n
        })
        // Ensure activeTab shows docked tab
        setActiveTab(draggingDetached.id)
      }
      setDraggingDetached(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [draggingDetached])

  // Helper to test overlap between two rects
  const rectsOverlap = (a: DOMRect, b: DOMRect) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)

  const isDetached = React.useCallback((id: TabId) => Boolean(detachedTabs[id]), [detachedTabs])
  const visibleTabs = React.useMemo(() => tabs.filter(t => !isDetached(t.id)), [detachedTabs])

  // Helpers to render per-tab content so we can reuse inside floating windows
  const [showShareModal, setShowShareModal] = React.useState(false)

  const renderToolsTab = React.useCallback(() => (
    <>
      {/* Tool Selection */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {tools.map((tool) => {
          const isAIDisabled = tool.id === 'ai' && !effectiveIsSignedIn
          return (
            <div key={tool.id} className="flex justify-center">
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
      <div className="border-b border-white/20 mb-2 pb-1">
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
      <div className="grid grid-cols-4 gap-2">
        <div className="flex justify-center">
          <ActionButton icon={Undo2} label="Undo" onClick={onUndo} disabled={!canUndo} />
        </div>
        <div className="flex justify-center">
          <ActionButton icon={Redo2} label="Redo" onClick={onRedo} disabled={!canRedo} />
        </div>
        <div className="flex justify-center">
          <ActionButton icon={X} label="Clear Canvas" onClick={onClear} />
        </div>
        <div className="flex justify-center">
          <ActionButton icon={Save} label="Export" onClick={onExport} />
        </div>
      </div>
    </>
  ), [selectedTool, handleToolSelect, effectiveIsSignedIn, color, onColorChange, colorMode, onColorModeChange, size, onSizeChange, opacity, onOpacityChange, onUndo, canUndo, onRedo, canRedo, onClear, onExport])

  const renderLayersTab = React.useCallback(() => (
    <div className="space-y-2">
      {layers.length === 0 ? (
        <p className="text-xs text-white/60 text-center py-4">No layers yet</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-1">
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
                  if (direction === 'up') {
                    onLayerReorder?.(layer.id, layer.order + 1)
                  } else if (direction === 'down') {
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
  ), [layers, onCreatePaintLayer, activeLayerId, onActiveLayerChange, onLayerVisibilityChange, onLayerDelete, onLayerReorder, onLayerOpacityChange])

  const renderAITab = React.useCallback(() => (
    <div className="space-y-2">
      {!effectiveIsSignedIn ? (
        <div className="text-center py-4">
          <p className="text-sm text-white/60 mb-2">Sign in to use AI generation</p>
          <button onClick={() => !authDisabled && setShowAuthModal(true)} className="text-blue-400 hover:text-blue-300 text-sm underline">
            Sign in
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={onAIGenerate}
            className="w-full py-2 px-3 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2 rounded"
          >
            <Sparkles className="w-4 h-4" />
            Generate AI Image
          </button>
          <button
            onClick={onBackgroundRemoval}
            className="w-full py-2 px-3 bg-purple-500 hover:bg-purple-600 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2 rounded"
          >
            <Scissors className="w-4 h-4" />
            Remove Background
          </button>
          <button
            onClick={onMergeTwo}
            className="w-full py-2 px-3 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2 rounded"
          >
            <Merge className="w-4 h-4" />
            Merge Two
          </button>
        </>
      )}
    </div>
  ), [effectiveIsSignedIn, authDisabled, onAIGenerate, onBackgroundRemoval, onMergeTwo])

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
      onMouseEnter={() => setIsMouseOverToolbox(true)}
      onMouseLeave={() => setIsMouseOverToolbox(false)}
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
            <button
              onClick={handleMenuToggle}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              type="button"
              className="text-xs font-medium text-white/80 hover:text-white transition-colors p-0 bg-transparent border-0"
              aria-label="Open menu"
              data-menu-trigger="true"
            >
              wepaint.ai
            </button>
            <button
              onClick={handleMenuToggle}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="p-0.5 hover:bg-white/20 rounded transition-colors"
              aria-label="More options"
              data-menu-trigger="true"
            >
              <MoreVertical className="w-3.5 h-3.5 text-white/60" />
            </button>
            <span className="text-[10px] font-medium text-white/50 uppercase tracking-wider">Beta</span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setIsCollapsed(!isCollapsed)
              setShowMenu(false)
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
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  onMouseDown={(e) => onTabMouseDown(e, tab.id)}
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
              {activeTab === 'tools' && !isDetached('tools') && renderToolsTab()}
              {activeTab === 'layers' && !isDetached('layers') && renderLayersTab()}
              {activeTab === 'ai' && !isDetached('ai') && renderAITab()}
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
              try { localStorage.removeItem('wepaint_current_session_v1') } catch {}
              // Reload to trigger new session creation
              window.location.reload();
            }}
          >
            <PlusCircle className="w-4 h-4" />
            New Canvas
          </button>
          {sessionId && (
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-white hover:bg-white/20 transition-colors flex items-center gap-2"
              onClick={() => {
                setShowMenu(false)
                setShowShareModal(true)
              }}
            >
              <Scan className="w-4 h-4" />
              Share
            </button>
          )}
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
      
      {/* Floating detached tabs */}
      {detachedTabs['tools'] && (
        <DraggableWindow
          title="Tools"
          position={detachedTabs['tools']!}
          onMove={(p) => setDetachedTabs(prev => ({ ...prev, tools: p }))}
          onDragEnd={(_, rect) => {
            const panel = panelRef.current?.getBoundingClientRect()
            if (rect && panel && rectsOverlap(rect, panel)) {
              setDetachedTabs(prev => { const n = { ...prev }; delete (n as any)['tools']; return n })
              setActiveTab('tools')
            }
          }}
          onDock={() => setDetachedTabs(prev => { const n = { ...prev }; delete (n as any)['tools']; return n })}
          onMouseOverToolbox={setIsMouseOverToolbox}
          width={220}
        >
          {renderToolsTab()}
        </DraggableWindow>
      )}

      {detachedTabs['layers'] && (
        <DraggableWindow
          title="Layers"
          position={detachedTabs['layers']!}
          onMove={(p) => setDetachedTabs(prev => ({ ...prev, layers: p }))}
          onDragEnd={(_, rect) => {
            const panel = panelRef.current?.getBoundingClientRect()
            if (rect && panel && rectsOverlap(rect, panel)) {
              setDetachedTabs(prev => { const n = { ...prev }; delete (n as any)['layers']; return n })
              setActiveTab('layers')
            }
          }}
          onDock={() => setDetachedTabs(prev => { const n = { ...prev }; delete (n as any)['layers']; return n })}
          onMouseOverToolbox={setIsMouseOverToolbox}
          width={220}
        >
          {renderLayersTab()}
        </DraggableWindow>
      )}

      {detachedTabs['ai'] && (
        <DraggableWindow
          title="AI"
          position={detachedTabs['ai']!}
          onMove={(p) => setDetachedTabs(prev => ({ ...prev, ai: p }))}
          onDragEnd={(_, rect) => {
            const panel = panelRef.current?.getBoundingClientRect()
            if (rect && panel && rectsOverlap(rect, panel)) {
              setDetachedTabs(prev => { const n = { ...prev }; delete (n as any)['ai']; return n })
              setActiveTab('ai')
            }
          }}
          onDock={() => setDetachedTabs(prev => { const n = { ...prev }; delete (n as any)['ai']; return n })}
          onMouseOverToolbox={setIsMouseOverToolbox}
          width={220}
        >
          {renderAITab()}
        </DraggableWindow>
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
      {showShareModal && sessionId && (
        <ShareModal isOpen={showShareModal} onClose={() => setShowShareModal(false)} sessionId={sessionId} />
      )}
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
