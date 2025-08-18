# Admin Panel Configuration

This document explains how to configure the admin panel visibility for different environments.

## Overview

The admin panel and its toggle button are automatically hidden in production deployments to prevent end users from accessing internal debugging controls. This is controlled through environment variables and build mode detection.

## Environment Variable

### `VITE_INTERNAL_HIDE_ADMIN_PANEL`

- **Type**: String
- **Values**: `"true"` | `"false"` | undefined
- **Default**: Uses production mode detection if not set

When set to `"true"`, the admin panel and toggle button will be completely hidden from the UI.

## Configuration

### Development Environment

In development, admin features are shown by default. No configuration needed.

### Production Environment (Vercel)

1. Go to your Vercel project dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Add a new environment variable:
   - **Name**: `VITE_INTERNAL_HIDE_ADMIN_PANEL`
   - **Value**: `true`
   - **Environment**: Production (and Preview if desired)
4. Redeploy your application

### Other Deployment Platforms

Set the environment variable `VITE_INTERNAL_HIDE_ADMIN_PANEL=true` in your production environment configuration.

## Behavior

### When Admin Features Are Enabled (Development)
- Toggle button is visible in the top-right corner
- Admin panel can be opened/closed via button click
- Keyboard shortcut `Ctrl+Shift+A` works
- Admin panel shows brush settings controls

### When Admin Features Are Hidden (Production)
- Toggle button is completely removed from DOM
- Admin panel component is not rendered
- Keyboard shortcut is disabled
- No admin controls are accessible to end users

## Fallback Logic

The system uses the following priority order:

1. **Environment Variable**: If `VITE_INTERNAL_HIDE_ADMIN_PANEL` is set, use its value
2. **Production Mode**: If in production build (`import.meta.env.PROD`), hide admin features
3. **Default**: Show admin features (development mode)

This ensures admin features are hidden by default in production even if the environment variable is not explicitly set.

## Files Modified

- `app/utils/environment.ts` - Environment detection utilities
- `app/components/PaintingView.tsx` - Conditional rendering logic

## Testing

### Test in Development
Admin features should be visible and functional.

### Test Production Build Locally
```bash
# Build for production
pnpm run build

# Serve production build
pnpm run start
```

Admin features should be hidden in the production build.

### Test with Environment Variable
```bash
# Set environment variable and test
VITE_INTERNAL_HIDE_ADMIN_PANEL=true pnpm run dev
```

Admin features should be hidden even in development mode.
