# iPaintAI - Active Context

## Current Work Focus
- **Phase**: Project Planning & Setup
- **Status**: Planning complete, ready to begin Phase 1 implementation
- **Next Step**: Initialize TanStack Start project and set up development environment

## Recent Changes
- Created comprehensive project plan based on user requirements
- Established Memory Bank documentation structure
- Defined technical architecture and implementation approach

## Next Steps

### Immediate (Phase 1 - Core Drawing)
1. Initialize TanStack Start project
2. Set up TypeScript configuration
3. Install and configure Tailwind CSS
4. Add shadcn/ui components
5. Implement basic canvas component
6. Integrate perfect-freehand library
7. Create tool panel UI
8. Implement brush controls (size, opacity, color)
9. Add undo/redo/clear functionality

### Upcoming (Phase 2 - Backend & Auth)
1. Set up Convex project
2. Define database schema
3. Implement Convex Auth
4. Create save/load functions
5. Add user authentication UI

### Future (Phase 3 & 4)
- Replicate API integration
- Inpainting implementation
- Auto-save functionality
- Export features
- Mobile optimization

## Active Decisions and Considerations

### Architecture Decisions
1. **Single Canvas Approach** - Using one canvas for both drawing and masking, switching modes via tool selection
2. **State Management** - Local React state for canvas, Convex for persistence
3. **Inpainting UX** - Mask drawn directly on canvas with same brush tool
4. **Auth Strategy** - Optional authentication, features work without login

### Technical Considerations
1. **Performance** - Need to optimize canvas rendering for smooth drawing
2. **Mobile Touch** - Must handle both mouse and touch events
3. **Image Size** - Need to handle/compress large canvases for API calls
4. **Error Handling** - Graceful fallbacks for network issues

### UI/UX Patterns
1. **Tool Panel** - Fixed position, minimal but functional
2. **Color Picker** - Simple, accessible implementation
3. **Sliders** - For size and opacity with visual feedback
4. **Auth Modal** - Non-blocking, can dismiss and continue painting

## Important Patterns and Preferences

### Code Organization
- Feature-based folder structure
- Shared components in dedicated folder
- Convex functions organized by domain
- Utilities separated by concern

### Development Workflow
1. Implement features incrementally
2. User tests each feature before moving on
3. No automated testing per user preference
4. Focus on core functionality first

### Styling Approach
- Tailwind utilities for rapid development
- shadcn/ui for consistent components
- Custom styles only when necessary
- Mobile-first responsive design

## Learnings and Project Insights

### User Requirements
- Simplicity is key - user wants minimal features initially
- AI inpainting is the main differentiator
- Authentication should not block core functionality
- Auto-save important for user retention

### Technical Insights
- TanStack Start provides good foundation for SSR React app
- Convex simplifies backend complexity significantly
- perfect-freehand handles drawing complexity well
- Ideogram V2 Turbo suitable for inpainting use case

### Implementation Strategy
- Start with working canvas, add features progressively
- Backend can be added after core drawing works
- AI features come after basic functionality proven
- Polish and optimization at the end

## Current Blockers
- None - ready to begin implementation

## Questions for User
- None currently - requirements are clear

## Notes
- Project uses Supabase MCP for any Supabase-related work (per user's custom rules)
- User will handle all testing (no automated tests)
- Focus on getting MVP working quickly, iterate based on feedback