import React, { useRef, useState, useCallback } from 'react'
import { Upload, X } from 'lucide-react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'

interface ImageUploadModalProps {
  sessionId: Id<"paintingSessions"> | null
  userId?: Id<"users"> | null
  onImageUploaded?: (imageId: Id<"uploadedImages">) => void
  onClose: () => void
}

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']

export function ImageUploadModal({ sessionId, userId, onImageUploaded, onClose }: ImageUploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  
  const generateUploadUrl = useMutation(api.images.generateUploadUrl)
  const uploadImage = useMutation(api.images.uploadImage)

  const handleFileSelect = useCallback(async (file: File) => {
    console.log('File selected:', file.name, 'Type:', file.type, 'Size:', file.size)
    
    // Validate file
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Please select a valid image file (PNG, JPG, GIF, WebP)')
      return
    }

    if (file.size > MAX_FILE_SIZE) {
      setError('File size must be less than 5MB')
      return
    }

    setError(null)
    setSelectedFile(file)
    
    // Generate preview
    const reader = new FileReader()
    reader.onload = (e) => setPreview(e.target?.result as string)
    reader.readAsDataURL(file)
  }, [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileSelect(file)
    }
  }, [handleFileSelect])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    
    const file = e.dataTransfer.files[0]
    if (file && file.type.startsWith('image/')) {
      handleFileSelect(file)
    }
  }, [handleFileSelect])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const getImageDimensions = (file: File): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve({ width: img.width, height: img.height })
      }
      
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to load image'))
      }
      
      img.src = url
    })
  }

  const handleUpload = async () => {
    if (!selectedFile || !sessionId) return
    
    setIsUploading(true)
    setError(null)

    try {
      // Get image dimensions
      console.log('Getting image dimensions...')
      const dimensions = await getImageDimensions(selectedFile)
      console.log('Image dimensions:', dimensions)
      
      // Generate upload URL
      console.log('Generating upload URL...')
      const uploadUrl = await generateUploadUrl()
      console.log('Upload URL generated')
      
      // Upload to Convex storage
      console.log('Uploading to Convex storage...')
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': selectedFile.type },
        body: selectedFile,
      })

      if (!response.ok) {
        console.error('Upload response not OK:', response.status, response.statusText)
        throw new Error('Failed to upload file')
      }

      const { storageId } = await response.json()
      console.log('File uploaded, storage ID:', storageId)

      // Create image record
      console.log('Creating image record in database...')
      const imageId = await uploadImage({
        sessionId,
        userId,
        storageId,
        filename: selectedFile.name,
        mimeType: selectedFile.type,
        width: dimensions.width,
        height: dimensions.height,
        x: 100, // Default position
        y: 100,
      })
      console.log('Image record created:', imageId)

      onImageUploaded?.(imageId)
      onClose()
    } catch (err) {
      console.error('Upload error:', err)
      setError('Failed to upload image. Please try again.')
    } finally {
      setIsUploading(false)
    }
  }

  // Handle ESC key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isUploading) {
        onClose()
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isUploading])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background p-6 rounded-lg shadow-lg max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Upload Image</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-accent rounded-sm transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          onChange={handleInputChange}
          className="hidden"
        />
        
        {!selectedFile ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`
              w-full p-8 border-2 border-dashed rounded-lg cursor-pointer
              transition-colors duration-200
              ${isDragging 
                ? 'border-primary bg-primary/5' 
                : 'border-border hover:border-primary/50'
              }
            `}
          >
            <Upload className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-center text-muted-foreground">
              Click to select or drag and drop
            </p>
            <p className="text-xs text-center text-muted-foreground mt-2">
              PNG, JPG, GIF, WebP • Max 5MB
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {preview && (
              <div className="relative">
                <img 
                  src={preview} 
                  alt="Preview" 
                  className="w-full h-48 object-contain rounded bg-accent"
                />
              </div>
            )}
            <div className="space-y-1">
              <p className="text-sm font-medium truncate">{selectedFile.name}</p>
              <p className="text-xs text-muted-foreground">
                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
            
            <div className="flex gap-2">
              <button
                onClick={handleUpload}
                disabled={isUploading}
                className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {isUploading ? 'Uploading...' : 'Upload'}
              </button>
              <button
                onClick={() => {
                  setSelectedFile(null)
                  setPreview(null)
                  setError(null)
                }}
                disabled={isUploading}
                className="px-4 py-2 border border-border rounded hover:bg-accent transition-colors"
              >
                Change
              </button>
            </div>
          </div>
        )}
        
        {error && (
          <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}