import React, { useState } from 'react'
import { X, Loader2, Coins, Merge } from 'lucide-react'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { Layer } from './ToolPanel'

interface MergeTwoModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
  layers: Layer[]
  onMergeComplete: (imageUrl: string) => void
}

type MergeMode = 'full' | 'left_right' | 'top_bottom'

export function MergeTwoModal({
  isOpen,
  onClose,
  sessionId,
  layers,
  onMergeComplete
}: MergeTwoModalProps) {
  const [firstLayerId, setFirstLayerId] = useState('')
  const [secondLayerId, setSecondLayerId] = useState('')
  const [mergeMode, setMergeMode] = useState<MergeMode>('full')
  const [isMerging, setIsMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const mergeImages = useAction(api.imageMerger.mergeImages)
  const tokenBalance = useQuery(api.tokens.getTokenBalance)

  // Filter layers to only show image and ai-image layers (not stroke layers)
  const availableLayers = layers.filter(layer => 
    layer.type === 'image' || layer.type === 'ai-image'
  )

  const handleMerge = async () => {
    if (!firstLayerId || !secondLayerId) {
      setError('Please select two layers to merge')
      return
    }

    if (firstLayerId === secondLayerId) {
      setError('Please select two different layers')
      return
    }

    setIsMerging(true)
    setError(null)

    try {
      const result = await mergeImages({
        sessionId,
        firstLayerId,
        secondLayerId,
        mergeMode,
      })

      if (result.success && result.imageUrl) {
        onMergeComplete(result.imageUrl)
        onClose()
      } else {
        setError(result.error || 'Merge failed')
      }
    } catch (err) {
      setError('Failed to merge images. Please try again.')
      console.error('Image merge error:', err)
    } finally {
      setIsMerging(false)
    }
  }

  const getLayerName = (layerId: string) => {
    const layer = layers.find(l => l.id === layerId)
    return layer?.name || 'Unknown Layer'
  }

  const getLayerThumbnail = (layerId: string) => {
    const layer = layers.find(l => l.id === layerId)
    return layer?.thumbnailUrl
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
          disabled={isMerging}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 p-6 pb-0">
          <Merge className="w-5 h-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Merge Two Layers</h2>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {availableLayers.length < 2 ? (
            <div className="text-center py-8">
              <p className="text-sm text-white/60 mb-2">
                You need at least 2 image layers to merge
              </p>
              <p className="text-xs text-white/40">
                Upload images or generate AI images first
              </p>
            </div>
          ) : (
            <>
              {/* First Layer Selection */}
              <div className="mb-4 mt-4">
                <label className="block text-sm font-medium text-white mb-2">
                  First Layer:
                </label>
                <select
                  value={firstLayerId}
                  onChange={(e) => setFirstLayerId(e.target.value)}
                  disabled={isMerging}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400 text-white [&>option]:bg-gray-900"
                >
                  <option value="">Select first layer...</option>
                  {availableLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
                {firstLayerId && getLayerThumbnail(firstLayerId) && (
                  <div className="mt-2">
                    <img 
                      src={getLayerThumbnail(firstLayerId)} 
                      alt="First layer preview" 
                      className="w-full h-20 object-contain bg-white/10 rounded border border-white/20"
                    />
                  </div>
                )}
              </div>

              {/* Second Layer Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-white mb-2">
                  Second Layer:
                </label>
                <select
                  value={secondLayerId}
                  onChange={(e) => setSecondLayerId(e.target.value)}
                  disabled={isMerging}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-400 text-white [&>option]:bg-gray-900"
                >
                  <option value="">Select second layer...</option>
                  {availableLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
                {secondLayerId && getLayerThumbnail(secondLayerId) && (
                  <div className="mt-2">
                    <img 
                      src={getLayerThumbnail(secondLayerId)} 
                      alt="Second layer preview" 
                      className="w-full h-20 object-contain bg-white/10 rounded border border-white/20"
                    />
                  </div>
                )}
              </div>

              {/* Merge Mode Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-white mb-2">
                  Merge Mode:
                </label>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    onClick={() => setMergeMode('full')}
                    disabled={isMerging}
                    className={`p-3 rounded-md border transition-colors text-left ${
                      mergeMode === 'full'
                        ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                        : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
                    }`}
                  >
                    <div className="font-medium">Full Merge</div>
                    <div className="text-xs opacity-70">Both images apply to the whole result</div>
                  </button>
                  <button
                    onClick={() => setMergeMode('left_right')}
                    disabled={isMerging}
                    className={`p-3 rounded-md border transition-colors text-left ${
                      mergeMode === 'left_right'
                        ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                        : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
                    }`}
                  >
                    <div className="font-medium">Left/Right Split</div>
                    <div className="text-xs opacity-70">First on left, second on right</div>
                  </button>
                  <button
                    onClick={() => setMergeMode('top_bottom')}
                    disabled={isMerging}
                    className={`p-3 rounded-md border transition-colors text-left ${
                      mergeMode === 'top_bottom'
                        ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                        : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
                    }`}
                  >
                    <div className="font-medium">Top/Bottom Split</div>
                    <div className="text-xs opacity-70">First on top, second on bottom</div>
                  </button>
                </div>
              </div>

              {/* Token balance */}
              <div className="mb-4 p-3 bg-white/10 rounded-md border border-white/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Coins className="w-4 h-4 text-yellow-400" />
                    <span className="text-sm font-medium text-white">AI Generation Tokens</span>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold text-white">
                      {tokenBalance?.tokens ?? 0}
                    </p>
                    <p className="text-xs text-white/60">1 token per merge</p>
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
                <div className="mb-4 p-2 bg-red-500/20 border border-red-500/40 rounded-md">
                  <p className="text-sm text-red-400">
                    {error}
                    {error.includes('Insufficient tokens') && (
                      <span>
                        {' '}
                        <button
                          onClick={() => {
                            onClose()
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
            </>
          )}
        </div>

        {/* Fixed action buttons footer */}
        <div className="border-t border-white/20 p-6 bg-black/50 backdrop-blur-sm">
          <div className="flex gap-3 justify-end">
            <button
              onClick={onClose}
              disabled={isMerging}
              className="px-4 py-2 text-sm font-medium text-white bg-white/10 hover:bg-white/20 rounded-md transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleMerge}
              disabled={isMerging || !firstLayerId || !secondLayerId || availableLayers.length < 2}
              className="px-4 py-2 text-sm font-medium text-white bg-purple-500 hover:bg-purple-600 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isMerging ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Merging...
                </>
              ) : (
                <>
                  <Merge className="w-4 h-4" />
                  Merge Layers
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}