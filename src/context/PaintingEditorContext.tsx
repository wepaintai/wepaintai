import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import {
  usePaintingSession,
  type CurrentUser,
  type Stroke,
  type UserPresence,
} from '../hooks/usePaintingSession'
import {
  useSessionImages,
  type AISessionImage,
  type SessionImage,
  type UploadedSessionImage,
} from '../hooks/useSessionImages'
import {
  editorPeerIdsFromPresence,
  useP2PPainting,
  type P2PPaintingResult,
} from '../hooks/useP2PPainting'
import type { Layer } from '../components/ToolPanel'

export type PaintLayerDoc = Doc<'paintLayers'>

export interface PaintLayerUpdateInput {
  layerId: Id<'paintLayers'>
  name?: string
  visible?: boolean
  opacity?: number
  x?: number
  y?: number
  scale?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
}

export interface PaintingEditorControllerOptions {
  sessionId: Id<'paintingSessions'> | null
  pendingUndoStrokeIds?: ReadonlySet<string>
}

export interface PaintingEditorContextValue {
  // Session & access state
  sessionId: Id<'paintingSessions'> | null
  validSessionId: Id<'paintingSessions'> | null
  sessionReady: boolean
  sessionError: 'not_found' | 'unauthorized' | null
  guestKey: string | undefined
  /** Edit-link key for this session (sent as its own argument, never via guestKey). */
  editKey: string | undefined
  /** Whether the caller may paint/modify (owner, edit-link collaborator, legacy public). */
  canEdit: boolean
  /** Whether the caller owns the session (destructive ops are owner-only). */
  isOwner: boolean
  session: ReturnType<typeof usePaintingSession>['session']
  sessionStatus: ReturnType<typeof usePaintingSession>['sessionStatus']
  isLoading: boolean

  // User & presence
  currentUser: CurrentUser
  /** Opaque `_id` of this browser's own presence row (filters "self" out of presence). */
  selfPresenceId: string | undefined
  presence: UserPresence[]

  // Strokes & undo/redo
  rawStrokes: Stroke[]
  strokes: Stroke[]
  lastStrokeInfo: ReturnType<typeof usePaintingSession>['lastStrokeInfo']
  undoRedoAvailability: ReturnType<typeof usePaintingSession>['undoRedoAvailability']

  // Session actions
  createNewSession: ReturnType<typeof usePaintingSession>['createNewSession']
  addStrokeToSession: ReturnType<typeof usePaintingSession>['addStrokeToSession']
  updateUserPresence: ReturnType<typeof usePaintingSession>['updateUserPresence']
  setPresenceCadence: ReturnType<typeof usePaintingSession>['setPresenceCadence']
  clearSession: ReturnType<typeof usePaintingSession>['clearSession']
  undoLastStroke: ReturnType<typeof usePaintingSession>['undoLastStroke']
  redoLastStroke: ReturnType<typeof usePaintingSession>['redoLastStroke']

  // Images (derived from a single api.images.getSessionImages subscription)
  images: SessionImage[]
  uploadedImages: UploadedSessionImage[]
  aiImages: AISessionImage[]
  isImagesLoading: boolean
  updateImageTransform: ReturnType<typeof useSessionImages>['updateImageTransform']
  updateAIImageTransform: ReturnType<typeof useSessionImages>['updateAIImageTransform']
  deleteImage: ReturnType<typeof useSessionImages>['deleteImage']
  deleteAIImage: ReturnType<typeof useSessionImages>['deleteAIImage']
  addAIGeneratedImage: ReturnType<typeof useSessionImages>['addAIGeneratedImage']

  // Paint layers (single api.paintLayers.getPaintLayers subscription)
  paintLayers: PaintLayerDoc[] | undefined
  createPaintLayer: (name: string) => Promise<Id<'paintLayers'> | undefined>
  updatePaintLayer: (input: PaintLayerUpdateInput) => Promise<Id<'paintLayers'> | undefined>
  deletePaintLayer: (layerId: Id<'paintLayers'>) => Promise<void>
  reorderLayer: (layerId: string, newOrder: number) => Promise<void>

  // Normalized layers shared across canvas, tool panel, and modals
  layers: Layer[]

  // P2P real-time previews (single P2PManager lifecycle)
  p2p: P2PPaintingResult
}

export function buildEditorLayers({
  paintLayers,
  uploadedImages,
  aiImages,
}: {
  paintLayers: ReadonlyArray<PaintLayerDoc> | undefined
  uploadedImages: ReadonlyArray<UploadedSessionImage>
  aiImages: ReadonlyArray<AISessionImage>
}): Layer[] {
  const allLayers: Layer[] = []

  if (paintLayers && paintLayers.length > 0) {
    paintLayers.forEach((paintLayer) => {
      allLayers.push({
        id: paintLayer._id,
        type: 'paint',
        name: paintLayer.name,
        visible: paintLayer.visible,
        opacity: paintLayer.opacity,
        order: paintLayer.layerOrder,
      })
    })
  }

  uploadedImages.forEach((img, index) => {
    allLayers.push({
      id: img._id,
      type: 'image',
      name: `Upload ${index + 1}`,
      visible: img.opacity > 0,
      opacity: img.opacity,
      order: img.layerOrder,
      thumbnailUrl: img.url || undefined,
    })
  })

  aiImages.forEach((img, index) => {
    allLayers.push({
      id: img._id,
      type: 'ai-image',
      name: `AI Image ${index + 1}`,
      visible: img.opacity > 0,
      opacity: img.opacity,
      order: img.layerOrder,
      thumbnailUrl: img.imageUrl,
    })
  })

  return allLayers
}

/**
 * Single source of truth for all reactive Convex subscriptions, presence
 * heartbeats, and WebRTC P2P lifecycle in an active painting editor tab.
 * Mount once at the editor root (`PaintingView`) and share via
 * `PaintingEditorProvider` so `KonvaCanvas` and child panels never create
 * duplicate subscriptions or competing side-effect lifecycles.
 */
export function usePaintingEditorController({
  sessionId,
  pendingUndoStrokeIds,
}: PaintingEditorControllerOptions): PaintingEditorContextValue {
  const {
    session,
    sessionStatus,
    guestKey,
    editKey,
    canEdit,
    isOwner,
    createNewSession,
    presence,
    currentUser,
    selfPresenceId,
    isLoading,
    clearSession,
    undoLastStroke,
    redoLastStroke,
    strokes: rawStrokes,
    undoRedoAvailability,
    lastStrokeInfo,
    addStrokeToSession,
    updateUserPresence,
    setPresenceCadence,
  } = usePaintingSession(sessionId, { includeLiveStrokes: false })

  // Only hit session-scoped queries once the session is confirmed accessible;
  // a malformed URL id would otherwise throw validation errors in every query.
  const sessionReady = !!sessionId && sessionStatus === 'ok'
  const validSessionId = sessionReady ? sessionId : null
  const sessionError: 'not_found' | 'unauthorized' | null =
    sessionId && (sessionStatus === 'not_found' || sessionStatus === 'unauthorized')
      ? sessionStatus
      : null

  // Filter out strokes that are pending undo for optimistic UI across both
  // the canvas and modals.
  const strokes = useMemo(() => {
    if (!pendingUndoStrokeIds || pendingUndoStrokeIds.size === 0) return rawStrokes
    return rawStrokes.filter((stroke) => !pendingUndoStrokeIds.has(stroke._id))
  }, [rawStrokes, pendingUndoStrokeIds])

  // Single image subscription covering both uploaded and AI-generated images.
  const {
    images,
    uploadedImages,
    aiImages,
    isLoading: isImagesLoading,
    updateImageTransform,
    updateAIImageTransform,
    deleteImage,
    deleteAIImage,
    addAIGeneratedImage,
  } = useSessionImages(validSessionId, { guestKey, editKey })

  // Single paint-layers subscription shared by PaintingView and KonvaCanvas.
  const paintLayers = useQuery(
    api.paintLayers.getPaintLayers,
    validSessionId ? { sessionId: validSessionId, guestKey, editKey } : 'skip'
  )

  const createPaintLayerMutation = useMutation(api.paintLayers.createPaintLayer)
  const updatePaintLayerMutation = useMutation(api.paintLayers.updatePaintLayer)
  const deletePaintLayerMutation = useMutation(api.paintLayers.deletePaintLayer)
  const ensureDefaultPaintLayerMutation = useMutation(api.paintLayers.ensureDefaultPaintLayer)
  const reorderLayerMutation = useMutation(api.layers.reorderLayer)

  // Ensure a default paint layer exists once per accessible empty session
  // (editors only: viewers can't write and would just get Unauthorized).
  const ensuredDefaultLayerSessionRef = useRef<Id<'paintingSessions'> | null>(null)
  useEffect(() => {
    if (!validSessionId) {
      ensuredDefaultLayerSessionRef.current = null
      return
    }
    if (!canEdit) return
    if (paintLayers === undefined) return
    if (paintLayers.length > 0) {
      ensuredDefaultLayerSessionRef.current = validSessionId
      return
    }
    if (ensuredDefaultLayerSessionRef.current === validSessionId) return
    ensuredDefaultLayerSessionRef.current = validSessionId
    void ensureDefaultPaintLayerMutation({
      sessionId: validSessionId,
      guestKey,
      editKey,
    }).catch((err) => {
      console.error('[PaintingEditor] Failed to ensure default paint layer:', err)
    })
  }, [validSessionId, canEdit, paintLayers, guestKey, editKey, ensureDefaultPaintLayerMutation])

  // Single WebRTC P2P lifecycle shared by PaintingView (status/debug) and
  // KonvaCanvas (remote strokes/cursors & sending points). Editors only; and
  // packets are applied only from peers that are current editors (presence
  // is editor-only and is cleared for collaborators when the edit link changes).
  const editorPeerIds = useMemo(() => editorPeerIdsFromPresence(presence), [presence])
  const p2p = useP2PPainting({
    sessionId: validSessionId,
    userId: currentUser.id ? currentUser.id.toString() : currentUser.name,
    guestKey,
    editKey,
    enabled: !!currentUser.id && sessionReady && canEdit,
    presence,
    allowedPeerIds: editorPeerIds,
  })

  // When P2P carries cursors, back Convex presence off to a coarse heartbeat;
  // otherwise send at ~4 Hz so collaborators still see live cursors.
  useEffect(() => {
    setPresenceCadence(p2p.isConnected ? 'coarse' : 'realtime')
  }, [p2p.isConnected, setPresenceCadence])

  const createPaintLayer = useCallback(
    async (name: string) => {
      if (!validSessionId || !canEdit) return undefined
      return await createPaintLayerMutation({
        sessionId: validSessionId,
        name,
        guestKey,
        editKey,
      })
    },
    [validSessionId, canEdit, guestKey, editKey, createPaintLayerMutation]
  )

  const updatePaintLayer = useCallback(
    async (input: PaintLayerUpdateInput) => {
      if (!canEdit) return undefined
      return await updatePaintLayerMutation({
        ...input,
        guestKey,
        editKey,
      })
    },
    [canEdit, guestKey, editKey, updatePaintLayerMutation]
  )

  const deletePaintLayer = useCallback(
    async (layerId: Id<'paintLayers'>) => {
      // Hard deletes are owner-only (the backend enforces it too).
      if (!isOwner) return
      await deletePaintLayerMutation({
        layerId,
        guestKey,
        editKey,
      })
    },
    [isOwner, guestKey, editKey, deletePaintLayerMutation]
  )

  const reorderLayer = useCallback(
    async (layerId: string, newOrder: number) => {
      if (!validSessionId || !canEdit) return
      await reorderLayerMutation({
        sessionId: validSessionId,
        layerId,
        newOrder,
        guestKey,
        editKey,
      })
    },
    [validSessionId, canEdit, guestKey, editKey, reorderLayerMutation]
  )

  const layers = useMemo(
    () => buildEditorLayers({ paintLayers, uploadedImages, aiImages }),
    [paintLayers, uploadedImages, aiImages]
  )

  return useMemo(
    () => ({
      sessionId,
      validSessionId,
      sessionReady,
      sessionError,
      guestKey,
      editKey,
      canEdit,
      isOwner,
      session,
      sessionStatus,
      isLoading,
      currentUser,
      selfPresenceId,
      presence,
      rawStrokes,
      strokes,
      lastStrokeInfo,
      undoRedoAvailability,
      createNewSession,
      addStrokeToSession,
      updateUserPresence,
      setPresenceCadence,
      clearSession,
      undoLastStroke,
      redoLastStroke,
      images,
      uploadedImages,
      aiImages,
      isImagesLoading,
      updateImageTransform,
      updateAIImageTransform,
      deleteImage,
      deleteAIImage,
      addAIGeneratedImage,
      paintLayers,
      createPaintLayer,
      updatePaintLayer,
      deletePaintLayer,
      reorderLayer,
      layers,
      p2p,
    }),
    [
      sessionId,
      validSessionId,
      sessionReady,
      sessionError,
      guestKey,
      editKey,
      canEdit,
      isOwner,
      session,
      sessionStatus,
      isLoading,
      currentUser,
      selfPresenceId,
      presence,
      rawStrokes,
      strokes,
      lastStrokeInfo,
      undoRedoAvailability,
      createNewSession,
      addStrokeToSession,
      updateUserPresence,
      setPresenceCadence,
      clearSession,
      undoLastStroke,
      redoLastStroke,
      images,
      uploadedImages,
      aiImages,
      isImagesLoading,
      updateImageTransform,
      updateAIImageTransform,
      deleteImage,
      deleteAIImage,
      addAIGeneratedImage,
      paintLayers,
      createPaintLayer,
      updatePaintLayer,
      deletePaintLayer,
      reorderLayer,
      layers,
      p2p,
    ]
  )
}

const PaintingEditorContext = createContext<PaintingEditorContextValue | null>(null)

export function PaintingEditorProvider({
  value,
  children,
}: {
  value: PaintingEditorContextValue
  children?: ReactNode
}) {
  return (
    <PaintingEditorContext.Provider value={value}>
      {children}
    </PaintingEditorContext.Provider>
  )
}

export function usePaintingEditor(): PaintingEditorContextValue {
  const ctx = useContext(PaintingEditorContext)
  if (!ctx) {
    throw new Error('usePaintingEditor must be used within a PaintingEditorProvider')
  }
  return ctx
}

export { PaintingEditorContext }
