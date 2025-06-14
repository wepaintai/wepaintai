# Clear Canvas Bug Fix Test Plan

## Issue Description
When using the clear canvas tool, there were bugs where:
1. Previous strokes don't all clear
2. Strokes reappear later after being cleared

## Root Causes Identified
1. Local canvas state not properly reset (pending strokes, current stroke, drawing state)
2. Loaded images cache not cleared, causing images to persist
3. Viewer acknowledgment state not reset when clearing
4. Missing stroke ended ref reset

## Fixes Applied

### 1. Canvas Component (`app/components/Canvas.tsx`)
Updated the `clear` method in the imperative handle to:
- Clear all canvas contexts (main, drawing, image)
- Clear pending strokes map
- Reset current stroke array
- Reset isDrawing state to false
- Reset strokeEndedRef to false
- Clear loaded images cache

### 2. usePaintingSession Hook (`app/hooks/usePaintingSession.ts`)
Updated the `clearSession` function to:
- Clear both completed strokes and live strokes (already working)
- Reset local acknowledgment state reference to 0
- Update viewer state to reflect cleared session

### 3. Viewer Acknowledgments (`convex/viewerAcks.ts`)
Added new mutation `clearSessionViewerStates` to:
- Clear all viewer states for a session when clearing canvas
- Ensure all connected clients reset their acknowledgment state

## Test Steps

### Test 1: Basic Clear
1. Draw several strokes on the canvas
2. Click the Clear Canvas button
3. Verify all strokes disappear immediately
4. Verify the canvas remains empty (strokes don't reappear)

### Test 2: Clear with Multiple Users
1. Open two browser windows with the same session
2. Draw strokes from both windows
3. Clear canvas from one window
4. Verify both windows show empty canvas
5. Draw new strokes and verify they appear correctly

### Test 3: Clear with Pending Strokes
1. Start drawing a stroke but don't release
2. While still drawing, have another user clear the canvas
3. Release the stroke
4. Verify the canvas remains empty

### Test 4: Clear with AI Images
1. Generate an AI image on the canvas
2. Draw some strokes over it
3. Clear the canvas
4. Verify strokes are cleared (images may remain by design)

### Test 5: Clear and Undo
1. Draw several strokes
2. Clear the canvas
3. Try to undo
4. Verify undo doesn't bring back cleared strokes

### Test 6: Rapid Clear
1. Draw strokes rapidly
2. Clear canvas multiple times in quick succession
3. Verify canvas stays clear
4. Draw new strokes to verify canvas still works

## Expected Behavior
- Canvas should clear immediately and completely
- No strokes should reappear after clearing
- All connected users should see the cleared canvas
- Canvas should remain functional for new drawings after clearing