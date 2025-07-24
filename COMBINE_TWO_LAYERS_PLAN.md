# Combine Two Layers Feature Implementation Plan

## Overview
Add a "Combine Two" feature to the AI tab that allows users to select two layers and combine them using Luma Photon AI model, with the same UI patterns as the existing AI generation modal.

## Implementation Tasks

### 1. Frontend Components

#### 1.1 CombineTwoLayersModal Component
**File**: `src/components/CombineTwoLayersModal.tsx`

**Features**:
- Modal structure matching `AIGenerationModal.tsx` pattern
- Two layer selection dropdowns with validation
- Preview thumbnails of selected layers
- Style preset buttons (Watercolor, Photo Real, Cartoon, Pixel Art)
- Previous prompts dropdown functionality
- Custom text prompt textarea
- "Add 🔥" flames toggle
- Token balance display and purchase integration
- Loading states and error handling

**Layer Selection**:
- Dropdown 1: "First Layer" - populated with all available layers
- Dropdown 2: "Second Layer" - populated with all available layers
- Validation: Ensure two different layers are selected
- Preview: Show thumbnails of selected layers

**Style Preset Buttons** (exact copy from AIGenerationModal):
```typescript
const stylePresets = [
  {
    icon: Palette,
    label: "Watercolor",
    prompt: "transform this into a watercolor painting with soft blended colors and fluid brushstrokes"
  },
  {
    icon: Camera, 
    label: "Photo Real",
    prompt: "transform this into a photorealistic image with natural lighting and detailed textures"
  },
  {
    icon: Smile,
    label: "Cartoon", 
    prompt: "transform this into a cartoon style illustration with bold colors and clean lines"
  },
  {
    icon: Grid3X3,
    label: "Pixel Art",
    prompt: "transform this into pixel art with a retro 8-bit video game aesthetic"
  }
]
```

#### 1.2 ToolPanel Integration
**File**: `src/components/ToolPanel.tsx`

**Changes**:
- Add "Combine Two" button in AI section under "Remove Background"
- Add state management for `isCombineTwoModalOpen`
- Import and render `CombineTwoLayersModal`

### 2. Backend Implementation

#### 2.1 Convex Backend Function
**File**: `convex/aiGeneration.ts`

**New Action**: `combineTwoLayers`
```typescript
export const combineTwoLayers = action({
  args: {
    sessionId: v.id("paintingSessions"),
    prompt: v.string(),
    layer1Id: v.string(), // Layer identifier
    layer2Id: v.string(), // Layer identifier
    layer1Type: v.union(v.literal("paint"), v.literal("image"), v.literal("ai-image")),
    layer2Type: v.union(v.literal("paint"), v.literal("image"), v.literal("ai-image")),
  },
  handler: async (ctx, args) => {
    // Implementation details below
  }
});
```

**Implementation Steps**:
1. Authentication and token validation (same as existing `generateImage`)
2. Extract images from selected layers:
   - Paint layer: Render canvas content as base64 PNG, store in Convex storage
   - Image/AI layers: Use existing stored image URLs
3. Call Luma Photon API with `reference_images` array
4. Store result as new AI-generated layer
5. Handle token consumption and prompt history

#### 2.2 Luma Photon API Integration
**Model**: `luma/photon`

**API Call Structure**:
```typescript
const requestBody = {
  version: "luma-photon-version-id", // To be determined
  input: {
    prompt: finalPrompt, // with flames if toggled
    reference_images: [layer1ImageUrl, layer2ImageUrl],
    aspect_ratio: "1:1", // or calculated from layer dimensions
    output_format: "png"
  }
};
```

**Key Differences from Flux Kontext Pro**:
- Uses `reference_images` array instead of single `input_image`
- Native multi-image support for combining layers
- Different model version ID

### 3. Layer Management

#### 3.1 Layer Image Extraction
**Paint Layer**:
- Capture canvas content as base64 PNG (same as current AI generation)
- Convert to blob and store in Convex storage
- Return storage URL for API call

**Image/AI Layers**:
- Use existing stored image URLs from Convex storage
- Ensure URLs are accessible to Luma Photon API

#### 3.2 Layer Selection Logic
**Available Layers**:
- Paint layer (if has strokes): "Painting" 
- Image layers: Use original filename or "Image {index}"
- AI-generated layers: "AI Image {index}"

**Validation**:
- Ensure two different layers are selected
- Handle edge cases (empty paint layer, missing images)
- Show appropriate error messages

### 4. UI/UX Features

#### 4.1 Prompt Management (Same as AIGenerationModal)
- Integration with `api.userPrompts.getUserPrompts`
- Integration with `api.paintingSessions.getAIPrompts`
- Save successful prompts to both session and user history
- Previous prompts dropdown with usage counts

#### 4.2 Token System Integration
- Same 1 token cost as regular AI generation
- Token balance display with "Buy more tokens" button
- Token consumption after successful generation using `api.tokens.useTokensForGeneration`
- Error handling for insufficient tokens

#### 4.3 Error Handling
- Layer selection validation errors
- API call failures
- Token insufficient errors
- Network/storage errors
- Same error patterns as existing AI generation

### 5. Technical Specifications

#### 5.1 Component Props Interface
```typescript
interface CombineTwoLayersModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
  layers: Array<{
    id: string
    type: 'paint' | 'image' | 'ai-image'
    name: string
    thumbnailUrl?: string
  }>
  onGenerationComplete: (imageUrl: string) => void
}
```

#### 5.2 Backend Response Format
```typescript
interface CombineTwoLayersResponse {
  success: boolean
  imageUrl?: string
  error?: string
}
```

### 6. Testing Checklist

#### 6.1 UI Testing
- [ ] Modal opens/closes correctly from ToolPanel
- [ ] Layer dropdowns populate with available layers
- [ ] Style preset buttons set correct prompts
- [ ] Previous prompts dropdown works
- [ ] Flames toggle functions
- [ ] Token balance displays correctly
- [ ] Validation prevents same layer selection

#### 6.2 Backend Testing
- [ ] Layer image extraction works for all layer types
- [ ] Luma Photon API integration successful
- [ ] Token consumption works correctly
- [ ] Prompt history saving functions
- [ ] Error handling for various failure scenarios

#### 6.3 Integration Testing
- [ ] Complete workflow: select layers → set prompt → generate → add to canvas
- [ ] Generated image appears as new layer
- [ ] Token balance updates after generation
- [ ] Prompt appears in history dropdowns

### 7. Implementation Order

1. **High Priority**:
   - Create `CombineTwoLayersModal` component structure
   - Add button to `ToolPanel` 
   - Implement layer selection UI
   - Create backend `combineTwoLayers` action

2. **Medium Priority**:
   - Add style preset buttons and prompt management
   - Implement layer image extraction logic
   - Configure Luma Photon API integration
   - Add token system integration

3. **Low Priority**:
   - Add validation and error handling
   - Implement testing and refinements
   - Documentation updates

### 8. Environment Variables

**New Environment Variable Needed**:
- `LUMA_PHOTON_MODEL_VERSION`: Luma Photon model version ID for Replicate API

**Existing Variables Used**:
- `REPLICATE_API_TOKEN`: Same token works for Luma Photon
- All existing Convex and authentication variables

### 9. File Structure

```
src/components/
├── CombineTwoLayersModal.tsx (NEW)
├── ToolPanel.tsx (MODIFIED)
└── ...

convex/
├── aiGeneration.ts (MODIFIED - add combineTwoLayers action)
└── ...
```

This plan ensures complete feature parity with the existing AI generation modal while adding the unique two-layer combination functionality using Luma Photon's multi-image capabilities.