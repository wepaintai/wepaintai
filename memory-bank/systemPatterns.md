# iPaintAI - System Patterns

## Real-time Collaboration Patterns

### 1. Optimistic Updates Pattern
**Problem**: Users need immediate feedback when drawing, but network latency would cause delays.

**Solution**: Update local state immediately, then sync to backend.

```typescript
// Pattern: Local update first, then sync
const handlePointerMove = (e: PointerEvent) => {
  const point = getPointerPosition(e)
  
  // 1. Immediate local update
  if (isDrawing) {
    currentStroke.push(point)
    drawStroke(context, currentStroke) // Local canvas update
  }
  
  // 2. Sync to backend (async)
  updateUserPresence(point.x, point.y, isDrawing, 'brush')
}

const handlePointerUp = () => {
  // 3. Persist complete stroke
  if (currentStroke.length > 0) {
    addStrokeToSession(currentStroke, color, size, opacity)
  }
}
```

**Benefits**:
- Zero perceived latency for drawing
- Smooth user experience
- Automatic conflict resolution via Convex

### 2. Session Management Pattern
**Problem**: Multiple users need to collaborate on the same canvas with easy sharing.

**Solution**: URL-based session identification with automatic creation/joining.

```typescript
// Pattern: URL-based session management
useEffect(() => {
  const initSession = async () => {
    const urlParams = new URLSearchParams(window.location.search)
    const existingSessionId = urlParams.get('session')
    
    if (existingSessionId) {
      // Join existing session
      setSessionId(existingSessionId)
    } else {
      // Create new session
      const newSessionId = await createNewSession('Collaborative Painting', 800, 600)
      setSessionId(newSessionId)
      // Update URL for sharing
      window.history.replaceState({}, '', `?session=${newSessionId}`)
    }
  }
  
  initSession()
}, [])
```

**Benefits**:
- Easy session sharing via URL
- No complex authentication required
- Persistent session state

### 3. Presence Tracking Pattern
**Problem**: Users need to see where others are working in real-time.

**Solution**: Throttled cursor position updates with user identification.

```typescript
// Pattern: Throttled presence updates
const updateUserPresence = useCallback(
  throttle((x: number, y: number, isDrawing: boolean, tool: string) => {
    if (!sessionId) return
    
    updatePresence({
      sessionId,
      userId: currentUser.id,
      userColor: currentUser.color,
      userName: currentUser.name,
      cursorX: x,
      cursorY: y,
      isDrawing,
      currentTool: tool,
      lastSeen: Date.now()
    })
  }, 16), // ~60fps
  [sessionId, currentUser]
)
```

**Benefits**:
- Smooth cursor tracking
- Efficient bandwidth usage
- Real-time collaboration awareness

### 4. Stroke Ordering Pattern
**Problem**: Strokes from different users need consistent ordering across all clients.

**Solution**: Server-side stroke ordering with optimistic local rendering.

```typescript
// Pattern: Server-side ordering with local optimism
export const addStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number())
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number(),
    userColor: v.string()
  },
  handler: async (ctx, args) => {
    // Get current max order
    const lastStroke = await ctx.db
      .query("strokes")
      .withIndex("by_session_order", q => q.eq("sessionId", args.sessionId))
      .order("desc")
      .first()
    
    const strokeOrder = (lastStroke?.strokeOrder ?? 0) + 1
    
    return await ctx.db.insert("strokes", {
      ...args,
      strokeOrder
    })
  }
})
```

**Benefits**:
- Consistent stroke order across all clients
- No race conditions
- Deterministic canvas state

### 5. Real-time Data Subscription Pattern
**Problem**: Components need to react to real-time data changes efficiently.

**Solution**: Convex useQuery with conditional subscriptions.

```typescript
// Pattern: Conditional real-time subscriptions
export function usePaintingSession(sessionId: Id<"paintingSessions"> | null) {
  // Only subscribe when sessionId exists
  const strokes = useQuery(
    api.strokes.getSessionStrokes,
    sessionId ? { sessionId } : "skip"
  )
  
  const presence = useQuery(
    api.presence.getSessionPresence,
    sessionId ? { sessionId } : "skip"
  )
  
  // Mutations for optimistic updates
  const addStroke = useMutation(api.strokes.addStroke)
  const updatePresence = useMutation(api.presence.updateUserPresence)
  
  return {
    strokes: strokes || [],
    presence: presence || [],
    addStrokeToSession: useCallback((points, color, size, opacity) => {
      if (!sessionId) return
      addStroke({
        sessionId,
        points,
        brushColor: color,
        brushSize: size,
        opacity,
        userColor: currentUser.color
      })
    }, [sessionId, addStroke, currentUser.color]),
    updateUserPresence: useCallback((x, y, isDrawing, tool) => {
      if (!sessionId) return
      updatePresence({
        sessionId,
        cursorX: x,
        cursorY: y,
        isDrawing,
        currentTool: tool
      })
    }, [sessionId, updatePresence])
  }
}
```

**Benefits**:
- Efficient data subscriptions
- Automatic re-rendering on changes
- Clean separation of concerns

## Component Architecture Patterns

### 1. Canvas Ref Pattern
**Problem**: Parent components need to control canvas operations imperatively.

**Solution**: Forward ref with exposed methods.

```typescript
// Pattern: Imperative canvas control via ref
export interface CanvasRef {
  undo: () => void
  redo: () => void
  clear: () => void
  getImageData: () => string | null
}

export const Canvas = forwardRef<CanvasRef, CanvasProps>((props, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  
  useImperativeHandle(ref, () => ({
    undo: () => {
      // Undo implementation
    },
    redo: () => {
      // Redo implementation
    },
    clear: () => {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
      }
    },
    getImageData: () => {
      return canvasRef.current?.toDataURL() || null
    }
  }))
  
  return <canvas ref={canvasRef} {...props} />
})
```

**Benefits**:
- Clean parent-child communication
- Encapsulated canvas operations
- Type-safe imperative API

### 2. Custom Hook Pattern
**Problem**: Complex state logic needs to be reusable and testable.

**Solution**: Extract state logic into custom hooks.

```typescript
// Pattern: Custom hook for complex state
export function usePaintingSession(sessionId: Id<"paintingSessions"> | null) {
  const [currentUser] = useState(() => generateRandomUser())
  
  // Real-time subscriptions
  const strokes = useQuery(api.strokes.getSessionStrokes, ...)
  const presence = useQuery(api.presence.getSessionPresence, ...)
  
  // Mutations
  const addStroke = useMutation(api.strokes.addStroke)
  const createSession = useMutation(api.paintingSessions.createSession)
  
  // Derived state
  const isLoading = strokes === undefined || presence === undefined
  
  // Memoized callbacks
  const addStrokeToSession = useCallback((...args) => {
    // Implementation
  }, [sessionId, addStroke])
  
  return {
    strokes: strokes || [],
    presence: presence || [],
    currentUser,
    isLoading,
    addStrokeToSession,
    createNewSession: createSession
  }
}
```

**Benefits**:
- Reusable state logic
- Easy testing
- Clean component code

### 3. Compound Component Pattern
**Problem**: Related UI components need to work together with shared state.

**Solution**: Compound components with context sharing.

```typescript
// Pattern: Compound components for tool panel
interface ToolPanelProps {
  color: string
  size: number
  opacity: number
  onColorChange: (color: string) => void
  onSizeChange: (size: number) => void
  onOpacityChange: (opacity: number) => void
  // ... other props
}

export function ToolPanel(props: ToolPanelProps) {
  return (
    <div className="tool-panel">
      <ColorPicker value={props.color} onChange={props.onColorChange} />
      <SizeSlider value={props.size} onChange={props.onSizeChange} />
      <OpacitySlider value={props.opacity} onChange={props.onOpacityChange} />
      <ActionButtons onUndo={props.onUndo} onRedo={props.onRedo} />
    </div>
  )
}
```

**Benefits**:
- Cohesive tool grouping
- Shared styling and behavior
- Easy to extend with new tools

## Data Flow Patterns

### 1. Unidirectional Data Flow
**Problem**: Complex state updates can lead to inconsistent UI state.

**Solution**: Single source of truth with unidirectional updates.

```
User Action → Local State Update → Backend Mutation → Real-time Update → UI Re-render
     ↓              ↓                    ↓               ↓              ↓
  Drawing      Optimistic UI      Convex Database    All Clients    Consistent State
```

### 2. Event-Driven Updates
**Problem**: Multiple components need to react to the same events.

**Solution**: Event-driven architecture with clear data flow.

```typescript
// Pattern: Event-driven canvas updates
const handlePointerDown = (e: PointerEvent) => {
  setIsDrawing(true)
  const point = getPointerPosition(e)
  setCurrentStroke([point])
  
  // Trigger presence update
  updateUserPresence(point.x, point.y, true, 'brush')
}

const handlePointerMove = (e: PointerEvent) => {
  if (!isDrawing) return
  
  const point = getPointerPosition(e)
  
  // Update local state
  setCurrentStroke(prev => [...prev, point])
  
  // Update presence
  updateUserPresence(point.x, point.y, true, 'brush')
}

const handlePointerUp = () => {
  setIsDrawing(false)
  
  // Persist stroke
  if (currentStroke.length > 0) {
    addStrokeToSession(currentStroke, color, size, opacity)
  }
  
  // Clear local stroke
  setCurrentStroke([])
}
```

## Performance Patterns

### 1. Throttling Pattern
**Problem**: High-frequency events can overwhelm the network and UI.

**Solution**: Throttle updates to reasonable frequencies.

```typescript
// Pattern: Throttled presence updates
const updateUserPresence = useCallback(
  throttle((x: number, y: number, isDrawing: boolean, tool: string) => {
    // Update logic
  }, 16), // 60fps max
  [dependencies]
)
```

### 2. Memoization Pattern
**Problem**: Expensive calculations run on every render.

**Solution**: Memoize expensive operations.

```typescript
// Pattern: Memoized stroke rendering
const renderedStrokes = useMemo(() => {
  return strokes.map(stroke => ({
    ...stroke,
    path: getStroke(stroke.points, {
      size: stroke.brushSize,
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5
    })
  }))
}, [strokes])
```

### 3. Lazy Loading Pattern
**Problem**: Large datasets can slow initial load.

**Solution**: Load data progressively as needed.

```typescript
// Pattern: Paginated stroke loading (future enhancement)
const { data: strokes, loadMore } = usePaginatedQuery(
  api.strokes.getSessionStrokes,
  { sessionId, limit: 100 }
)
```

## Error Handling Patterns

### 1. Graceful Degradation
**Problem**: Network issues shouldn't break the drawing experience.

**Solution**: Fallback to local-only mode with sync when reconnected.

```typescript
// Pattern: Graceful degradation
const [isOnline, setIsOnline] = useState(navigator.onLine)

useEffect(() => {
  const handleOnline = () => setIsOnline(true)
  const handleOffline = () => setIsOnline(false)
  
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  
  return () => {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }
}, [])

// Use local storage when offline
const addStrokeToSession = useCallback((stroke) => {
  if (isOnline) {
    // Normal real-time sync
    addStroke(stroke)
  } else {
    // Store locally for later sync
    storeStrokeLocally(stroke)
  }
}, [isOnline, addStroke])
```

### 2. Error Boundaries
**Problem**: Component errors can crash the entire app.

**Solution**: Error boundaries with fallback UI.

```typescript
// Pattern: Error boundary for canvas
class CanvasErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  
  static getDerivedStateFromError(error) {
    return { hasError: true }
  }
  
  render() {
    if (this.state.hasError) {
      return (
        <div className="error-fallback">
          <h2>Something went wrong with the canvas.</h2>
          <button onClick={() => window.location.reload()}>
            Reload Page
          </button>
        </div>
      )
    }
    
    return this.props.children
  }
}
```

## Security Patterns

### 1. Input Validation
**Problem**: User input needs validation to prevent malicious data.

**Solution**: Schema validation at API boundaries.

```typescript
// Pattern: Convex schema validation
export const addStroke = mutation({
  args: {
    sessionId: v.id("paintingSessions"),
    points: v.array(v.object({
      x: v.number(),
      y: v.number(),
      pressure: v.optional(v.number())
    })),
    brushColor: v.string(),
    brushSize: v.number(),
    opacity: v.number()
  },
  handler: async (ctx, args) => {
    // Validation is automatic via schema
    // Additional business logic validation
    if (args.points.length === 0) {
      throw new Error("Stroke must have at least one point")
    }
    
    if (args.brushSize < 1 || args.brushSize > 100) {
      throw new Error("Invalid brush size")
    }
    
    // Safe to proceed
    return await ctx.db.insert("strokes", args)
  }
})
```

### 2. Rate Limiting
**Problem**: Users could spam the system with rapid requests.

**Solution**: Client-side throttling with server-side limits.

```typescript
// Pattern: Client-side rate limiting
const addStrokeThrottled = useCallback(
  throttle((stroke) => {
    addStroke(stroke)
  }, 10), // Max 100 strokes per second
  [addStroke]
)
```

These patterns provide a solid foundation for building real-time collaborative applications with React and Convex, ensuring good performance, user experience, and maintainability.
