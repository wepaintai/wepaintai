import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback, useSyncExternalStore } from "react";
import { getEditKey, getGuestKey, subscribeEditKeys } from "../utils/guestKey";

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
  const editKey =
    useSyncExternalStore(
      subscribeEditKeys,
      () => getEditKey(sessionId),
      () => null,
    ) || undefined;

  // Query images for the session
  const images = useQuery(
    api.images.getSessionImages,
    sessionId ? { sessionId, guestKey, editKey } : "skip"
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
    await updateTransform({ imageId, x, y, guestKey, editKey });
  }, [updateTransform, guestKey, editKey]);

  // Update image scale
  const scaleImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    scale: number
  ) => {
    await updateTransform({ imageId, scale, guestKey, editKey });
  }, [updateTransform, guestKey, editKey]);

  // Update image rotation
  const rotateImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    rotation: number
  ) => {
    await updateTransform({ imageId, rotation, guestKey, editKey });
  }, [updateTransform, guestKey, editKey]);

  // Update image opacity
  const setImageOpacity = useCallback(async (
    imageId: Id<"uploadedImages">,
    opacity: number
  ) => {
    await updateTransform({ imageId, opacity, guestKey, editKey });
  }, [updateTransform, guestKey, editKey]);

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
    await updateTransform({ imageId, ...transform, guestKey, editKey });
    try {
      console.log('[useSessionImages] updateImageTransform completed', { imageId, transform })
    } catch {}
  }, [updateTransform, guestKey, editKey]);

  // Change layer order
  const changeLayerOrder = useCallback(async (
    imageId: Id<"uploadedImages">,
    newLayerOrder: number
  ) => {
    await updateLayerOrder({ imageId, newLayerOrder, guestKey, editKey });
  }, [updateLayerOrder, guestKey, editKey]);

  // Delete image
  const deleteImage = useCallback(async (imageId: Id<"uploadedImages">) => {
    await deleteImageMutation({ imageId, guestKey, editKey });
  }, [deleteImageMutation, guestKey, editKey]);

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
