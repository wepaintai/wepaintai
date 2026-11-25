import { Id } from '../../convex/_generated/dataModel'
import { getErrorMessage } from './errorMessage'

export const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
export const MAX_IMAGE_DIMENSION = 4096 // Longest edge; larger images are downscaled client-side
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']

export interface ImageUploadOptions {
  sessionId: Id<"paintingSessions">
  guestKey?: string
  canvasWidth?: number
  canvasHeight?: number
  onImageUploaded?: (imageId: Id<"uploadedImages">) => void
}

export interface ImageUploadResult {
  success: boolean
  error?: string
  imageId?: Id<"uploadedImages">
}

export interface UploadIntent {
  intentId: Id<"imageUploadIntents">
  uploadToken: string
}

interface CommitImageUploadArgs {
  sessionId: Id<"paintingSessions">
  intentId: Id<"imageUploadIntents">
  uploadToken: string
  filename: string
  x: number
  y: number
  canvasWidth?: number
  canvasHeight?: number
  guestKey?: string
}

/**
 * URL of the Convex HTTP action that receives image bytes. Uses the Convex
 * site origin (VITE_CONVEX_SITE_URL), falling back to the Convex Cloud
 * convention of `<name>.convex.cloud` -> `<name>.convex.site`.
 */
export function getImageUploadEndpoint(
  env: { VITE_CONVEX_SITE_URL?: string; VITE_CONVEX_URL?: string } = import.meta.env
): string | null {
  let site = env.VITE_CONVEX_SITE_URL
  if (!site && env.VITE_CONVEX_URL && /\.convex\.cloud\/?$/.test(env.VITE_CONVEX_URL)) {
    site = env.VITE_CONVEX_URL.replace(/\.convex\.cloud\/?$/, '.convex.site')
  }
  return site ? `${site.replace(/\/+$/, '')}/uploads/image` : null
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

export function downscaleImage(
  file: File,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<{ blob: Blob; width: number; height: number; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      const scale = maxDimension / Math.max(img.width, img.height)
      const newWidth = Math.floor(img.width * scale)
      const newHeight = Math.floor(img.height * scale)

      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }

      ctx.drawImage(img, 0, 0, newWidth, newHeight)

      // Canvas can't re-encode GIFs; fall back to PNG for anything it can't produce
      const outputType = file.type === 'image/gif' ? 'image/png' : file.type
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve({ blob, width: newWidth, height: newHeight, mimeType: blob.type || outputType })
          } else {
            reject(new Error('Failed to create blob'))
          }
        },
        outputType,
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

const UPLOAD_FAILED_MESSAGE = 'Failed to upload image. Please try again.'

async function readUploadError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // Non-JSON error body
  }
  return response.status === 413 ? 'File size must be less than 5MB' : UPLOAD_FAILED_MESSAGE
}

export async function uploadImageFile(
  file: File,
  options: ImageUploadOptions,
  createUploadIntent: (args: {
    sessionId: Id<"paintingSessions">
    guestKey?: string
  }) => Promise<UploadIntent>,
  commitImageUpload: (args: CommitImageUploadArgs) => Promise<Id<"uploadedImages">>,
  uploadEndpoint: string | null = getImageUploadEndpoint()
): Promise<ImageUploadResult> {
  const { sessionId, guestKey, canvasWidth = 800, canvasHeight = 600, onImageUploaded } = options

  try {
    // Validate file
    const validation = validateImageFile(file)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }
    if (!uploadEndpoint) {
      throw new Error('Image uploads are not configured')
    }

    // Get image dimensions
    const originalDimensions = await getImageDimensions(file)

    // Preserve original resolution up to MAX_IMAGE_DIMENSION; downscale anything larger
    // so huge images don't flood the canvas/AI pipeline at full resolution
    let fileToUpload: File | Blob = file
    let mimeType = file.type
    if (Math.max(originalDimensions.width, originalDimensions.height) > MAX_IMAGE_DIMENSION) {
      const resized = await downscaleImage(file)
      fileToUpload = resized.blob
      mimeType = resized.mimeType
    }
    if (fileToUpload.size > MAX_FILE_SIZE) {
      return { success: false, error: 'File size must be less than 5MB' }
    }

    // 1. Single-use, session-bound intent with a secret upload token
    const { intentId, uploadToken } = await createUploadIntent({ sessionId, guestKey })

    // 2. Upload the bytes; the server validates them and binds the stored
    //    blob to this intent (the client never sees or supplies a storageId)
    const response = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        'X-Upload-Intent': intentId,
        'X-Upload-Token': uploadToken,
      },
      body: fileToUpload,
    })
    if (!response.ok) {
      throw new Error(await readUploadError(response))
    }

    // 3. Create the image layer, centered on the canvas. Type and
    //    dimensions come from the server-side decode recorded on the intent.
    const imageId = await commitImageUpload({
      sessionId,
      intentId,
      uploadToken,
      filename: file.name,
      x: canvasWidth / 2,
      y: canvasHeight / 2,
      canvasWidth,
      canvasHeight,
      guestKey,
    })

    onImageUploaded?.(imageId)

    return { success: true, imageId }
  } catch (err) {
    console.error('Upload error:', err)
    return { success: false, error: getErrorMessage(err, UPLOAD_FAILED_MESSAGE) }
  }
}
