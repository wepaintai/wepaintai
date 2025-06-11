# AI Image Debugging Analysis

## Problem
AI-generated images are not visible on the canvas.

## Root Cause
The issue is a type mismatch in the image handling system:

1. **Data Structure Mismatch**: 
   - `getSessionImages` returns both uploaded images and AI-generated images
   - AI-generated images have `_id: Id<"aiGeneratedImages">` 
   - Uploaded images have `_id: Id<"uploadedImages">`
   - The `useSessionImages` hook interface expects only `Id<"uploadedImages">`

2. **Canvas Rendering**:
   - The Canvas component logs show it's receiving images
   - The `redrawImageCanvas` function is being called
   - Images are being drawn, but there might be an issue with the image loading or rendering

## Key Findings

### In `convex/images.ts`:
```typescript
// AI images are mapped but keep their original _id type
const aiWithType = aiImages.map(image => ({
  ...image,
  url: image.imageUrl,
  type: "ai-generated" as const,
  // These fields don't match the uploadedImages structure
  storageId: null as any,
  filename: "ai-generated.png",
  mimeType: "image/png",
  userId: undefined,
}));
```

### In `app/hooks/useSessionImages.ts`:
```typescript
export interface SessionImage {
  _id: Id<"uploadedImages">; // This doesn't handle Id<"aiGeneratedImages">
  // ... other fields
}
```

## Debugging Steps

1. Check browser console for:
   - CORS errors when loading AI images
   - Failed image loads
   - Type errors

2. Verify in browser DevTools Network tab:
   - Are AI image URLs being fetched?
   - Are they returning 200 OK?

3. Check Canvas logs:
   - Look for "Redrawing image canvas" logs
   - Look for "Image loaded successfully" or "Failed to load image" logs
   - Check if AI images have proper URLs

## Potential Solutions

1. **Type Union Approach**: Update the SessionImage interface to handle both ID types
2. **Unified ID Approach**: Store AI images in the uploadedImages table with a flag
3. **Separate Rendering**: Handle AI images separately from uploaded images

## Next Steps

1. First, check the browser console and network tab to see if images are loading
2. Add more detailed logging to understand where the process fails
3. Fix the type mismatch issue