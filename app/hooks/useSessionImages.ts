import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback } from "react";

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
  rotation: number;
  opacity: number;
  layerOrder: number;
  url?: string;
}

export function useSessionImages(sessionId: Id<"paintingSessions"> | null) {
  // Query images for the session
  const images = useQuery(
    api.images.getSessionImages,
    sessionId ? { sessionId } : "skip"
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
    await updateTransform({ imageId, x, y });
  }, [updateTransform]);

  // Update image scale
  const scaleImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    scale: number
  ) => {
    await updateTransform({ imageId, scale });
  }, [updateTransform]);

  // Update image rotation
  const rotateImage = useCallback(async (
    imageId: Id<"uploadedImages">,
    rotation: number
  ) => {
    await updateTransform({ imageId, rotation });
  }, [updateTransform]);

  // Update image opacity
  const setImageOpacity = useCallback(async (
    imageId: Id<"uploadedImages">,
    opacity: number
  ) => {
    await updateTransform({ imageId, opacity });
  }, [updateTransform]);

  // Update full transform
  const updateImageTransform = useCallback(async (
    imageId: Id<"uploadedImages">,
    transform: {
      x?: number;
      y?: number;
      scale?: number;
      rotation?: number;
      opacity?: number;
    }
  ) => {
    await updateTransform({ imageId, ...transform });
  }, [updateTransform]);

  // Change layer order
  const changeLayerOrder = useCallback(async (
    imageId: Id<"uploadedImages">,
    newLayerOrder: number
  ) => {
    await updateLayerOrder({ imageId, newLayerOrder });
  }, [updateLayerOrder]);

  // Delete image
  const deleteImage = useCallback(async (imageId: Id<"uploadedImages">) => {
    await deleteImageMutation({ imageId });
  }, [deleteImageMutation]);

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