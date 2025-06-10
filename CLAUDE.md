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
   - Dual canvas system: main canvas (committed strokes) + drawing canvas (active stroke)
   - Single-flight pattern prevents duplicate stroke submissions
   - Coalesced pointer events for smooth drawing performance

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
- Frontend env vars must be prefixed with `VITE_`

#### Convex Backend Environment Variables
Set these in the Convex dashboard (Settings > Environment Variables):
- `REPLICATE_API_TOKEN`: Your Replicate API token for AI image generation

### Development Notes
- Use `pnpm dev` for local development with free local backend
- The admin panel (bottom-left debug info) is hidden in production
- When modifying Convex schema, the backend will auto-migrate
- Production database access (`pnpm dev:prod-db`) should be used carefully