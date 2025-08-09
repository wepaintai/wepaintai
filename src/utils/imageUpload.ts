import { Id } from '../../convex/_generated/dataModel'

export const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']

export interface ImageUploadOptions {
  sessionId: Id<"paintingSessions">
  userId?: Id<"users"> | null
  canvasWidth?: number
  canvasHeight?: number
  onImageUploaded?: (imageId: Id<"uploadedImages">) => void
}

export interface ImageUploadResult {
  success: boolean
  error?: string
  imageId?: Id<"uploadedImages">
}

export function validateImageFile(file: File): { valid: boolean; error?: string } {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return { valid: false, error: 'Please select a valid image file (PNG, JPG, GIF, WebP)' }
  }

  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'File size must be less than 5MB' }
  }

  return { valid: true }
}

export function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
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

export function resizeImageToFitCanvas(
  file: File, 
  originalWidth: number, 
  originalHeight: number,
  canvasWidth: number,
  canvasHeight: number
): Promise<{ blob: Blob; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    
    img.onload = async () => {
      URL.revokeObjectURL(url)
      
      // Calculate scale to fit within canvas
      const scaleX = canvasWidth / originalWidth
      const scaleY = canvasHeight / originalHeight
      const scale = Math.min(scaleX, scaleY, 1) // Never scale up, only down
      
      const newWidth = Math.floor(originalWidth * scale)
      const newHeight = Math.floor(originalHeight * scale)
      
      // Create temporary canvas for resizing
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight
      
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      
      // Draw resized image
      ctx.drawImage(img, 0, 0, newWidth, newHeight)
      
      // Convert to blob
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve({ blob, width: newWidth, height: newHeight })
          } else {
            reject(new Error('Failed to create blob'))
          }
        },
        file.type,
        0.9 // Quality for JPEG/WebP
      )
    }
    
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image for resizing'))
    }
    
    img.src = url
  })
}

export async function uploadImageFile(
  file: File,
  options: ImageUploadOptions,
  generateUploadUrl: () => Promise<string>,
  uploadImage: (args: any) => Promise<Id<"uploadedImages">>
): Promise<ImageUploadResult> {
  const { sessionId, userId, canvasWidth = 800, canvasHeight = 600, onImageUploaded } = options

  try {
    // Validate file
    const validation = validateImageFile(file)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    // Get image dimensions
    const originalDimensions = await getImageDimensions(file)
    
    // Check if image needs resizing
    let fileToUpload: File | Blob = file
    let finalDimensions = originalDimensions
    
    if (originalDimensions.width > canvasWidth || originalDimensions.height > canvasHeight) {
      const resized = await resizeImageToFitCanvas(
        file, 
        originalDimensions.width, 
        originalDimensions.height,
        canvasWidth,
        canvasHeight
      )
      fileToUpload = resized.blob
      finalDimensions = { width: resized.width, height: resized.height }
    }
    
    // Generate upload URL
    const uploadUrl = await generateUploadUrl()
    
    // Upload to Convex storage
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: fileToUpload,
    })

    if (!response.ok) {
      throw new Error('Failed to upload file')
    }

    const { storageId } = await response.json()

    // Center the image on the canvas
    const x = canvasWidth / 2
    const y = canvasHeight / 2

    // Create image record
    const uploadArgs: any = {
      sessionId,
      storageId,
      filename: file.name,
      mimeType: file.type,
      width: finalDimensions.width,
      height: finalDimensions.height,
      x,
      y,
    }
    
    // Only include userId if it's defined and not null
    if (userId) {
      uploadArgs.userId = userId
    }
    
    const imageId = await uploadImage(uploadArgs)
    
    onImageUploaded?.(imageId)
    
    return { success: true, imageId }
  } catch (err) {
    console.error('Upload error:', err)
    return { success: false, error: 'Failed to upload image. Please try again.' }
  }
}