import { useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { getGuestKey } from "../utils/guestKey";

export interface TextBlock {
  _id: Id<"textBlocks">;
  sessionId: Id<"paintingSessions">;
  content: string;
  fontFamily: string;
  fontSize: number;
  fontStyle?: "normal" | "italic";
  fontWeight?: string;
  textAlign?: "left" | "center" | "right" | "justify";
  lineHeight?: number;
  fill: string;
  opacity: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  width?: number;
  height?: number;
  layerOrder: number;
  isEditing?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTextBlockArgs {
  x: number;
  y: number;
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  fill?: string;
  opacity?: number;
  lineHeight?: number;
  textAlign?: "left" | "center" | "right" | "justify";
}

export interface UpdateTextBlockArgs {
  blockId: Id<"textBlocks">;
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: "normal" | "italic";
  fontWeight?: string;
  textAlign?: "left" | "center" | "right" | "justify";
  lineHeight?: number;
  fill?: string;
  opacity?: number;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  width?: number;
  height?: number;
  layerOrder?: number;
  isEditing?: boolean;
}

export function useTextBlocks(sessionId: Id<"paintingSessions"> | null) {
  const guestKey = sessionId ? getGuestKey(sessionId) || undefined : undefined;

  const textBlocks = useQuery(
    api.textBlocks.getSessionTextBlocks,
    sessionId ? { sessionId, guestKey } : "skip"
  );

  const createTextBlock = useMutation(api.textBlocks.createTextBlock);
  const updateTextBlock = useMutation(api.textBlocks.updateTextBlock);
  const deleteTextBlock = useMutation(api.textBlocks.deleteTextBlock);
  const reorderTextBlock = useMutation(api.textBlocks.reorderTextBlock);

  const handleCreate = useCallback(async (
    args: CreateTextBlockArgs
  ) => {
    if (!sessionId) return null;
    return await createTextBlock({ sessionId, ...args });
  }, [sessionId, createTextBlock]);

  const handleUpdate = useCallback(async (args: UpdateTextBlockArgs) => {
    await updateTextBlock(args);
  }, [updateTextBlock]);

  const handleDelete = useCallback(async (blockId: Id<"textBlocks">) => {
    await deleteTextBlock({ blockId });
  }, [deleteTextBlock]);

  const handleReorder = useCallback(async (
    blockId: Id<"textBlocks">,
    newOrder: number
  ) => {
    await reorderTextBlock({ blockId, newOrder });
  }, [reorderTextBlock]);

  return {
    textBlocks: textBlocks || [],
    isLoading: textBlocks === undefined,
    createTextBlock: handleCreate,
    updateTextBlock: handleUpdate,
    deleteTextBlock: handleDelete,
    reorderTextBlock: handleReorder,
  };
}
