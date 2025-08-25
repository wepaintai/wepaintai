import React from 'react'

interface DraggableWindowProps {
  title: string
  initialPosition?: { x: number; y: number }
  position?: { x: number; y: number }
  onMove?: (pos: { x: number; y: number }) => void
  onDragEnd?: (pos: { x: number; y: number }, rect: DOMRect | null) => void
  onClose?: () => void
  onDock?: () => void
  width?: number
  children: React.ReactNode
  onMouseOverToolbox?: (over: boolean) => void
}

export function DraggableWindow({
  title,
  initialPosition = { x: 260, y: 200 },
  position,
  onMove,
  onDragEnd,
  onClose,
  onDock,
  width = 220,
  children,
  onMouseOverToolbox,
}: DraggableWindowProps) {
  const [isDragging, setIsDragging] = React.useState(false)
  const [pos, setPos] = React.useState(initialPosition)
  const [dragOffset, setDragOffset] = React.useState({ x: 0, y: 0 })
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!position) {
      setPos(initialPosition)
    }
  }, [initialPosition.x, initialPosition.y, position])

  const startDrag = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    setIsDragging(true)
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    const rect = ref.current?.getBoundingClientRect()
    if (rect) setDragOffset({ x: clientX - rect.left, y: clientY - rect.top })
  }

  const move = React.useCallback(
    (e: MouseEvent | TouchEvent) => {
      if (!isDragging) return
      const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX
      const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY
      const newX = clientX - dragOffset.x
      const newY = clientY - dragOffset.y
      const maxX = window.innerWidth - (ref.current?.offsetWidth || width)
      const maxY = window.innerHeight - (ref.current?.offsetHeight || 300)
      const next = {
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      }
      setPos(next)
      onMove?.(next)
    },
    [isDragging, dragOffset, onMove, width]
  )

  const endDrag = React.useCallback(() => {
    setIsDragging(false)
    if (onDragEnd) {
      const current = position ?? pos
      const rect = ref.current?.getBoundingClientRect() ?? null
      onDragEnd(current, rect)
    }
  }, [onDragEnd, position, pos])

  React.useEffect(() => {
    if (!isDragging) return
    const mouseMove = (e: MouseEvent) => move(e)
    const mouseUp = () => endDrag()
    const touchMove = (e: TouchEvent) => move(e)
    const touchEnd = () => endDrag()
    document.addEventListener('mousemove', mouseMove)
    document.addEventListener('mouseup', mouseUp)
    document.addEventListener('touchmove', touchMove, { passive: false })
    document.addEventListener('touchend', touchEnd)
    return () => {
      document.removeEventListener('mousemove', mouseMove)
      document.removeEventListener('mouseup', mouseUp)
      document.removeEventListener('touchmove', touchMove)
      document.removeEventListener('touchend', touchEnd)
    }
  }, [isDragging, move, endDrag])

  return (
    <div
      ref={ref}
      className="fixed z-50 select-none"
      style={{ left: (position ?? pos).x, top: (position ?? pos).y, width }}
      onMouseEnter={() => onMouseOverToolbox?.(true)}
      onMouseLeave={() => onMouseOverToolbox?.(false)}
    >
      <div className="bg-black/90 backdrop-blur-md border border-white/20 overflow-hidden">
        <div
          className={`flex items-center justify-between px-2 py-1.5 border-b border-white/20 ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onMouseDown={startDrag}
          onTouchStart={startDrag}
          role="button"
          aria-label={`Drag to move ${title}`}
        >
          <div className="text-xs font-medium text-white/80">{title}</div>
          <div className="flex items-center gap-1">
            {onDock && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDock()
                }}
                className="p-0.5 hover:bg-white/20 rounded"
                aria-label="Dock back to toolbox"
                title="Dock"
              >
                {/* simple dock icon using box shape */}
                <span className="block w-3 h-3 border border-white/60" />
              </button>
            )}
            {onClose && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                }}
                className="p-0.5 hover:bg-white/20 rounded"
                aria-label="Close"
                title="Close"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="p-2">{children}</div>
      </div>
    </div>
  )
}
