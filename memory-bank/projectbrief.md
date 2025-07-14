# wepaintAI - Project Brief

## Project Overview
wepaintAI is a web-based painting application that combines freehand drawing with AI-powered inpainting capabilities. The application prioritizes immediate usability - users can start painting without any authentication, with optional sign-up for saving work.

## Core Requirements

### Functional Requirements
1. **Instant Painting Access** - Users can paint immediately upon visiting the site
2. **Drawing Tools** - Brush tool with adjustable size and opacity
3. **Color Selection** - Color picker for brush color
4. **Canvas Actions** - Undo, redo, and clear canvas functionality
5. **Export** - Download painting as image file
6. **AI Inpainting** - Select areas to regenerate using AI
7. **User Accounts** - Optional authentication to save paintings
8. **Auto-save** - Periodic saving for authenticated users

### Non-Functional Requirements
1. **Performance** - Smooth, responsive drawing experience
2. **Mobile Support** - Touch-enabled painting on mobile devices
3. **Browser Compatibility** - Works on modern browsers
4. **Minimal Load Time** - Fast initial page load

## Technology Stack
- **Frontend Framework**: TanStack Start (React-based)
- **Database & Backend**: Convex
- **Styling**: Tailwind CSS + shadcn/ui
- **Authentication**: Convex Auth
- **Drawing Library**: perfect-freehand
- **AI Service**: Replicate API (Ideogram V2 Turbo)

## Success Criteria
1. Users can start painting within 3 seconds of page load
2. Drawing feels natural and responsive
3. AI inpainting produces quality results
4. Authentication flow is seamless and optional
5. Auto-save prevents work loss for logged-in users

## Constraints
- No real-time collaboration features
- Single canvas per session
- Inpainting requires internet connection
- Limited to 2D painting (no layers initially)

## Target Audience
- Casual digital artists
- Users wanting to experiment with AI-assisted art
- People looking for a quick, accessible painting tool