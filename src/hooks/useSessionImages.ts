import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback } from "react";
import { getGuestKey } from "../utils/guestKey";

export interface SessionImage {
  _id: Id<"uploadedImages">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  userId?: Id<"users">;
  storageId: Id<"_storage">;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  scaleX?: number;
  scaleY?: number;
  rotation: number;
  opacity: number;
  layerOrder: number;
  url?: string;
}

export function useSessionImages(sessionId: Id<"paintingSessions"> | null) {
  const guestKey = getGuestKey(sessionId) || undefined;

  // Query images for the session
  const images = useQuery(
    api.images.getSessionImages,
    sessionId ? { sessionId, guestKey } : "skip"
  );

  // Mutations
  const updateTransform = useMutation(api.images.updateImageTransform);
  const updateLayerOrder = useMutation(api.images.updateImageLayerOrder);
  const deleteImageMutation = useMutation(api.images.deleteImage);

  // Update image position
  const moveImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    x: number,
    y: number
  ) => {
    await updateTransform({ imageId, x, y, guestKey });
  }, [updateTransform, guestKey]);

  // Update image scale
  const scaleImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    scale: number
  ) => {
    await updateTransform({ imageId, scale, guestKey });
  }, [updateTransform, guestKey]);

  // Update image rotation
  const rotateImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    rotation: number
  ) => {
    await updateTransform({ imageId, rotation, guestKey });
  }, [updateTransform, guestKey]);

  // Update image opacity
  const setImageOpacity = useCallback(async (
    imageId: Id<"uploadedImages">,
    opacity: number
  ) => {
    await updateTransform({ imageId, opacity, guestKey });
  }, [updateTransform, guestKey]);

  // Update full transform
  const updateImageTransform = useCallback(async (
    imageId: Id<"uploadedImages">,
    transform: {
      x?: number;
      y?: number;
      scale?: number;
      scaleX?: number;
      scaleY?: number;
      rotation?: number;
      opacity?: number;
    }
  ) => {
    try {
      console.log('[useSessionImages] updateImageTransform called', { imageId, transform })
    } catch {}
    await updateTransform({ imageId, ...transform, guestKey });
    try {
      console.log('[useSessionImages] updateImageTransform completed', { imageId, transform })
    } catch {}
  }, [updateTransform, guestKey]);

  // Change layer order
  const changeLayerOrder = useCallback(async (
    imageId: Id<"uploadedImages">,
    newLayerOrder: number
  ) => {
    await updateLayerOrder({ imageId, newLayerOrder, guestKey });
  }, [updateLayerOrder, guestKey]);

  // Delete image
  const deleteImage = useCallback(async (imageId: Id<"uploadedImages">) => {
    await deleteImageMutation({ imageId, guestKey });
  }, [deleteImageMutation, guestKey]);

  return {
    images: images || [],
    isLoading: images === undefined,
    moveImage,
    scaleImage,
    rotateImage,
    setImageOpacity,
    updateImageTransform,
    changeLayerOrder,
    deleteImage,
  };
}
