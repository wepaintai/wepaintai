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
- **Authentication**: Clerk (user authentication and management)
- **Drawing**: perfect-freehand library for smooth strokes
- **Canvas Library**: Konva.js (via react-konva) for advanced canvas rendering and layer management
- **Deployment**: Vercel (frontend) + Convex Cloud (backend)

### Key Patterns

1. **Real-time Collaboration**
   - Optimistic updates: Strokes drawn immediately on local canvas
   - Live strokes synced via WebSocket for multi-user drawing
   - Presence system tracks cursors and user states
   - URL-based session sharing

2. **Canvas Architecture**
   - **Dual Implementation**: 
     - `Canvas.tsx`: Traditional HTML5 Canvas implementation (legacy)
     - `KonvaCanvas.tsx`: Konva.js implementation with advanced features (recommended)
   - **Konva Features**:
     - Each visual layer maps to a Konva Layer component
     - Built-in dragging support for layers when pan tool is active
     - Automatic hit detection and event handling
     - Efficient batch drawing and caching
   - Single-flight pattern prevents duplicate stroke submissions
   - Coalesced pointer events for smooth drawing performance
   - Layer ordering: Higher order numbers appear on top

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
- `VITE_CLERK_PUBLISHABLE_KEY`: Clerk publishable key for authentication
- `VITE_CLERK_FRONTEND_API_URL`: Clerk Frontend API URL (e.g., https://your-app.clerk.accounts.dev)
- `CLERK_SECRET_KEY`: Clerk secret key (for production deployments)
- `VITE_INTERNAL_HIDE_ADMIN_PANEL`: Hide debug panel in production
- `VITE_PASSWORD_PROTECTION_ENABLED`: Enable/disable password protection (set to 'true' for production, 'false' for local dev)
- `VITE_AUTH_DISABLED`: Disable all auth for local dev (set to 'true' to bypass auth, 'false' or unset for normal auth flow)
- Frontend env vars must be prefixed with `VITE_`

#### Convex Backend Environment Variables
Set these in the Convex dashboard (Settings > Environment Variables):
- `REPLICATE_API_TOKEN`: Your Replicate API token for AI image generation
- `REPLICATE_MODEL_VERSION`: Replicate model version ID (default: `15589a1a9e6b240d246752fc688267b847db4858910cc390794703384b6a5443` for Flux Kontext Pro)
- `REPLICATE_TIMEOUT_SECONDS`: Timeout for Replicate API calls in seconds (default: 180) - applies to AI generation, background removal, and image merge operations
- `POLAR_API_KEY`: Your Polar API key for payment processing
- `POLAR_WEBHOOK_SECRET`: Webhook secret from Polar for signature verification
- `POLAR_API_BASE_URL`: (Optional) API base URL
  - For sandbox (default): Leave empty or set to `https://sandbox-api.polar.sh`
  - For production: Set to `https://api.polar.sh`

### Authentication Setup
1. **Create a Clerk account** at https://clerk.com
2. **Create a new application** in Clerk dashboard
3. **Create a JWT Template**:
   - Go to JWT Templates in Clerk dashboard
   - Create a new template named "convex" (must be exactly this name)
   - Copy the Issuer URL (Frontend API URL)
4. **Set environment variables**:
   - `VITE_CLERK_PUBLISHABLE_KEY` from Clerk dashboard → API Keys
   - `VITE_CLERK_FRONTEND_API_URL` from JWT Templates → Issuer URL
   - `CLERK_SECRET_KEY` from Clerk dashboard → API Keys (for production)
5. **Configure Convex**:
   - Set `CLERK_FRONTEND_API_URL` in Convex dashboard environment variables
   - The auth config in `convex/auth.config.ts` uses this for JWT validation

### Development Notes
- Use `pnpm dev` for local development with free local backend
- The admin panel (bottom-left debug info) is hidden in production
- When modifying Convex schema, the backend will auto-migrate
- Production database access (`pnpm dev:prod-db`) should be used carefully
- **Canvas Toggle**: In development, you can toggle between Canvas and KonvaCanvas implementations
- **Keyboard Shortcuts**: Tool shortcuts work when not typing in input fields

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
   - Paint layer order and visibility are persisted in the database (paintingSessions table)

3. **Konva Layer Integration**
   - Each app layer maps to a Konva `<Layer>` component
   - Layers are rendered in order: `.sort((a, b) => a.order - b.order)`
   - Stroke layer contains all paint strokes as `<Path>` elements
   - Image layers contain individual `<KonvaImage>` components
   - Dragging is enabled when pan tool is selected (`draggable={selectedTool === 'pan'}`)
   - Position updates are saved to database on drag end

4. **Layer Ordering System**
   - **Unified Reordering**: Uses `api.layers.reorderLayer` mutation for all layer types
   - **Order Values**: 0-based indexing, higher numbers appear on top
   - **Default Order**: Paint layer starts at order 0, new images get max order + 1
   - **Reordering Logic**: When moving a layer, all affected layers shift to maintain sequential ordering
   - **Database Fields**: `paintLayerOrder` and `paintLayerVisible` in paintingSessions table

5. **Tools Available**
   - **Brush (B)**: Drawing tool for creating strokes
   - **Eraser (E)**: Eraser tool that works on all layer types
   - **Pan/Hand (H)**: Move individual image/AI layers by dragging
   - **Upload (U)**: Upload images to the canvas
   - **AI Generation (G)**: Generate AI images based on canvas content
   - **Inpaint (I)**: Inpainting tool (planned)

6. **Important Implementation Details**
   - **Guest User Support**: The `usePaintingSession` hook allows guest users (without authentication) to paint by accepting `undefined` userId
   - **Stroke Detection**: The painting layer shows as "Painting (empty)" when no strokes exist, "Painting" when strokes are present
   - **Data Source**: Both `PaintingView` and `Canvas` components must use strokes from the same source (`usePaintingSession` hook) to ensure consistency
   - **Layer Ordering**: Higher order numbers appear on top (painted last)
   - **Pan Tool Limitations**: The stroke/painting layer cannot be moved as it would require updating all stroke positions in the database
   - **Active Layer System**: Clicking on a layer in the layers panel makes it active (highlighted in blue). The eraser tool works on the active layer
   - **Cursor Indicators**: Brush and eraser tools show a semi-transparent circle indicating the tool size. Eraser shows in red

### Eraser Tool Implementation

1. **Database Schema**
   - Strokes table includes `isEraser: boolean` field to distinguish eraser strokes from paint strokes
   - Eraser strokes on the paint layer are stored in the database like regular strokes

2. **Rendering Strategy**
   - **Paint Layer**: Eraser strokes use `globalCompositeOperation: 'destination-out'` to remove pixels
   - **Image/AI Layers**: Uses local mask system - eraser strokes are stored in `imageMasks` state
   - Live preview works by rendering the current stroke directly on the target layer

3. **Stroke Management**
   - Fixed issue where old strokes would disappear/reappear by:
     - Using stroke IDs for tracking instead of coordinate matching
     - Storing pending stroke IDs in a ref map
     - Reducing aggressive cleanup from 5 seconds to 30 seconds
     - Only cleaning up when more than 20 pending strokes exist

4. **UI Features**
   - Cursor shows semi-transparent circle indicating eraser size
   - Red color scheme for eraser (cursor and stroke preview)
   - Active layer system determines which layer gets erased
   - Eraser masks are cleaned up when layers are deleted

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

### Polar Sandbox Configuration

For testing payments without real money:

1. **Create Sandbox Account**: Go to https://sandbox.polar.sh/start (separate from production)
2. **Set Environment Variables** in Convex for development:
   - `POLAR_API_KEY`: Your sandbox API key
   - `POLAR_WEBHOOK_SECRET`: Your sandbox webhook secret  
   - `POLAR_API_BASE_URL`: `https://sandbox-api.polar.sh`
3. **Test Card**: Use `4242 4242 4242 4242` with any future date and CVC
4. **Product ID**: Create the same product in sandbox and update `VITE_POLAR_PRODUCT_ID` in `.env.local`

### Debugging Tips
- For noisy Convex logs, use the `[AI-GEN]` prefix to filter AI generation logs
- Check both development and production deployments - they use different URLs
- Production logs: https://dashboard.convex.dev/t/travis-irby/wepaintai-core/graceful-blackbird-369/logs
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