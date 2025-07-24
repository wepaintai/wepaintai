# Paint Layer Canvas Capture Implementation Plan

## Overview
Implement canvas rendering support for paint layers in the combine two layers feature, enabling users to combine stroke-based paint layers with other layer types using Luma Photon AI.

## Current Status
- ✅ Combine Two Layers feature implemented for image + AI-generated layers
- ❌ Paint layers cannot be used (backend returns `null` for paint layer extraction)
- ❌ Users can select paint layers in UI but generation fails silently

## Problem Statement
The current `extractLayerImage` function in `convex/aiGeneration.ts` cannot process paint layers because they consist of stroke data rather than rasterized images. Paint layers need to be rendered to canvas and captured as images before being sent to the Luma Photon API.

## Analysis of Current AI Generation Approach

The main AI generation modal successfully captures canvas content using:
1. **Frontend captures canvas** as base64 PNG using `canvasRef.current.getImageData()`
2. **Sends base64 data** to backend action
3. **Backend converts** base64 to blob and stores in Convex storage
4. **Uses storage URL** for Replicate API calls

## Implementation Plan

### Phase 1: Frontend Canvas Capture Integration

#### 1.1 Update CombineTwoLayersModal Component
**File**: `src/components/CombineTwoLayersModal.tsx`

**New Props Required**:
```typescript
interface CombineTwoLayersModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
  layers: Layer[]
  onGenerationComplete: (imageUrl: string) => void
  // NEW PROPS:
  canvasRef?: React.RefObject<CanvasRef>  // Canvas reference for paint layer capture
  canvasWidth?: number                    // Canvas dimensions for proper scaling
  canvasHeight?: number
}
```

**New State Variables**:
```typescript
const [layer1ImageData, setLayer1ImageData] = useState<string>('')
const [layer2ImageData, setLayer2ImageData] = useState<string>('')
const [isCapturingCanvas, setIsCapturingCanvas] = useState(false)
const [captureError, setCaptureError] = useState<string | null>(null)
```

**Canvas Capture Logic**:
```typescript
const captureLayerImage = async (layerId: string, layerType: string): Promise<string | null> => {
  if (layerType === 'paint' || layerType === 'stroke') {
    if (!canvasRef?.current) {
      setCaptureError('Canvas not available for paint layer capture')
      return null
    }
    
    setIsCapturingCanvas(true)
    try {
      // Force canvas redraw to ensure all strokes are rendered
      canvasRef.current.forceRedraw()
      
      // Wait for rendering to complete
      await new Promise(resolve => setTimeout(resolve, 200))
      
      // Capture canvas as base64
      const imageData = canvasRef.current.getImageData()
      if (!imageData) {
        throw new Error('Failed to capture canvas data')
      }
      
      return imageData
    } catch (error) {
      console.error('Canvas capture failed:', error)
      setCaptureError('Failed to capture paint layer')
      return null
    } finally {
      setIsCapturingCanvas(false)
    }
  }
  
  // For image/AI layers, return null (will use existing URL extraction)
  return null
}
```

**Updated Generate Handler**:
```typescript
const handleGenerate = async () => {
  // ... existing validation
  
  // Capture canvas data for paint layers
  let layer1Data: string | undefined
  let layer2Data: string | undefined
  
  if (selectedLayer1?.type === 'paint' || selectedLayer1?.type === 'stroke') {
    layer1Data = await captureLayerImage(layer1Id, selectedLayer1.type)
    if (!layer1Data) return // Error already set
  }
  
  if (selectedLayer2?.type === 'paint' || selectedLayer2?.type === 'stroke') {
    layer2Data = await captureLayerImage(layer2Id, selectedLayer2.type)
    if (!layer2Data) return // Error already set
  }
  
  // Call backend with canvas data
  const result = await combineTwoLayers({
    sessionId,
    prompt: finalPrompt,
    layer1Id,
    layer2Id,
    layer1Type: selectedLayer1.type === 'stroke' ? 'paint' : selectedLayer1.type,
    layer2Type: selectedLayer2.type === 'stroke' ? 'paint' : selectedLayer2.type,
    layer1ImageData: layer1Data,
    layer2ImageData: layer2Data,
    canvasWidth,
    canvasHeight,
  })
  
  // ... rest of handler
}
```

#### 1.2 Enhanced UI States
**Loading States**:
```typescript
// Show capturing state in UI
{isCapturingCanvas && (
  <div className="mb-3 p-2 bg-blue-500/20 border border-blue-500/40 rounded-md">
    <p className="text-sm text-blue-400">
      📸 Capturing canvas layers...
    </p>
  </div>
)}

// Show capture errors
{captureError && (
  <div className="mb-3 p-2 bg-red-500/20 border border-red-500/40 rounded-md">
    <p className="text-sm text-red-400">{captureError}</p>
  </div>
)}
```

**Layer Preview Enhancement**:
```typescript
// Show layer type indicators
<div className="text-center">
  {selectedLayer1 && (
    <>
      <div className="w-full h-16 bg-white/10 rounded border border-white/20 overflow-hidden mb-1">
        {selectedLayer1.type === 'paint' || selectedLayer1.type === 'stroke' ? (
          <div className="w-full h-full flex items-center justify-center text-white/60">
            <span className="text-xs">🎨 Paint Layer</span>
          </div>
        ) : selectedLayer1.thumbnailUrl ? (
          <img 
            src={selectedLayer1.thumbnailUrl} 
            alt={selectedLayer1.name}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/40">
            <span className="text-xs">{selectedLayer1.name}</span>
          </div>
        )}
      </div>
      <p className="text-xs text-white/60">{selectedLayer1.name}</p>
    </>
  )}
</div>
```

#### 1.3 Update PaintingView Integration
**File**: `src/components/PaintingView.tsx`

**Modal Rendering Update**:
```typescript
{showCombineTwoLayers && sessionId && (
  <CombineTwoLayersModal
    isOpen={true}
    onClose={() => {
      setShowCombineTwoLayers(false)
      setSelectedTool('brush')
    }}
    sessionId={sessionId}
    layers={layers}
    canvasRef={canvasRef}  // NEW: Pass canvas reference
    canvasWidth={800}      // NEW: Pass canvas dimensions
    canvasHeight={600}     // NEW: Or get from session/canvas
    onGenerationComplete={handleCombineTwoLayersComplete}
  />
)}
```

### Phase 2: Backend Canvas Processing

#### 2.1 Update combineTwoLayers Action
**File**: `convex/aiGeneration.ts`

**Enhanced Action Arguments**:
```typescript
export const combineTwoLayers = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    layer1Id: v.string(),
    layer2Id: v.string(),
    layer1Type: v.union(v.literal("paint"), v.literal("image"), v.literal("ai-image")),
    layer2Type: v.union(v.literal("paint"), v.literal("image"), v.literal("ai-image")),
    // NEW ARGUMENTS:
    layer1ImageData: v.optional(v.string()), // Base64 data for paint layers
    layer2ImageData: v.optional(v.string()), // Base64 data for paint layers
    canvasWidth: v.optional(v.number()),     // Canvas dimensions
    canvasHeight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // ... existing authentication and token validation
    
    // Extract images from the two layers with canvas data support
    const layer1ImageUrl = await extractLayerImage(
      ctx, 
      args.sessionId, 
      args.layer1Id, 
      args.layer1Type,
      args.layer1ImageData  // Pass canvas data
    );
    
    const layer2ImageUrl = await extractLayerImage(
      ctx, 
      args.sessionId, 
      args.layer2Id, 
      args.layer2Type,
      args.layer2ImageData  // Pass canvas data
    );
    
    // ... rest of existing logic
  }
});
```

#### 2.2 Enhanced Layer Image Extraction
**Updated Function**:
```typescript
async function extractLayerImage(
  ctx: any,
  sessionId: string,
  layerId: string,
  layerType: "paint" | "image" | "ai-image",
  imageData?: string  // Optional base64 data for paint layers
): Promise<string | null> {
  console.log('[COMBINE-LAYERS] Extracting image for layer:', { 
    layerId, 
    layerType, 
    hasImageData: !!imageData 
  });
  
  if (layerType === "paint") {
    if (imageData) {
      try {
        // Store base64 canvas data in Convex storage
        const imageUrl = await storeBase64Image(ctx, imageData);
        console.log('[COMBINE-LAYERS] Paint layer canvas stored:', imageUrl.substring(0, 100) + '...');
        return imageUrl;
      } catch (error) {
        console.error('[COMBINE-LAYERS] Failed to store paint layer canvas:', error);
        return null;
      }
    } else {
      console.error('[COMBINE-LAYERS] Paint layer selected but no canvas data provided');
      return null;
    }
  } else if (layerType === "image") {
    // ... existing uploaded image logic
  } else if (layerType === "ai-image") {
    // ... existing AI image logic
  }
  
  console.log('[COMBINE-LAYERS] Could not extract image for layer:', layerId);
  return null;
}
```

#### 2.3 Base64 Storage Helper Function
**New Helper Function**:
```typescript
async function storeBase64Image(ctx: any, base64Data: string): Promise<string> {
  console.log('[COMBINE-LAYERS] Storing base64 image, length:', base64Data.length);
  
  // Extract base64 data (remove data:image/png;base64, prefix if present)
  const base64Part = base64Data.startsWith('data:') 
    ? base64Data.split(',')[1] 
    : base64Data;
  
  // Convert base64 to binary
  const binaryString = atob(base64Part);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // Create blob from bytes
  const blob = new Blob([bytes], { type: 'image/png' });
  
  // Store in Convex storage
  const storageId = await ctx.storage.store(blob);
  const url = await ctx.storage.getUrl(storageId);
  
  if (!url) {
    throw new Error('Failed to get storage URL for canvas image');
  }
  
  console.log('[COMBINE-LAYERS] Canvas image stored successfully');
  return url;
}
```

### Phase 3: Advanced Layer Isolation (Future Enhancement)

#### 3.1 Individual Paint Layer Rendering
**Concept**: Render only specific paint layer strokes during capture

**Implementation Strategy**:
```typescript
const captureSpecificPaintLayer = async (paintLayerId: string): Promise<string | null> => {
  if (!canvasRef?.current) return null;
  
  // Get all layers and their visibility states
  const originalVisibility = layers.map(layer => ({
    id: layer.id,
    visible: layer.visible
  }));
  
  try {
    // Hide all layers except the target paint layer
    for (const layer of layers) {
      if (layer.id !== paintLayerId) {
        // Temporarily hide this layer
        await hideLayer(layer.id);
      }
    }
    
    // Force redraw with only target layer visible
    canvasRef.current.forceRedraw();
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Capture canvas
    const imageData = canvasRef.current.getImageData();
    
    return imageData;
  } finally {
    // Restore original layer visibility
    for (const { id, visible } of originalVisibility) {
      await setLayerVisibility(id, visible);
    }
    
    // Final redraw to restore original state
    canvasRef.current.forceRedraw();
  }
};
```

#### 3.2 Layer Visibility Management
**Helper Functions**:
```typescript
const hideLayer = async (layerId: string) => {
  // Implementation depends on layer management system
  // May need to call mutations or update local state
};

const setLayerVisibility = async (layerId: string, visible: boolean) => {
  // Restore layer visibility
};
```

### Phase 4: Performance Optimizations

#### 4.1 Canvas Capture Optimization
**Strategies**:
- **Debouncing**: Prevent multiple simultaneous captures
- **Caching**: Cache layer images to avoid re-capture
- **Size optimization**: Capture at optimal resolution for AI processing
- **Memory management**: Clean up base64 data after processing

**Implementation**:
```typescript
// Debounced capture to prevent multiple simultaneous operations
const debouncedCapture = useMemo(
  () => debounce(captureLayerImage, 500),
  [canvasRef]
);

// Cache captured images to avoid re-capture
const layerImageCache = useRef<Map<string, string>>(new Map());

const getCachedOrCaptureLayer = async (layerId: string, layerType: string) => {
  const cacheKey = `${layerId}-${layerType}`;
  
  if (layerImageCache.current.has(cacheKey)) {
    return layerImageCache.current.get(cacheKey)!;
  }
  
  const imageData = await captureLayerImage(layerId, layerType);
  if (imageData) {
    layerImageCache.current.set(cacheKey, imageData);
  }
  
  return imageData;
};
```

#### 4.2 Memory Management
**Cleanup Strategy**:
```typescript
// Clear cache when modal closes
useEffect(() => {
  if (!isOpen) {
    layerImageCache.current.clear();
    setLayer1ImageData('');
    setLayer2ImageData('');
  }
}, [isOpen]);

// Cleanup on unmount
useEffect(() => {
  return () => {
    layerImageCache.current.clear();
  };
}, []);
```

### Phase 5: Error Handling and Validation

#### 5.1 Enhanced Validation
**Pre-generation Checks**:
```typescript
const validateLayerSelection = () => {
  // Check if canvas is available for paint layers
  const needsCanvas = [selectedLayer1, selectedLayer2].some(
    layer => layer?.type === 'paint' || layer?.type === 'stroke'
  );
  
  if (needsCanvas && !canvasRef?.current) {
    setError('Canvas not available for paint layer processing');
    return false;
  }
  
  // Check for empty paint layers
  if (selectedLayer1?.name.includes('(empty)') || selectedLayer2?.name.includes('(empty)')) {
    setError('Cannot combine empty paint layers');
    return false;
  }
  
  return true;
};
```

#### 5.2 Error Recovery
**Fallback Strategies**:
```typescript
const handleCaptureFailure = (layerId: string, error: Error) => {
  console.error(`Canvas capture failed for layer ${layerId}:`, error);
  
  // Try alternative capture method
  setTimeout(async () => {
    try {
      const retryData = await captureLayerImage(layerId, 'paint');
      if (retryData) {
        // Update state with retry data
      }
    } catch (retryError) {
      setError('Failed to capture paint layer after retry. Please try again.');
    }
  }, 1000);
};
```

### Phase 6: Testing Strategy

#### 6.1 Test Scenarios
**Layer Combination Matrix**:
- ✅ Paint layer + Paint layer
- ✅ Paint layer + Uploaded image
- ✅ Paint layer + AI-generated image
- ✅ Uploaded image + AI-generated image (existing)

**Edge Cases**:
- Empty paint layers
- Very large canvases (>4K resolution)
- Paint layers with thousands of strokes
- Canvas capture timeouts
- Network failures during storage upload
- Concurrent capture attempts

#### 6.2 Performance Benchmarks
**Metrics to Monitor**:
- Canvas capture time (target: <500ms)
- Base64 conversion time (target: <200ms)
- Storage upload time (target: <1s)
- Total generation time (target: <30s)
- Memory usage during capture (target: <100MB)

#### 6.3 Test Implementation
**Unit Tests**:
```typescript
describe('Paint Layer Canvas Capture', () => {
  test('should capture paint layer as base64', async () => {
    // Mock canvas ref with getImageData
    // Test capture function
    // Verify base64 output
  });
  
  test('should handle capture failures gracefully', async () => {
    // Mock canvas ref that throws error
    // Test error handling
    // Verify error state
  });
  
  test('should validate layer combinations', () => {
    // Test various layer type combinations
    // Verify validation logic
  });
});
```

**Integration Tests**:
```typescript
describe('Combine Two Layers with Paint Layers', () => {
  test('should combine paint layer with image layer', async () => {
    // Set up test session with paint and image layers
    // Trigger combine operation
    // Verify result
  });
  
  test('should handle backend storage correctly', async () => {
    // Test base64 to storage conversion
    // Verify Luma Photon API call
    // Check result storage
  });
});
```

## Implementation Timeline

### Phase 1: Core Functionality (Week 1)
- [ ] Update CombineTwoLayersModal with canvas capture
- [ ] Update backend to handle base64 image data
- [ ] Basic paint layer + image layer combinations
- [ ] Error handling for capture failures

### Phase 2: UI Polish (Week 2)
- [ ] Enhanced loading states and progress indicators
- [ ] Better layer preview with type indicators
- [ ] Improved error messages and recovery
- [ ] Performance optimizations

### Phase 3: Advanced Features (Week 3)
- [ ] Layer isolation for individual paint layer capture
- [ ] Caching and memory management
- [ ] Comprehensive testing suite
- [ ] Documentation and examples

## Technical Considerations

### Canvas Rendering Challenges
1. **Timing Issues**: Canvas might not be fully rendered when capture occurs
2. **Layer Visibility**: Need to manage layer visibility during capture
3. **Memory Usage**: Large canvases create large base64 strings
4. **Performance**: Canvas operations can be slow for complex scenes

### API Integration
1. **Luma Photon Compatibility**: Ensure captured images work well with the model
2. **Image Quality**: Balance file size vs quality for AI processing
3. **Aspect Ratios**: Handle different canvas aspect ratios appropriately
4. **Rate Limiting**: Manage API calls and storage operations

### Backward Compatibility
1. **Existing Functionality**: Don't break image + AI layer combinations
2. **Error Handling**: Graceful fallback when canvas capture fails
3. **Performance**: Don't slow down non-paint layer combinations
4. **UI Consistency**: Maintain existing modal patterns and behaviors

## Success Criteria

### Functional Requirements
- [ ] Users can select paint layers in combine two tool
- [ ] Paint layer content is properly captured and rendered
- [ ] All layer type combinations work correctly
- [ ] Generated results match user expectations

### Performance Requirements
- [ ] Canvas capture completes within 500ms
- [ ] Total generation time remains under 30 seconds
- [ ] Memory usage stays within reasonable limits
- [ ] UI remains responsive during capture

### Quality Requirements
- [ ] Captured paint layers maintain visual fidelity
- [ ] Error handling provides clear user feedback
- [ ] Feature works consistently across different browsers
- [ ] No regression in existing functionality

This implementation will make the combine two layers feature fully functional with all layer types while maintaining the existing UI patterns and performance characteristics.