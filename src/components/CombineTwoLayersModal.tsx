import React, { useState } from 'react'
import { X, Sparkles, Loader2, Palette, Camera, Smile, Grid3X3, Coins, History, Flame, Layers } from 'lucide-react'
import { useAction, useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { Layer } from './ToolPanel'

interface CombineTwoLayersModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
  layers: Layer[]
  onGenerationComplete: (imageUrl: string) => void
}

export function CombineTwoLayersModal({
  isOpen,
  onClose,
  sessionId,
  layers,
  onGenerationComplete
}: CombineTwoLayersModalProps) {
  const [prompt, setPrompt] = useState('')
  const [layer1Id, setLayer1Id] = useState('')
  const [layer2Id, setLayer2Id] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withFlames, setWithFlames] = useState(false)
  
  const combineTwoLayers = useAction(api.aiGeneration.combineTwoLayers)
  const tokenBalance = useQuery(api.tokens.getTokenBalance)
  const previousPrompts = useQuery(api.paintingSessions.getAIPrompts, { sessionId })
  const userPrompts = useQuery(api.userPrompts.getUserPrompts, { limit: 20 })
  const addAIPrompt = useMutation(api.paintingSessions.addAIPrompt)
  const addUserPrompt = useMutation(api.userPrompts.addUserPrompt)

  // Filter available layers (exclude empty paint layers)
  const availableLayers = layers.filter(layer => {
    if (layer.type === 'stroke' || layer.type === 'paint') {
      return !layer.name.includes('(empty)')
    }
    return true
  })

  const selectedLayer1 = availableLayers.find(l => l.id === layer1Id)
  const selectedLayer2 = availableLayers.find(l => l.id === layer2Id)

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a prompt')
      return
    }

    if (!layer1Id || !layer2Id) {
      setError('Please select two layers to combine')
      return
    }

    if (layer1Id === layer2Id) {
      setError('Please select two different layers')
      return
    }

    setIsGenerating(true)
    setError(null)

    try {
      const finalPrompt = withFlames ? `${prompt.trim()} with flames` : prompt.trim()
      
      const layer1 = availableLayers.find(l => l.id === layer1Id)
      const layer2 = availableLayers.find(l => l.id === layer2Id)
      
      if (!layer1 || !layer2) {
        throw new Error('Selected layers not found')
      }
      
      console.log('Calling combineTwoLayers with:', {
        sessionId,
        prompt: finalPrompt,
        layer1Id,
        layer2Id,
        layer1Type: layer1.type,
        layer2Type: layer2.type
      })
      
      const result = await combineTwoLayers({
        sessionId,
        prompt: finalPrompt,
        layer1Id,
        layer2Id,
        layer1Type: layer1.type === 'stroke' ? 'paint' : layer1.type,
        layer2Type: layer2.type === 'stroke' ? 'paint' : layer2.type,
      })

      console.log('Combine two layers result:', result)
      
      if (result.success && 'imageUrl' in result) {
        console.log('Generated combined image URL:', result.imageUrl)
        // Save the prompt to both session and user history
        await addAIPrompt({ sessionId, prompt: prompt.trim() })
        await addUserPrompt({ prompt: prompt.trim() })
        onGenerationComplete(result.imageUrl)
        onClose()
      } else if ('error' in result) {
        setError(result.error || 'Generation failed')
      } else {
        setError('Generation failed')
      }
    } catch (err) {
      setError('Failed to combine layers. Please try again.')
      console.error('Combine layers error:', err)
    } finally {
      setIsGenerating(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl max-w-md w-full mx-auto my-auto max-h-[90vh] flex flex-col">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors z-10 bg-black/50 rounded-full p-1"
          disabled={isGenerating}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 p-6 pb-0">
          <Layers className="w-5 h-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Combine Two Layers</h2>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {/* Layer Selection */}
          <div className="mb-3 mt-3">
            <label className="block text-sm font-medium text-white mb-2">
              Select layers to combine:
            </label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="block text-xs text-white/70 mb-1">First Layer:</label>
                <select
                  value={layer1Id}
                  onChange={(e) => setLayer1Id(e.target.value)}
                  disabled={isGenerating}
                  className="w-full px-2 py-1.5 text-sm bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400 text-white [&>option]:bg-gray-900"
                >
                  <option value="">Select layer...</option>
                  {availableLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-white/70 mb-1">Second Layer:</label>
                <select
                  value={layer2Id}
                  onChange={(e) => setLayer2Id(e.target.value)}
                  disabled={isGenerating}
                  className="w-full px-2 py-1.5 text-sm bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400 text-white [&>option]:bg-gray-900"
                >
                  <option value="">Select layer...</option>
                  {availableLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            
            {/* Layer previews */}
            {(selectedLayer1 || selectedLayer2) && (
              <div className="grid grid-cols-2 gap-2">
                <div className="text-center">
                  {selectedLayer1 && (
                    <>
                      <div className="w-full h-16 bg-white/10 rounded border border-white/20 overflow-hidden mb-1">
                        {selectedLayer1.thumbnailUrl ? (
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
                <div className="text-center">
                  {selectedLayer2 && (
                    <>
                      <div className="w-full h-16 bg-white/10 rounded border border-white/20 overflow-hidden mb-1">
                        {selectedLayer2.thumbnailUrl ? (
                          <img 
                            src={selectedLayer2.thumbnailUrl} 
                            alt={selectedLayer2.name}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-white/40">
                            <span className="text-xs">{selectedLayer2.name}</span>
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-white/60">{selectedLayer2.name}</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Style presets */}
          <div className="mb-3">
            <label className="block text-sm font-medium text-white mb-1">
              Quick styles:
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                onClick={() => setPrompt('transform this into a watercolor painting with soft blended colors and fluid brushstrokes')}
                className="flex flex-col items-center gap-1 p-2 sm:p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
                disabled={isGenerating}
              >
                <Palette className="w-5 h-5 sm:w-6 sm:h-6" />
                <span className="text-xs">Watercolor</span>
              </button>
              <button
                onClick={() => setPrompt('transform this into a photorealistic image with natural lighting and detailed textures')}
                className="flex flex-col items-center gap-1 p-2 sm:p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
                disabled={isGenerating}
              >
                <Camera className="w-5 h-5 sm:w-6 sm:h-6" />
                <span className="text-xs">Photo Real</span>
              </button>
              <button
                onClick={() => setPrompt('transform this into a cartoon style illustration with bold colors and clean lines')}
                className="flex flex-col items-center gap-1 p-2 sm:p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
                disabled={isGenerating}
              >
                <Smile className="w-5 h-5 sm:w-6 sm:h-6" />
                <span className="text-xs">Cartoon</span>
              </button>
              <button
                onClick={() => setPrompt('transform this into pixel art with a retro 8-bit video game aesthetic')}
                className="flex flex-col items-center gap-1 p-2 sm:p-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md transition-colors text-white"
                disabled={isGenerating}
              >
                <Grid3X3 className="w-5 h-5 sm:w-6 sm:h-6" />
                <span className="text-xs">Pixel Art</span>
              </button>
            </div>
          </div>

          {/* Previous prompts dropdown */}
          {(userPrompts && userPrompts.length > 0) || (previousPrompts && previousPrompts.length > 0) ? (
            <div className="mb-3">
              <label className="block text-sm font-medium text-white mb-2">
                <History className="w-4 h-4 inline mr-1" />
                Previous prompts:
              </label>
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    setPrompt(e.target.value)
                  }
                }}
                disabled={isGenerating}
                className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400 text-white [&>option]:bg-gray-900"
              >
                <option value="">Select a previous prompt...</option>
                {userPrompts && userPrompts.length > 0 && (
                  <optgroup label="Your prompts (all sessions)">
                    {userPrompts.map((item, index) => (
                      <option key={`user-${index}`} value={item.prompt}>
                        {item.prompt.length > 60 ? item.prompt.substring(0, 60) + '...' : item.prompt}
                        {item.usageCount > 1 && ` (${item.usageCount}x)`}
                      </option>
                    ))}
                  </optgroup>
                )}
                {previousPrompts && previousPrompts.length > 0 && (
                  <optgroup label="This session only">
                    {previousPrompts.map((prevPrompt, index) => (
                      <option key={`session-${index}`} value={prevPrompt}>
                        {prevPrompt.length > 60 ? prevPrompt.substring(0, 60) + '...' : prevPrompt}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          ) : null}

          {/* Prompt input */}
          <div className="mb-3">
            <label htmlFor="prompt" className="block text-sm font-medium text-white mb-1">
              Or describe how to combine the layers:
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., 'blend these layers together as a watercolor painting' or 'combine into a single photorealistic scene'"
              className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400 resize-none text-white placeholder-white/50"
              rows={2}
              disabled={isGenerating}
            />
          </div>

          {/* With flames toggle */}
          <div className="mb-3">
            <button
              onClick={() => setWithFlames(!withFlames)}
              disabled={isGenerating}
              className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-all ${
                withFlames 
                  ? 'bg-orange-500/20 border-orange-500/40 text-orange-400 hover:bg-orange-500/30' 
                  : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
              }`}
            >
              <Flame className={`w-4 h-4 ${withFlames ? 'animate-pulse' : ''}`} />
              <span className="text-sm font-medium">
                {withFlames ? '🔥 ✅' : 'Add 🔥'}
              </span>
            </button>
          </div>

          {/* Token balance */}
          <div className="mb-3 p-2 sm:p-3 bg-white/10 rounded-md border border-white/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 text-yellow-400" />
                <span className="text-sm font-medium text-white">AI Generation Tokens</span>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold text-white">
                  {tokenBalance?.tokens ?? 0}
                </p>
                <p className="text-xs text-white/60">1 token per generation</p>
              </div>
            </div>
            <button
              onClick={() => {
                onClose()
                const buyMoreBtn = document.querySelector('[data-token-buy-more]') as HTMLButtonElement
                if (buyMoreBtn) buyMoreBtn.click()
              }}
              className="mt-2 w-full px-3 py-1.5 text-xs font-medium text-black bg-yellow-400 hover:bg-yellow-500 rounded transition-colors"
            >
              Buy more tokens
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-3 p-2 bg-red-500/20 border border-red-500/40 rounded-md">
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
                {error.includes('Please sign in') && (
                  <span>
                    {' '}
                    <a
                      href="/login"
                      className="underline hover:text-red-300"
                    >
                      Sign in
                    </a>
                  </span>
                )}
              </p>
            </div>
          )}
        </div>

        {/* Fixed action buttons footer */}
        <div className="border-t border-white/20 p-6 bg-black/50 backdrop-blur-sm">
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
              disabled={isGenerating || !prompt.trim() || !layer1Id || !layer2Id || layer1Id === layer2Id}
              className="px-4 py-2 text-sm font-medium text-white bg-purple-500 hover:bg-purple-600 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Combining...
                </>
              ) : (
                <>
                  <Layers className="w-4 h-4" />
                  Combine Layers
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}