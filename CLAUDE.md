# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev              # Local dev with local Convex backend (free)
pnpm dev:cloud        # Local dev with cloud Convex backend
pnpm dev:prod-db      # Local dev connected to production database (use with caution!)
pnpm build            # Build for production
pnpm start            # Start production server

# Individual services (if needed)
pnpm dev:app          # Frontend only
pnpm dev:convex:local # Local Convex backend only
pnpm dev:convex:cloud # Cloud Convex backend only

# Convex deployment
npx convex deploy     # Deploy backend to production
```

Note: No test or lint commands are currently configured.

## Architecture

### Tech Stack
- **Frontend**: TanStack Start (React 19 + file-based routing), TypeScript, Tailwind CSS
- **Backend**: Convex (real-time serverless database with WebSocket support)
- **Drawing**: perfect-freehand library for smooth strokes
- **Deployment**: Vercel (frontend) + Convex Cloud (backend)

### Key Patterns

1. **Real-time Collaboration**
   - Optimistic updates: Strokes drawn immediately on local canvas
   - Live strokes synced via WebSocket for multi-user drawing
   - Presence system tracks cursors and user states
   - URL-based session sharing

2. **Canvas Architecture**
   - Triple canvas system: main canvas (committed strokes) + drawing canvas (active stroke) + image canvas (uploaded/AI images)
   - Single-flight pattern prevents duplicate stroke submissions
   - Coalesced pointer events for smooth drawing performance
   - Z-index layering: strokes (bottom), images (middle), live drawing (top)

3. **Data Flow**
   - Frontend components use Convex hooks (`useQuery`, `useMutation`)
   - Backend functions in `/convex` handle real-time updates
   - Session state managed via URL parameters

### Directory Structure
- `/app`: React components and routes
  - `/routes`: File-based routing pages
  - `/components`: UI components (Canvas, ToolPanel, etc.)
  - `/hooks`: Custom React hooks
- `/convex`: Backend functions and schema
  - Real-time queries, mutations, and subscriptions
  - Database schema defined in `schema.ts`

### Environment Variables
- `VITE_CONVEX_URL`: Backend URL (auto-set by dev commands)
- `VITE_INTERNAL_HIDE_ADMIN_PANEL`: Hide debug panel in production
- `VITE_PASSWORD_PROTECTION_ENABLED`: Enable/disable password protection (set to 'true' for production, 'false' for local dev)
- `VITE_AUTH_DISABLED`: Disable all auth for local dev (set to 'true' to bypass auth, 'false' or unset for normal auth flow)
- Frontend env vars must be prefixed with `VITE_`

#### Convex Backend Environment Variables
Set these in the Convex dashboard (Settings > Environment Variables):
- `REPLICATE_API_TOKEN`: Your Replicate API token for AI image generation

### Development Notes
- Use `pnpm dev` for local development with free local backend
- The admin panel (bottom-left debug info) is hidden in production
- When modifying Convex schema, the backend will auto-migrate
- Production database access (`pnpm dev:prod-db`) should be used carefully

### Layer System Implementation

1. **Layer Types**
   - `stroke`: Paint strokes layer (always present, shows "Painting" or "Painting (empty)")
   - `image`: Uploaded images
   - `ai-image`: AI-generated images

2. **Layer Management**
   - Layers are computed in `PaintingView` component from strokes and images
   - Each layer has: id, type, name, visible, opacity, order, thumbnailUrl
   - Paint strokes are combined into a single "Painting" layer
   - Layer visibility, opacity, and order can be adjusted via the ToolPanel

3. **Important Implementation Details**
   - **Guest User Support**: The `usePaintingSession` hook allows guest users (without authentication) to paint by accepting `undefined` userId
   - **Stroke Detection**: The painting layer shows as "Painting (empty)" when no strokes exist, "Painting" when strokes are present
   - **Data Source**: Both `PaintingView` and `Canvas` components must use strokes from the same source (`usePaintingSession` hook) to ensure consistency
   - **Layer Ordering**: Higher order numbers appear on top (painted last)

### AI Image Generation
- Uses Replicate's Flux Kontext Pro model for AI image editing
- The model takes the canvas content as input along with a text prompt
- Weight parameter controls canvas influence (0-1 in UI, mapped to 0-2 for Replicate API)
  - UI slider: 0 = ignore canvas, 1 = maximum canvas preservation
  - Default weight: 0.85 (translates to 1.7 in Replicate)
- Known issue: Replicate sometimes returns URLs as character arrays instead of strings
  - The code handles this by detecting and joining character arrays
- Images are stored in Convex storage for reliable serving
- Safety tolerance is limited to 2 when using input images
- Content moderation can sometimes flag benign content - users should try different prompts
- API parameter naming: Uses `input_image` (not `image`) for the canvas URL
- Production Convex URL: `https://graceful-blackbird-369.convex.cloud`

### Debugging Tips
- For noisy Convex logs, use the `[AI-GEN]` prefix to filter AI generation logs
- Check both development and production deployments - they use different URLs
- Production logs: https://dashboard.convex.dev/t/travis-irby/ipaintai-core/graceful-blackbird-369/logs
- Development logs: https://dashboard.convex.dev/d/polished-flamingo-936

## AI Generation Implementation Details

The AI generation feature (`/convex/aiGeneration.ts`) integrates with Replicate's Flux Kontext Pro model. Key implementation notes:

1. **Replicate API Quirk**: The model sometimes returns the output URL as an array of single characters (e.g., `["h", "t", "t", "p", "s", ":", "/", "/", ...]`) instead of a string. The code handles this by:
   - Detecting arrays with many single-character strings
   - Joining them to form the complete URL
   - Falling back to direct URL usage if storage fails

2. **Image Storage**: Generated images are downloaded and stored in Convex storage to ensure reliable serving and avoid CORS issues.

3. **Error Handling**: 
   - Content moderation can flag benign content (error E005)
   - Single character URLs (just "h") indicate the Replicate bug
   - Proper error messages guide users to try different prompts

4. **Canvas Integration**: The canvas content is captured as a base64 PNG and sent along with the text prompt to the AI model.

5. **Weight Parameter**: The UI presents a 0-1 slider that gets multiplied by 2 before sending to Replicate:
   - 0.0 → 0.0 (AI ignores canvas completely)
   - 0.5 → 1.0 (balanced influence)
   - 0.85 → 1.7 (default - strong canvas preservation)
   - 1.0 → 2.0 (maximum canvas preservation)