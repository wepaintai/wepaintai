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
  
- **shadcn/ui** - Component library
  - Accessible components
  - Customizable with Tailwind
  - Radix UI primitives

### Backend & Database
- **Convex** - Backend platform
  - Real-time database
  - Serverless functions
  - File storage
  - Built-in TypeScript support
  
- **Convex Auth** - Authentication
  - Email/password support
  - Social login providers
  - Session management

### Drawing & Graphics
- **perfect-freehand** - Stroke processing
  - Pressure simulation
  - Smooth line interpolation
  - Customizable brush settings
  
- **HTML5 Canvas API** - Drawing surface
  - 2D context for rendering
  - Image manipulation

### AI Integration
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
│   ├── hooks/          # Custom React hooks
│   └── utils/          # Utility functions
├── convex/
│   ├── schema.ts       # Database schema
│   ├── auth.config.ts  # Auth configuration
│   └── functions/      # Backend functions
├── public/             # Static assets
└── styles/            # Global styles
```

### Environment Variables
```env
# Convex
CONVEX_DEPLOYMENT=
NEXT_PUBLIC_CONVEX_URL=

# Replicate
REPLICATE_API_TOKEN=

# Auth providers (optional)
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
```

## Technical Constraints

### Performance Requirements
- Initial paint < 1s
- Time to interactive < 3s
- Smooth 60fps drawing
- Canvas size up to 4K resolution

### Browser Support
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile Safari/Chrome

### API Limits
- Replicate API: Rate limits apply
- Convex: Storage and bandwidth limits
- Image size: Max 10MB for inpainting

## Dependencies

### Core Dependencies
```json
{
  "@tanstack/start": "latest",
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "convex": "latest",
  "@convex-dev/auth": "latest",
  "perfect-freehand": "^1.2.0",
  "tailwindcss": "^3.4.0",
  "@radix-ui/react-*": "latest"
}
```

### Dev Dependencies
```json
{
  "typescript": "^5.0.0",
  "@types/react": "^18.2.0",
  "@types/node": "^20.0.0",
  "eslint": "^8.0.0",
  "prettier": "^3.0.0"
}
```

## Tool Usage Patterns

### Canvas Rendering
```typescript
// Efficient canvas updates
const renderFrame = () => {
  ctx.clearRect(dirtyRect)
  ctx.drawImage(bufferCanvas, dirtyRect)
  requestAnimationFrame(renderFrame)
}
```

### Convex Patterns
```typescript
// Optimistic updates
const { mutate, isLoading } = useMutation(
  api.paintings.update
).withOptimisticUpdate((store, args) => {
  // Update local state immediately
})
```

### Error Handling
```typescript
// Graceful degradation
try {
  await saveToCloud()
} catch (error) {
  saveToLocalStorage()
  showRetryNotification()
}
```

## Security Considerations

1. **Input Validation** - Sanitize all user inputs
2. **API Keys** - Server-side only, never exposed
3. **CORS** - Properly configured for Convex
4. **Content Security Policy** - Restrict resource loading
5. **Rate Limiting** - Prevent API abuse

## Performance Optimizations

1. **Canvas Layering** - Separate layers for performance
2. **Debouncing** - Reduce API calls
3. **Web Workers** - Offload heavy computations
4. **Lazy Loading** - Load features as needed
5. **Image Compression** - Optimize before upload