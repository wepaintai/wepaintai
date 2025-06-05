# Testing P2P Isolation from Convex

## Test 1: Network Tab Verification

1. Open Chrome DevTools → Network tab
2. Filter by WebSocket connections
3. Start painting and observe:
   - **P2P Messages**: Should see WebRTC data channel activity (not visible in Network tab)
   - **Convex Messages**: Should NOT see any Convex WebSocket messages for live strokes
   - **Only on stroke completion**: Should see Convex `addStroke` mutation

## Test 2: Convex Dashboard Monitoring

1. Open Convex Dashboard (https://dashboard.convex.dev)
2. Go to Functions → Live view
3. Start painting continuously:
   - Should NOT see `updateLiveStroke` mutations firing
   - Should NOT see frequent database writes
   - Should ONLY see `addStroke` when you lift the pen

## Test 3: Artificial Convex Delay Test

Add this temporary code to test isolation:

```typescript
// In convex/liveStrokes.ts, add artificial delay:
export const updateLiveStroke = mutation({
  handler: async (ctx, args) => {
    // Add 5-second delay to prove P2P doesn't use this
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Rest of the function...
  }
});
```

With this delay:
- P2P strokes should still appear instantly (<40ms)
- If strokes are delayed, P2P is not working

## Test 4: Disable Convex Connection

1. In browser console, break the Convex connection:
```javascript
// Find and close Convex WebSocket
Array.from(window.performance.getEntriesByType('resource'))
  .filter(r => r.name.includes('convex.cloud'))
  .forEach(r => console.log('Convex connection:', r.name));

// Or use Network tab to block convex.cloud domain
```

2. With Convex blocked:
   - Live painting should still work via P2P
   - Completed strokes won't save (expected)
   - Other users still see your live strokes

## Test 5: P2P Metrics Verification

Look at the P2P status indicator (bottom-left):
- **Packets Sent**: Should increment rapidly while painting
- **Packets Received**: Should increment when others paint
- **Latency**: Should show <40ms
- If these don't change, P2P isn't working

## Test 6: Console Logging

Add temporary logging to verify data flow:

```typescript
// In app/hooks/useP2PPainting.ts
const sendStrokePoint = useCallback((strokeId, x, y, pressure) => {
  console.log('P2P: Sending stroke point', { strokeId, x, y });
  // ... rest of function
});

// In app/hooks/usePaintingSession.ts
const updateLiveStrokeForUser = useCallback((points, brushColor, brushSize, opacity) => {
  console.log('CONVEX: Would update live stroke - SHOULD NOT SEE THIS');
  // ... rest of function
});
```

## Test 7: Bandwidth Test

1. Open Chrome DevTools → Network tab
2. Look at WebSocket bandwidth for convex.cloud
3. While painting:
   - Bandwidth should be minimal (only cursor updates)
   - Should NOT see bandwidth spikes during painting
   - Only spike when stroke completes

## Test 8: Code Path Verification

The code already implements isolation:

```typescript
// In Canvas.tsx, line ~500:
// Only use Convex if P2P is not connected
if (!isP2PConnected || connectionMode === 'fallback') {
  updateLiveStrokeForUser(newStrokePoints, color, size, opacity)
}
```

This ensures Convex live strokes are ONLY used when P2P fails.

## Expected Results

✅ **P2P Working Correctly:**
- No Convex mutations during painting
- Instant stroke appearance (<40ms)
- P2P metrics incrementing
- Convex only receives completed strokes

❌ **P2P Not Working (Fallback Mode):**
- Frequent Convex mutations
- Higher latency (100ms+)
- P2P status shows "Fallback Mode"
- Original flickering issue returns

## Quick Verification Script

Run in browser console while painting:

```javascript
// Monitor Convex activity
let convexCalls = 0;
const originalFetch = window.fetch;
window.fetch = function(...args) {
  if (args[0]?.includes?.('convex')) {
    convexCalls++;
    console.log(`Convex call #${convexCalls}:`, args[0]);
  }
  return originalFetch.apply(this, args);
};

// Reset counter
setTimeout(() => {
  console.log(`Total Convex calls while painting: ${convexCalls}`);
  console.log('Expected: 0-2 (cursor updates only)');
}, 10000);
```

If you see many Convex calls while actively painting, P2P is not working correctly.