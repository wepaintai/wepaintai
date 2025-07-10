import React, { useState } from 'react'
import { X, Sparkles, Loader2, Palette, Camera, Smile, Grid3X3 } from 'lucide-react'
import { useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

interface AIGenerationModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
  canvasDataUrl: string
  canvasWidth?: number
  canvasHeight?: number
  onGenerationComplete: (imageUrl: string) => void
}

export function AIGenerationModal({
  isOpen,
  onClose,
  sessionId,
  canvasDataUrl,
  canvasWidth,
  canvasHeight,
  onGenerationComplete
}: AIGenerationModalProps) {
  const [prompt, setPrompt] = useState('')
  const [weight, setWeight] = useState(0.85)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const generateImage = useAction(api.aiGeneration.generateImage)

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a prompt')
      return
    }

    setIsGenerating(true)
    setError(null)

    try {
      console.log('Calling generateImage with:', {
        sessionId,
        prompt: prompt.trim(),
        imageDataLength: canvasDataUrl.length
      })
      
      const result = await generateImage({
        sessionId,
        prompt: prompt.trim(),
        imageData: canvasDataUrl,
        weight: weight,
        canvasWidth: canvasWidth,
        canvasHeight: canvasHeight,
      })

      console.log('AI Generation result:', result)
      console.log('Result type:', typeof result)
      console.log('Result keys:', result ? Object.keys(result) : 'null')
      
      if (result.success && result.imageUrl) {
        console.log('Generated image URL:', result.imageUrl)
        onGenerationComplete(result.imageUrl)
        onClose()
      } else {
        setError(result.error || 'Generation failed')
      }
    } catch (err) {
      setError('Failed to generate image. Please try again.')
      console.error('AI generation error:', err)
    } finally {
      setIsGenerating(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors"
          disabled={isGenerating}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">AI Generation</h2>
        </div>

        {/* Preview */}
        <div className="mb-4">
          <p className="text-sm text-white/70 mb-2">Current canvas:</p>
          <div className="relative w-full h-32 bg-white/10 rounded border border-white/20 overflow-hidden">
            <img 
              src={canvasDataUrl} 
              alt="Canvas preview" 
              className="w-full h-full object-contain"
            />
          </div>
        </div>

        {/* Style presets */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-white mb-2">
            Quick styles:
          </label>
          <div className="grid grid-cols-4 gap-2 mb-3">
            <button
              onClick={() => setPrompt('transform this into a watercolor painting with soft blended colors and fluid brushstrokes')}
              className="flex flex-col items-center gap-1 p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
              disabled={isGenerating}
            >
              <Palette className="w-6 h-6" />
              <span className="text-xs">Watercolor</span>
            </button>
            <button
              onClick={() => setPrompt('transform this into a photorealistic image with natural lighting and detailed textures')}
              className="flex flex-col items-center gap-1 p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
              disabled={isGenerating}
            >
              <Camera className="w-6 h-6" />
              <span className="text-xs">Photo Real</span>
            </button>
            <button
              onClick={() => setPrompt('transform this into a cartoon style illustration with bold colors and clean lines')}
              className="flex flex-col items-center gap-1 p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
              disabled={isGenerating}
            >
              <Smile className="w-6 h-6" />
              <span className="text-xs">Cartoon</span>
            </button>
            <button
              onClick={() => setPrompt('transform this into pixel art with a retro 8-bit video game aesthetic')}
              className="flex flex-col items-center gap-1 p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
              disabled={isGenerating}
            >
              <Grid3X3 className="w-6 h-6" />
              <span className="text-xs">Pixel Art</span>
            </button>
          </div>
        </div>

        {/* Prompt input */}
        <div className="mb-4">
          <label htmlFor="prompt" className="block text-sm font-medium text-white mb-2">
            Or describe your own transformation:
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g., 'make it look like a watercolor painting' or 'add a sunset background'"
            className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none text-white placeholder-white/50"
            rows={3}
            disabled={isGenerating}
          />
        </div>

        {/* Weight slider */}
        <div className="mb-4">
          <label htmlFor="weight" className="block text-sm font-medium text-white mb-2">
            Canvas influence: {weight.toFixed(2)}
          </label>
          <input
            id="weight"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={weight}
            onChange={(e) => setWeight(parseFloat(e.target.value))}
            disabled={isGenerating}
            className="ai-modal-slider"
          />
          <div className="flex justify-between text-xs text-white/60 mt-1">
            <span>0 (ignore canvas)</span>
            <span>1 (preserve canvas)</span>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/40 rounded-md">
            <p className="text-sm text-red-400">
              {error}
              {error.includes('Insufficient tokens') && (
                <span>
                  {' '}
                  <button
                    onClick={() => {
                      onClose()
                      // Trigger token purchase modal by clicking the buy more link
                      const buyMoreBtn = document.querySelector('[data-token-buy-more]') as HTMLButtonElement
                      if (buyMoreBtn) buyMoreBtn.click()
                    }}
                    className="underline hover:text-red-300"
                  >
                    Buy more tokens
                  </button>
                </span>
              )}
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={isGenerating}
            className="px-4 py-2 text-sm font-medium text-white bg-white/10 hover:bg-white/20 rounded-md transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generate
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}