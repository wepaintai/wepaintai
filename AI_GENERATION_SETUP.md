# AI Generation Setup with Replicate

This guide explains how to set up and use the AI image generation feature with Replicate's Flux Kontext Pro model.

## Prerequisites

1. A Replicate account: Sign up at [replicate.com](https://replicate.com)
2. A Replicate API token: Get it from [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens)

## Setup Instructions

### 1. Configure Convex Environment Variables

Add your Replicate API token to Convex:

1. Go to your Convex dashboard
2. Navigate to Settings > Environment Variables
3. Add a new environment variable:
   - Name: `REPLICATE_API_TOKEN`
   - Value: Your Replicate API token

### 2. Deploy the Backend Changes

```bash
npx convex deploy
```

This will deploy the new AI generation functions and schema updates.

## Using AI Generation

1. **Start drawing** on the canvas to create your base image
2. **Click the AI button** (sparkles icon) in the tool panel or press `G`
3. **Enter a prompt** describing how you want to transform your drawing
4. **Click Generate** to create an AI-enhanced version
5. The generated image will be added as a new layer on your canvas

## How It Works

1. **Canvas Capture**: When you trigger AI generation, the current canvas is converted to a PNG image
2. **Replicate API**: The image and your prompt are sent to Flux Kontext Pro via Replicate
3. **Image Processing**: The AI model transforms your drawing based on the prompt
4. **Result Display**: The generated image is uploaded to Convex storage and displayed on the canvas

## Example Prompts

- "make it look like a watercolor painting"
- "add a sunset background with vibrant colors"
- "transform into a realistic oil painting"
- "make it look like a comic book illustration"
- "add magical glowing effects"

## Technical Details

### Frontend Components
- `AIGenerationModal.tsx`: UI for entering prompts and triggering generation
- `ToolPanel.tsx`: Updated with AI generation button
- `PaintingView.tsx`: Handles the AI generation workflow

### Backend Functions
- `convex/aiGeneration.ts`: Manages Replicate API calls and generation tracking
- `convex/images.ts`: Extended to handle AI-generated image uploads
- `convex/schema.ts`: Added `aiGenerations` table for tracking requests

### Model Information
- Model: [black-forest-labs/flux-kontext-pro](https://replicate.com/black-forest-labs/flux-kontext-pro)
- Version: `15589a1a9e6b240d246752fc688267b847db4858910cc390794703384b6a5443`
- Safety tolerance: Limited to 2 when using input images

## Troubleshooting

### "AI generation not configured" error
- Ensure `REPLICATE_API_TOKEN` is set in Convex environment variables
- Redeploy Convex functions after adding the token

### Generated images not appearing
- Check browser console for errors
- Ensure your Replicate account has available credits
- Generated images are now automatically stored in Convex storage to avoid CORS issues

### Generation taking too long
- The model typically takes 10-30 seconds
- Check Replicate dashboard for prediction status
- Timeout is set to 60 seconds

## Cost Considerations

- Each generation uses Replicate credits
- Check pricing at [replicate.com/pricing](https://replicate.com/pricing)
- Monitor usage in your Replicate dashboard