import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { FunctionArgs } from "convex/server";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getEditKey, getGuestKey, subscribeEditKeys } from "../utils/guestKey";

export interface ImageTransformUpdate {
  x?: number;
  y?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  opacity?: number;
}

export interface UploadedSessionImage {
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
  url?: string | null;
  type?: "uploaded";
}

export interface AISessionImage {
  _id: Id<"aiGeneratedImages">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  imageUrl: string;
  url: string;
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
  createdAt: number;
  type: "ai-generated";
}

export type SessionImage = UploadedSessionImage | AISessionImage;

export interface RawSessionImageRecord {
  _id: string;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  userId?: Id<"users">;
  storageId?: Id<"_storage"> | null;
  filename?: string;
  mimeType?: string;
  imageUrl?: string;
  url?: string | null;
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
  createdAt?: number;
  type?: "uploaded" | "ai-generated";
}

export interface PartitionedSessionImages {
  images: SessionImage[];
  uploadedImages: UploadedSessionImage[];
  aiImages: AISessionImage[];
}

export interface UseSessionImagesOptions {
  /** Guest owner key; when the property is present it overrides localStorage. */
  guestKey?: string;
  /** Edit-link key; when the property is present it overrides the edit-key store. */
  editKey?: string;
}

/**
 * Caller-supplied args for `api.images.addAIGeneratedImage`. Derived from the
 * mutation's validator so required fields (e.g. the blob `storageId` the
 * server binds the layer to) can never be silently dropped by this wrapper;
 * the session and access keys are filled in by the hook.
 */
export type AddAIGeneratedImageInput = Omit<
  FunctionArgs<typeof api.images.addAIGeneratedImage>,
  "sessionId" | "guestKey" | "editKey"
>;

const EMPTY_IMAGES: SessionImage[] = [];
const EMPTY_UPLOADED_IMAGES: UploadedSessionImage[] = [];
const EMPTY_AI_IMAGES: AISessionImage[] = [];

/**
 * Partition the combined `api.images.getSessionImages` payload into uploaded
 * and AI-generated images while preserving `layerOrder` ordering and full
 * field parity with `api.images.getAIGeneratedImages`.
 */
export function partitionSessionImages(
  rawImages: ReadonlyArray<RawSessionImageRecord> | undefined
): PartitionedSessionImages {
  if (!rawImages || rawImages.length === 0) {
    return {
      images: EMPTY_IMAGES,
      uploadedImages: EMPTY_UPLOADED_IMAGES,
      aiImages: EMPTY_AI_IMAGES,
    };
  }

  const images: SessionImage[] = [];
  const uploadedImages: UploadedSessionImage[] = [];
  const aiImages: AISessionImage[] = [];

  for (const raw of rawImages) {
    if (raw.type === "ai-generated") {
      const resolvedUrl = raw.imageUrl ?? raw.url ?? "";
      const aiImage: AISessionImage = {
        _id: raw._id as Id<"aiGeneratedImages">,
        _creationTime: raw._creationTime,
        sessionId: raw.sessionId,
        imageUrl: resolvedUrl,
        url: raw.url ?? resolvedUrl,
        width: raw.width,
        height: raw.height,
        x: raw.x,
        y: raw.y,
        scale: raw.scale,
        scaleX: raw.scaleX,
        scaleY: raw.scaleY,
        rotation: raw.rotation,
        opacity: raw.opacity,
        layerOrder: raw.layerOrder,
        createdAt: raw.createdAt ?? raw._creationTime,
        type: "ai-generated",
      };
      aiImages.push(aiImage);
      images.push(aiImage);
    } else {
      const uploadedImage: UploadedSessionImage = {
        _id: raw._id as Id<"uploadedImages">,
        _creationTime: raw._creationTime,
        sessionId: raw.sessionId,
        userId: raw.userId,
        storageId: raw.storageId as Id<"_storage">,
        filename: raw.filename ?? "",
        mimeType: raw.mimeType ?? "image/png",
        width: raw.width,
        height: raw.height,
        x: raw.x,
        y: raw.y,
        scale: raw.scale,
        scaleX: raw.scaleX,
        scaleY: raw.scaleY,
        rotation: raw.rotation,
        opacity: raw.opacity,
        layerOrder: raw.layerOrder,
        url: raw.url ?? undefined,
        type: "uploaded",
      };
      uploadedImages.push(uploadedImage);
      images.push(uploadedImage);
    }
  }

  return {
    images,
    uploadedImages: uploadedImages.length > 0 ? uploadedImages : EMPTY_UPLOADED_IMAGES,
    aiImages: aiImages.length > 0 ? aiImages : EMPTY_AI_IMAGES,
  };
}

export function useSessionImages(
  sessionId: Id<"paintingSessions"> | null,
  options?: UseSessionImagesOptions
) {
  const guestKey =
    options && "guestKey" in options
      ? options.guestKey
      : getGuestKey(sessionId) || undefined;
  const storedEditKey = useSyncExternalStore(
    subscribeEditKeys,
    () => getEditKey(sessionId),
    () => null,
  );
  const editKey =
    options && "editKey" in options ? options.editKey : storedEditKey || undefined;

  // Single reactive subscription returning both uploaded and AI-generated images
  const rawImages = useQuery(
    api.images.getSessionImages,
    sessionId ? { sessionId, guestKey, editKey } : "skip"
  ) as ReadonlyArray<RawSessionImageRecord> | undefined;

  const { images, uploadedImages, aiImages } = useMemo(
    () => partitionSessionImages(rawImages),
    [rawImages]
  );

  // Mutations
  const updateTransform = useMutation(api.images.updateImageTransform);
  const updateAITransform = useMutation(api.images.updateAIImageTransform);
  const updateLayerOrder = useMutation(api.images.updateImageLayerOrder);
  const deleteImageMutation = useMutation(api.images.deleteImage);
  const deleteAIImageMutation = useMutation(api.images.deleteAIImage);
  const addAIGeneratedImageMutation = useMutation(api.images.addAIGeneratedImage);

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

  // Update full transform for uploaded images
  const updateImageTransform = useCallback(async (
    imageId: Id<"uploadedImages">,
    transform: ImageTransformUpdate
  ) => {
    await updateTransform({ imageId, ...transform, guestKey, editKey });
  }, [updateTransform, guestKey, editKey]);

  // Update full transform for AI-generated images
  const updateAIImageTransform = useCallback(async (
    imageId: Id<"aiGeneratedImages">,
    transform: ImageTransformUpdate
  ) => {
    await updateAITransform({ imageId, ...transform, guestKey, editKey });
  }, [updateAITransform, guestKey, editKey]);

  // Change layer order
  const changeLayerOrder = useCallback(async (
    imageId: Id<"uploadedImages">,
    newLayerOrder: number
  ) => {
    await updateLayerOrder({ imageId, newLayerOrder, guestKey, editKey });
  }, [updateLayerOrder, guestKey, editKey]);

  // Delete uploaded image
  const deleteImage = useCallback(async (imageId: Id<"uploadedImages">) => {
    await deleteImageMutation({ imageId, guestKey, editKey });
  }, [deleteImageMutation, guestKey, editKey]);

  // Delete AI-generated image
  const deleteAIImage = useCallback(async (imageId: Id<"aiGeneratedImages">) => {
    await deleteAIImageMutation({ imageId, guestKey, editKey });
  }, [deleteAIImageMutation, guestKey, editKey]);

  // Add AI-generated image to the current session
  const addAIGeneratedImage = useCallback(async (args: AddAIGeneratedImageInput) => {
    if (!sessionId) return undefined;
    return await addAIGeneratedImageMutation({
      ...args,
      sessionId,
      guestKey,
      editKey,
    });
  }, [sessionId, guestKey, editKey, addAIGeneratedImageMutation]);

  return {
    images,
    uploadedImages,
    aiImages,
    isLoading: sessionId !== null && rawImages === undefined,
    moveImage,
    scaleImage,
    rotateImage,
    setImageOpacity,
    updateImageTransform,
    updateAIImageTransform,
    changeLayerOrder,
    deleteImage,
    deleteAIImage,
    addAIGeneratedImage,
  };
}
