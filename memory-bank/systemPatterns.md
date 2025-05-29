# iPaintAI - System Patterns

## Architecture Overview

```mermaid
graph TB
    subgraph "Client Layer"
        UI[React UI - TanStack Start]
        Canvas[Canvas Controller]
        State[State Management]
    end
    
    subgraph "Backend Layer"
        Convex[Convex Backend]
        Auth[Convex Auth]
        Storage[File Storage]
    end
    
    subgraph "External Services"
        Replicate[Replicate API]
    end
    
    UI --> Canvas
    UI --> State
    Canvas --> State
    State --> Convex
    Auth --> Convex
    Convex --> Storage
    Convex --> Replicate
```

## Key Technical Decisions

### 1. Canvas Architecture
- **Pattern**: Single Canvas with State Management
- **Implementation**: HTML5 Canvas API with React refs
- **Drawing Engine**: perfect-freehand for stroke processing
- **Rationale**: Direct canvas manipulation for performance

### 2. State Management Pattern
```typescript
// Canvas state structure
interface CanvasState {
  strokes: Stroke[]
  currentStroke: Stroke | null
  history: HistoryStack
  tool: ToolType
  toolSettings: ToolSettings
}

// Separate concerns
- UI State (React Context)
- Canvas State (React State)
- Persistent State (Convex)
```

### 3. Drawing Pipeline
```mermaid
graph LR
    Input[User Input] --> Process[perfect-freehand]
    Process --> Render[Canvas Render]
    Render --> State[Update State]
    State --> Save{Authenticated?}
    Save -->|Yes| Convex[Auto-save to Convex]
    Save -->|No| Local[Keep in Memory]
```

### 4. Inpainting Workflow
```mermaid
sequenceDiagram
    participant User
    participant Canvas
    participant Backend
    participant Replicate
    
    User->>Canvas: Draw mask
    Canvas->>Canvas: Overlay mask on image
    User->>Canvas: Trigger inpaint
    Canvas->>Backend: Send image + mask
    Backend->>Replicate: Call Ideogram API
    Replicate-->>Backend: Return result
    Backend-->>Canvas: Send inpainted image
    Canvas->>Canvas: Merge with canvas
```

## Component Relationships

### Core Components
1. **App.tsx** - Root component, routing setup
2. **CanvasView** - Main painting interface
3. **ToolPanel** - Tool selection and settings
4. **AuthModal** - Authentication flow
5. **Canvas** - Core drawing component

### Component Communication
- **Props Down**: Tool settings, auth state
- **Events Up**: Canvas actions, tool changes
- **Context**: Global UI state, theme
- **Convex Hooks**: Data fetching, mutations

## Critical Implementation Paths

### 1. Drawing Performance
```typescript
// Optimize rendering with RAF
const draw = useCallback(() => {
  if (!isDrawing) return
  
  requestAnimationFrame(() => {
    // Render only changed portions
    renderStroke(currentStroke)
  })
}, [isDrawing, currentStroke])
```

### 2. Auto-save Strategy
```typescript
// Debounced save with diff detection
const saveCanvas = useMutation(api.paintings.save)
const debouncedSave = useDebouncedCallback(
  async (canvasData) => {
    if (!isAuthenticated) return
    await saveCanvas({ imageData: canvasData })
  },
  30000 // 30 seconds
)
```

### 3. Inpainting Integration
```typescript
// Mask to inpaint flow
const handleInpaint = async (maskCanvas: HTMLCanvasElement) => {
  // 1. Merge mask with original
  const imageData = mergeCanvases(mainCanvas, maskCanvas)
  
  // 2. Call backend
  const result = await inpaintMutation({
    image: imageData,
    mask: maskData
  })
  
  // 3. Apply result
  applyInpaintResult(result)
}
```

## Design Patterns in Use

1. **Command Pattern** - Undo/Redo implementation
2. **Observer Pattern** - Canvas state changes
3. **Strategy Pattern** - Tool behaviors
4. **Facade Pattern** - Convex API wrapper
5. **Debounce Pattern** - Auto-save optimization

## Data Flow Patterns

### Unidirectional Data Flow
```
User Action → State Update → Canvas Render → Side Effects (Save)
```

### Authentication Flow
```
Anonymous Use → Optional Sign In → Token Storage → Enhanced Features
```

### Error Handling
```
Try Operation → Catch Error → User Feedback → Fallback Behavior