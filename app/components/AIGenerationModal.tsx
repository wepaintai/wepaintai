import React, { useState } from 'react'
import { X, Sparkles, Loader2 } from 'lucide-react'
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
      <div className="relative bg-background border border-border rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
          disabled={isGenerating}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">AI Generation</h2>
        </div>

        {/* Preview */}
        <div className="mb-4">
          <p className="text-sm text-muted-foreground mb-2">Current canvas:</p>
          <div className="relative w-full h-32 bg-secondary rounded border border-border overflow-hidden">
            <img 
              src={canvasDataUrl} 
              alt="Canvas preview" 
              className="w-full h-full object-contain"
            />
          </div>
        </div>

        {/* Prompt input */}
        <div className="mb-4">
          <label htmlFor="prompt" className="block text-sm font-medium mb-2">
            Describe how you want to transform the image:
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g., 'make it look like a watercolor painting' or 'add a sunset background'"
            className="w-full px-3 py-2 bg-secondary border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            rows={3}
            disabled={isGenerating}
          />
        </div>

        {/* Weight slider */}
        <div className="mb-4">
          <label htmlFor="weight" className="block text-sm font-medium mb-2">
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
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>0 (ignore canvas)</span>
            <span>1 (preserve canvas)</span>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={isGenerating}
            className="px-4 py-2 text-sm font-medium text-foreground bg-secondary hover:bg-secondary/80 rounded-md transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
            className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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