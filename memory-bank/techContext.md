# iPaintAI - Technical Context

## Technologies Used

### Frontend Stack
- **TanStack Start** - Full-stack React framework
  - Server-side rendering capabilities
  - File-based routing
  - Built-in optimization
  
- **React 18+** - UI library
  - Hooks for state management
  - Concurrent features for performance
  
- **TypeScript** - Type safety
  - Strict mode enabled
  - Interface-driven development

### Styling & UI
- **Tailwind CSS** - Utility-first CSS
  - Custom color palette
  - Responsive design utilities
  
- **Lucide React** - Icon library
  - Consistent iconography
  - Tree-shakeable imports

### Backend & Database
- **Convex** - Real-time backend platform
  - Real-time database with WebSocket connections
  - Serverless functions with TypeScript
  - Built-in optimistic updates
  - Automatic schema validation
  
### Drawing & Graphics
- **perfect-freehand** - Stroke processing
  - Pressure simulation
  - Smooth line interpolation
  - Customizable brush settings
  
- **HTML5 Canvas API** - Drawing surface
  - 2D context for rendering
  - Pointer events for multi-touch
  - Real-time collaborative rendering

### Real-time Features
- **Convex Real-time Queries** - Live data synchronization
  - WebSocket connections
  - Automatic reconnection
  - Optimistic updates
  
- **Presence System** - User tracking
  - Live cursor positions
  - User identification
  - Session management

### AI Integration (Planned)
- **Replicate API** - AI model hosting
  - Ideogram V2 Turbo model
  - REST API interface
  - Async processing

## Development Setup

### Prerequisites
```bash
# Required versions
Node.js >= 18.0.0
npm >= 9.0.0
```

### Project Structure
```
ipaintai/
├── app/
│   ├── routes/          # TanStack Start routes
│   ├── components/      # React components
│   │   ├── Canvas.tsx   # Real-time collaborative canvas
│   │   ├── PaintingView.tsx # Main container
│   │   ├── ToolPanel.tsx    # Drawing tools
│   │   └── SessionInfo.tsx  # User presence display
│   ├── hooks/          # Custom React hooks
│   │   └── usePaintingSession.ts # Real-time session hook
│   ├── lib/            # Library integrations
│   │   └── convex.tsx  # Convex client setup
│   └── utils/          # Utility functions
├── convex/
│   ├── schema.ts       # Database schema
│   ├── paintingSessions.ts # Session management
│   ├── strokes.ts      # Stroke operations
│   └── presence.ts     # User presence tracking
├── public/             # Static assets
└── styles/            # Global styles
```

### Environment Variables
```env
# Convex
CONVEX_DEPLOYMENT=
VITE_CONVEX_URL=

# Replicate (planned)
REPLICATE_API_TOKEN=
```

## Real-time Architecture

### Database Schema (Convex)
```typescript
// paintingSessions table
{
  name?: string,
  canvasWidth: number,
  canvasHeight: number,
  isPublic: boolean,
  createdBy?: Id<"users">
}

// strokes table
{
  sessionId: Id<"paintingSessions">,
  userId?: Id<"users">,
  userColor: string,
  points: Array<{x: number, y: number, pressure?: number}>,
  brushColor: string,
  brushSize: number,
  opacity: number,
  strokeOrder: number
}

// userPresence table
{
  sessionId: Id<"paintingSessions">,
  userId?: Id<"users">,
  userColor: string,
  userName: string,
  cursorX: number,
  cursorY: number,
  isDrawing: boolean,
  currentTool: string,
  lastSeen: number
}
```

### Real-time Data Flow
1. **User draws stroke** → Local canvas update (optimistic)
2. **Stroke data sent** → Convex mutation
3. **Database updated** → All clients receive update
4. **Canvas redraws** → Consistent state across users

### Session Management
- **URL-based sharing**: `?session=<sessionId>`
- **Automatic session creation**: New session if no ID provided
- **User identification**: Random names and colors
- **Presence tracking**: Live cursor positions and user count

## Technical Constraints

### Performance Requirements
- Initial paint < 1s ✅
- Time to interactive < 3s ✅
- Smooth 60fps drawing ✅
- Real-time latency < 100ms
- Canvas size up to 800x600 (current)

### Browser Support
- Chrome 90+ ✅
- Firefox 88+ ✅
- Safari 14+ ✅
- Edge 90+ ✅
- Mobile Safari/Chrome (needs optimization)

### Real-time Limits
- Convex: 1000 concurrent connections (free tier)
- Stroke rate: Optimized for smooth drawing
- Presence updates: Throttled to 60fps

## Dependencies

### Core Dependencies
```json
{
  "@tanstack/react-router": "^1.87.0",
  "@tanstack/start": "^1.87.0",
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "convex": "^1.17.4",
  "perfect-freehand": "^1.2.2",
  "tailwindcss": "^4.0.0",
  "lucide-react": "^0.468.0"
}
```

### Dev Dependencies
```json
{
  "typescript": "^5.7.3",
  "@types/react": "^18.3.17",
  "@types/node": "^22.10.2",
  "vite": "^6.0.5",
  "vinxi": "^0.5.1"
}
```

## Implementation Patterns

### Real-time Canvas Updates
```typescript
// Optimistic drawing with real-time sync
const handlePointerMove = (e) => {
  const point = getPointerPosition(e)
  
  // Update presence immediately
  updateUserPresence(point.x, point.y, isDrawing, 'brush')
  
  if (isDrawing) {
    // Local update for responsiveness
    drawStroke(context, currentStroke)
    
    // Sync to database
    addStrokeToSession(currentStroke, color, size, opacity)
  }
}
```

### Convex Query Patterns
```typescript
// Real-time data subscription
const strokes = useQuery(
  api.strokes.getSessionStrokes,
  sessionId ? { sessionId } : "skip"
)

// Optimistic mutations
const addStroke = useMutation(api.strokes.addStroke)
```

### Session Hook Pattern
```typescript
// Custom hook for session management
export function usePaintingSession(sessionId) {
  const strokes = useQuery(api.strokes.getSessionStrokes, ...)
  const presence = useQuery(api.presence.getSessionPresence, ...)
  const addStroke = useMutation(api.strokes.addStroke)
  
  return {
    strokes: strokes || [],
    presence: presence || [],
    addStrokeToSession,
    updateUserPresence,
    currentUser
  }
}
```

## Security Considerations

1. **Input Validation** - Sanitize stroke data and user inputs
2. **Rate Limiting** - Prevent spam drawing/presence updates
3. **Session Access** - Public sessions by default (no auth required)
4. **Data Validation** - Convex schema validation
5. **XSS Prevention** - Sanitized user names and content

## Performance Optimizations

### Implemented
1. **Optimistic Updates** - Immediate local canvas updates
2. **Efficient Redrawing** - Only redraw when strokes change
3. **Stroke Ordering** - Consistent rendering across clients
4. **Presence Throttling** - Limit cursor update frequency
5. **Canvas Layering** - Separate current stroke from history

### Planned
1. **Stroke Batching** - Group rapid strokes for efficiency
2. **Canvas Virtualization** - Handle large canvases
3. **Mobile Optimization** - Touch event handling
4. **Connection Recovery** - Handle network interruptions
5. **Memory Management** - Cleanup old presence data

## Real-time Testing

### Multi-user Testing Methods
1. **Multiple browser tabs** - Same device testing
2. **Different browsers** - Cross-browser compatibility
3. **Incognito windows** - Separate user sessions
4. **Network simulation** - Test with slow connections
5. **Mobile devices** - Touch interaction testing

### Expected Behaviors
- Instant stroke appearance across all users
- Live cursor tracking with user identification
- Session persistence via URL sharing
- Automatic user count updates
- Graceful handling of user disconnections

## Known Technical Debt

1. **Session-wide undo/redo** - Currently local only
2. **Mobile touch optimization** - Needs pressure sensitivity
3. **Error boundaries** - Better error handling for network issues
4. **Performance monitoring** - Real-time metrics collection
5. **Stroke compression** - Optimize data transfer for complex drawings

## Future Enhancements

1. **AI Integration** - Inpainting with collaborative sessions
2. **Authentication** - Optional user accounts
3. **Session persistence** - Save/load collaborative sessions
4. **Advanced tools** - Layers, selection, text
5. **Voice chat** - Audio communication during collaboration
