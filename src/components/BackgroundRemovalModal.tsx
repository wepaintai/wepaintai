import React, { useState } from 'react'
import { X, Scissors, Loader2, Coins, Layers as LayersIcon } from 'lucide-react'
import { useAction, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import type { Layer } from './ToolPanel'

interface BackgroundRemovalModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
  canvasDataUrl: string
  layers: Layer[]
  activeLayerId?: string
  onRemovalComplete: (imageUrl: string) => void
}

export function BackgroundRemovalModal({
  isOpen,
  onClose,
  sessionId,
  canvasDataUrl,
  layers,
  activeLayerId,
  onRemovalComplete
}: BackgroundRemovalModalProps) {
  const [isRemoving, setIsRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedLayerId, setSelectedLayerId] = useState<string | undefined>(undefined)
  
  const removeBackground = useAction(api.backgroundRemoval.removeBackground)
  const tokenBalance = useQuery(api.tokens.getTokenBalance)

  // Filter layers to only show image and AI image layers
  const selectableLayers = layers.filter(layer => layer.type === 'image' || layer.type === 'ai-image')
  
  // Debug: Log available layers
  console.log('BackgroundRemovalModal - All layers:', layers)
  console.log('BackgroundRemovalModal - Selectable layers:', selectableLayers)

  const handleRemoveBackground = async () => {
    setIsRemoving(true)
    setError(null)

    try {
      let imageData: string
      
      if (selectedLayerId && selectedLayerId !== 'canvas') {
        // Get the specific layer's image data
        const selectedLayer = layers.find(l => l.id === selectedLayerId)
        if (!selectedLayer) {
          throw new Error('Selected layer not found')
        }
        
        // Check if layer has an image URL
        if (!selectedLayer.thumbnailUrl) {
          console.error('Selected layer has no thumbnailUrl:', selectedLayer)
          throw new Error('Selected layer has no image URL')
        }
        
        try {
          // Fetch the layer's image and convert to base64
          const response = await fetch(selectedLayer.thumbnailUrl)
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`)
          }
          
          const blob = await response.blob()
          const reader = new FileReader()
          imageData = await new Promise<string>((resolve, reject) => {
            reader.onloadend = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(blob)
          })
        } catch (fetchError) {
          console.error('Error fetching layer image:', fetchError)
          throw new Error('Failed to load layer image')
        }
      } else {
        // Use the full canvas
        imageData = canvasDataUrl
      }
      
      const result = await removeBackground({
        sessionId,
        imageData,
        targetLayerId: selectedLayerId
      })
      
      if (result.success && result.imageUrl) {
        onRemovalComplete(result.imageUrl)
        onClose()
      } else {
        setError(result.error || 'Background removal failed')
      }
    } catch (err) {
      setError('Failed to remove background. Please try again.')
      console.error('Background removal error:', err)
    } finally {
      setIsRemoving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl max-w-md w-full">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors z-10 bg-black/50 rounded-full p-1"
        >
          <X className="w-5 h-5" />
        </button>
        
        {/* Header */}
        <div className="p-6 pb-4 border-b border-white/10">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Scissors className="w-5 h-5 text-purple-400" />
            Remove Background
          </h2>
          <p className="text-sm text-white/60 mt-1">Remove background from canvas or selected layer</p>
        </div>
        
        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Layer selection */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-2">
              Select source
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 cursor-pointer transition-colors">
                <input
                  type="radio"
                  name="layer"
                  value="canvas"
                  checked={!selectedLayerId || selectedLayerId === 'canvas'}
                  onChange={() => setSelectedLayerId(undefined)}
                  className="w-4 h-4 text-purple-500 focus:ring-purple-500"
                />
                <span className="text-white/90 flex-1">Entire Canvas</span>
              </label>
              
              {selectableLayers.map(layer => (
                <label key={layer.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 cursor-pointer transition-colors">
                  <input
                    type="radio"
                    name="layer"
                    value={layer.id}
                    checked={selectedLayerId === layer.id}
                    onChange={() => setSelectedLayerId(layer.id)}
                    className="w-4 h-4 text-purple-500 focus:ring-purple-500"
                  />
                  <span className="text-white/90 flex-1">{layer.name}</span>
                  <LayersIcon className="w-4 h-4 text-white/40" />
                </label>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="border border-white/20 rounded-lg overflow-hidden bg-checkered">
            <img 
              src={canvasDataUrl} 
              alt="Canvas preview" 
              className="w-full h-48 object-contain"
            />
          </div>
          
          {/* Token info */}
          <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
            <span className="text-sm text-white/70">Cost:</span>
            <span className="text-sm font-medium text-white flex items-center gap-1">
              <Coins className="w-4 h-4 text-yellow-500" />
              1 token
            </span>
          </div>
          
          {tokenBalance !== undefined && tokenBalance < 1 && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-sm text-red-400">Insufficient tokens. You need at least 1 token.</p>
            </div>
          )}
          
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="p-6 pt-4 border-t border-white/10 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 text-white/70 hover:text-white border border-white/20 hover:border-white/30 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleRemoveBackground}
            disabled={isRemoving || (tokenBalance !== undefined && tokenBalance < 1)}
            className="flex-1 px-4 py-2 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 text-white rounded-lg transition-colors flex items-center justify-center gap-2 disabled:cursor-not-allowed"
          >
            {isRemoving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Removing...
              </>
            ) : (
              <>
                <Scissors className="w-4 h-4" />
                Remove Background
              </>
            )}
          </button>
        </div>
      </div>
      
      {/* Add checkered background pattern styles */}
      <style jsx>{`
        .bg-checkered {
          background-image: 
            linear-gradient(45deg, #333 25%, transparent 25%),
            linear-gradient(-45deg, #333 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #333 75%),
            linear-gradient(-45deg, transparent 75%, #333 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
      `}</style>
    </div>
  )
}