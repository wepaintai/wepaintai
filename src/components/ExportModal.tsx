import React, { useState, useEffect, useRef } from 'react'
import { X, Download, Image as ImageIcon } from 'lucide-react'
import { isIOS } from '../utils/device'

interface ExportModalProps {
  isOpen: boolean
  onClose: () => void
  canvasDataUrl: string
  defaultFilename?: string
}

export function ExportModal({ 
  isOpen, 
  onClose, 
  canvasDataUrl,
  defaultFilename = `wepaintai-${Date.now()}`
}: ExportModalProps) {
  const [filename, setFilename] = useState(defaultFilename)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [quality, setQuality] = useState(0.9)
  const [processedImageUrl, setProcessedImageUrl] = useState<string>('')
  const [isProcessing, setIsProcessing] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const isIOSDevice = isIOS()

  useEffect(() => {
    if (!isOpen) return

    const processImage = async () => {
      setIsProcessing(true)
      
      if (format === 'png' || quality === 1) {
        // For PNG or max quality JPEG, use the original data URL
        setProcessedImageUrl(canvasDataUrl)
      } else {
        // For JPEG with custom quality, we need to re-encode
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = img.width
          canvas.height = img.height
          const ctx = canvas.getContext('2d')
          
          if (ctx) {
            // Fill with white background for JPEG (no transparency)
            ctx.fillStyle = 'white'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0)
            
            const jpegUrl = canvas.toDataURL('image/jpeg', quality)
            setProcessedImageUrl(jpegUrl)
          }
        }
        img.src = canvasDataUrl
      }
      
      setIsProcessing(false)
    }

    processImage()
  }, [isOpen, canvasDataUrl, format, quality])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleDownload = () => {
    const link = document.createElement('a')
    link.download = `${filename}.${format}`
    link.href = processedImageUrl
    link.click()
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/10">
          <h3 className="text-lg font-semibold text-white">Export Canvas</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded-sm transition-colors text-white/70 hover:text-white"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isProcessing ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* iOS-specific instructions */}
              {isIOSDevice && (
                <div className="bg-blue-500/20 border border-blue-500/50 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <ImageIcon className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-white/90">
                      <p className="font-medium mb-1">Save to Photos on iOS:</p>
                      <ol className="list-decimal list-inside space-y-1 text-white/70">
                        <li>Long press the image below</li>
                        <li>Select "Save Image" from the menu</li>
                        <li>The image will be saved to your Photos app</li>
                      </ol>
                    </div>
                  </div>
                </div>
              )}

              {/* Image preview */}
              <div className="space-y-2">
                <p className="text-sm text-white/70">Preview:</p>
                <div className="bg-white/5 rounded-lg p-4 border border-white/10">
                  <img
                    ref={imageRef}
                    src={processedImageUrl}
                    alt="Canvas export preview"
                    className="w-full h-auto max-h-[400px] object-contain rounded"
                    style={{ imageRendering: 'crisp-edges' }}
                  />
                </div>
              </div>

              {/* Export options */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white/90 mb-2">
                    Filename
                  </label>
                  <input
                    type="text"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-transparent"
                    placeholder="Enter filename"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/90 mb-2">
                    Format
                  </label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        value="png"
                        checked={format === 'png'}
                        onChange={(e) => setFormat(e.target.value as 'png')}
                        className="w-4 h-4 text-blue-500 bg-white/10 border-white/20 focus:ring-blue-500"
                      />
                      <span className="text-sm text-white/80">PNG (Lossless)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        value="jpeg"
                        checked={format === 'jpeg'}
                        onChange={(e) => setFormat(e.target.value as 'jpeg')}
                        className="w-4 h-4 text-blue-500 bg-white/10 border-white/20 focus:ring-blue-500"
                      />
                      <span className="text-sm text-white/80">JPEG (Compressed)</span>
                    </label>
                  </div>
                </div>

                {format === 'jpeg' && (
                  <div>
                    <label className="block text-sm font-medium text-white/90 mb-2">
                      Quality: {Math.round(quality * 100)}%
                    </label>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.1"
                      value={quality}
                      onChange={(e) => setQuality(parseFloat(e.target.value))}
                      className="w-full h-2 bg-white/20 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>
                )}
              </div>

              {/* Download button - shown for all devices as a fallback */}
              <button
                onClick={handleDownload}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors font-medium"
              >
                <Download className="w-4 h-4" />
                {isIOSDevice ? 'Download to Files' : 'Download Image'}
              </button>

              {isIOSDevice && (
                <p className="text-xs text-white/50 text-center">
                  Tip: For best results on iOS, use the long-press method to save directly to Photos
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}