import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback, useEffect, useState, useRef, useMemo, useSyncExternalStore } from "react";
import { p2pLogger } from "../lib/p2p-logger";
import { resolveSessionCapabilities } from "../utils/sessionCapabilities";
import {
  reportSyncFailure,
  reportSyncSuccess,
  enqueueStroke,
  hasPendingStrokes,
  retrySync,
  dropEditLinkStrokes,
} from "../lib/syncStatus";
import { beginInFlightStroke, endInFlightStroke } from "../lib/unsavedChanges";
import {
  getPresenceAuthState,
  getPresenceClient,
  getSelfPresence,
  setSelfPresence,
  useSelfPresenceId,
} from "../lib/presenceClient";
import {
  generateGuestKey,
  getGuestKey,
  setGuestKey,
  removeGuestKey,
  getEditKey,
  removeEditKey,
  subscribeEditKeys,
  getCurrentGuestSession,
  clearCurrentGuestSession,
  getClientId,
} from "../utils/guestKey";

export interface PaintPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface Stroke {
  _id: Id<"strokes">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  layerId?: Id<"paintLayers"> | Id<"uploadedImages"> | Id<"aiGeneratedImages">;
  userId?: Id<"users">;
  userColor: string;
  points: PaintPoint[];
  brushColor: string;
  brushSize: number;
  opacity: number;
  strokeOrder: number;
  isEraser?: boolean;
  colorMode?: 'solid' | 'rainbow';
}

export interface UserPresence {
  _id: Id<"userPresence">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  userId?: Id<"users">;
  userColor: string;
  userName: string;
  cursorX: number;
  cursorY: number;
  isDrawing: boolean;
  currentTool: string;
  lastSeen: number;
}

export interface LiveStroke {
  _id: Id<"liveStrokes">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  userId?: Id<"users">;
  userColor: string;
  userName: string;
  points: PaintPoint[];
  brushColor: string;
  brushSize: number;
  opacity: number;
  colorMode?: 'solid' | 'rainbow';
  lastUpdated: number;
}

export interface CurrentUser {
  id: Id<"users"> | null;
  name: string;
  color: string;
}

export interface UsePaintingSessionOptions {
  /**
   * Whether to subscribe to Convex liveStrokes. The main editor renders
   * real-time previews over WebRTC P2P and does not render Convex liveStrokes,
   * so it disables this subscription to avoid an unused reactive query.
   */
  includeLiveStrokes?: boolean;
}

const EMPTY_STROKES: Stroke[] = [];
const EMPTY_PRESENCE: UserPresence[] = [];
const EMPTY_LIVE_STROKES: LiveStroke[] = [];

// Placeholder identity used on the server and during hydration, before the
// per-browser client id can be read (keeps SSR and the first client render
// identical).
const PENDING_GUEST_IDENTITY: CurrentUser = {
  id: null,
  name: 'Anonymous User',
  color: 'hsl(0, 0%, 60%)',
};

function hashIdentitySeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash + seed.charCodeAt(i)) % 360000;
  }
  return hash;
}

function getUserColor(seed: string): string {
  return `hsl(${hashIdentitySeed(seed) % 360}, 70%, 50%)`;
}

function createGuestIdentity(clientId: string): CurrentUser {
  const hash = hashIdentitySeed(clientId);
  return {
    id: null,
    name: `Guest ${hash % 1000}`,
    color: `hsl(${hash % 360}, 70%, 50%)`,
  };
}

const noopSubscribe = () => () => {};
const getServerClientId = () => null;

export function usePaintingSession(
  sessionId: Id<"paintingSessions"> | null,
  options?: UsePaintingSessionOptions
) {
  const includeLiveStrokes = options?.includeLiveStrokes ?? true;

  // Get current authenticated user from Better Auth
  const authenticatedUser = useQuery(api.auth.getCurrentUser);

  // Stable per-browser id used to derive a consistent guest display identity
  // (and, server-side only, to key guest presence rows). Read via
  // useSyncExternalStore so SSR/hydration see null and the client fills it in.
  const guestClientId = useSyncExternalStore(noopSubscribe, getClientId, getServerClientId);

  const authenticatedUserId = authenticatedUser?._id as Id<"users"> | undefined;
  const authenticatedUserName = authenticatedUser?.name;
  const authenticatedUserEmail = authenticatedUser?.email;

  const currentUser = useMemo<CurrentUser>(() => {
    if (authenticatedUserId) {
      return {
        id: authenticatedUserId,
        name: authenticatedUserName || authenticatedUserEmail || 'User',
        color: getUserColor(authenticatedUserId),
      };
    }
    return guestClientId ? createGuestIdentity(guestClientId) : PENDING_GUEST_IDENTITY;
  }, [authenticatedUserId, authenticatedUserName, authenticatedUserEmail, guestClientId]);

  // In-memory fallback guest key scoped to the exact sessionId that created it
  // (covers browsers where localStorage writes fail without leaking keys across sessions).
  const [createdGuestKey, setCreatedGuestKey] = useState<{
    sessionId: Id<"paintingSessions">;
    key: string;
  } | null>(null);

  // Queries
  const localGuestKey =
    getGuestKey(sessionId) ||
    (sessionId && createdGuestKey?.sessionId === sessionId ? createdGuestKey.key : null);
  const localEditKey = useSyncExternalStore(
    subscribeEditKeys,
    () => getEditKey(sessionId),
    () => null,
  );
  // Always fetch session when we have an ID; backend will enforce access.
  // getSession accepts an arbitrary string and reports not_found for malformed
  // IDs, so a mangled ?session= URL param never throws a validation error.
  const sessionResult = useQuery(
    api.paintingSessions.getSession,
    sessionId
      ? {
          sessionId,
          guestKey: localGuestKey || undefined,
          editKey: localEditKey || undefined,
        }
      : "skip"
  );
  const session = sessionResult?.status === "ok" ? sessionResult.session : null;
  // A pre-AUD-005 backend omits canEdit/isOwner: resolveSessionCapabilities
  // treats that as unknown (owners keep editing) instead of read-only for all.
  const { canEdit, isOwner } = resolveSessionCapabilities(sessionResult, {
    currentUserId: authenticatedUser?._id ?? null,
    hasGuestKey: !!localGuestKey,
  });
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  // 'loading' until both the session query and auth state have resolved, so
  // the UI never flashes an unauthorized/not-found state for the owner.
  const sessionStatus: 'loading' | 'ok' | 'not_found' | 'unauthorized' =
    sessionResult === undefined || authenticatedUser === undefined
      ? 'loading'
      : sessionResult.status;
  const canReadSessionData = sessionStatus === 'ok';
  
  const strokes = useQuery(
    api.strokes.getSessionStrokes,
    sessionId && canReadSessionData
      ? { sessionId, guestKey: localGuestKey || undefined, editKey: localEditKey || undefined }
      : "skip"
  );
  
  const presence = useQuery(
    api.presence.getSessionPresence,
    sessionId && canReadSessionData
      ? { sessionId, guestKey: localGuestKey || undefined, editKey: localEditKey || undefined }
      : "skip"
  );
  
  const liveStrokes = useQuery(
    api.liveStrokes.getLiveStrokes,
    includeLiveStrokes && sessionId && canReadSessionData
      ? { sessionId, guestKey: localGuestKey || undefined, editKey: localEditKey || undefined }
      : "skip"
  );
  
  const undoRedoAvailability = useQuery(
    api.strokes.getUndoRedoAvailability,
    sessionId && canReadSessionData
      ? { sessionId, guestKey: localGuestKey || undefined, editKey: localEditKey || undefined }
      : "skip"
  );

  // Mutations
  const createSession = useMutation(api.paintingSessions.createSession);
  const addStroke = useMutation(api.strokes.addStroke);
  const clearSessionMutation = useMutation(api.strokes.clearSession);
  const removeLastStroke = useMutation(api.strokes.removeLastStroke);
  const restoreLastDeletedStroke = useMutation(api.strokes.restoreLastDeletedStroke);
  const leaveSession = useMutation(api.presence.leaveSession);
  const updateLiveStroke = useMutation(api.liveStrokes.updateLiveStroke);
  const clearLiveStroke = useMutation(api.liveStrokes.clearLiveStroke);
  const clearSessionLiveStrokes = useMutation(api.liveStrokes.clearSessionLiveStrokes);
  const upsertViewerState = useMutation(api.viewerAcks.upsertViewerState);
  const removeViewerState = useMutation(api.viewerAcks.removeViewerState);
  const claimGuestSession = useMutation(api.paintingSessions.claimGuestSession);
  
  // For viewer state, use user ID if authenticated, otherwise use name as viewer ID
  const viewerId = currentUser.id || currentUser.name;
  const getViewerState = useQuery(api.viewerAcks.getViewerState,
    sessionId && viewerId && canReadSessionData
      ? {
          sessionId,
          viewerId,
          guestKey: localGuestKey || undefined,
          editKey: localEditKey || undefined,
        }
      : "skip"
  );

  const localLastAckedStrokeOrderRef = useRef<number>(0);

  // Drop a stale/revoked edit key once the backend confirms it no longer grants
  // edit access, along with any queued strokes that relied on it (they can
  // never be saved; the sync banner tells the user they were dropped).
  useEffect(() => {
    if (!sessionId || !localEditKey || !sessionResult) return;
    if (
      sessionResult.status === "unauthorized" ||
      (sessionResult.status === "ok" && sessionResult.canEdit === false)
    ) {
      removeEditKey(sessionId);
      dropEditLinkStrokes(sessionId);
    }
  }, [sessionId, localEditKey, sessionResult]);

  // If a signed-in user holds the guest key for a guest-owned session, they
  // created it on this device before signing in — claim it for their account
  // so the painting survives the sign-in round-trip.
  const claimingGuestSessionRef = useRef(false);
  useEffect(() => {
    if (!sessionId || !authenticatedUser || !session) return;
    if (!session.hasGuestOwner) return;
    const guestKey = getGuestKey(sessionId);
    if (!guestKey) return;
    if (claimingGuestSessionRef.current) return;
    claimingGuestSessionRef.current = true;
    claimGuestSession({ sessionId, guestKey })
      .then(() => {
        // On success the key is spent; on "invalid" it's provably useless
        // (wrong key or someone else owns the session) — either way, drop the
        // local pointers so signed-in loads stop resuming this session.
        removeGuestKey(sessionId);
        setCreatedGuestKey((prev) => (prev?.sessionId === sessionId ? null : prev));
        if (getCurrentGuestSession() === sessionId) {
          clearCurrentGuestSession();
        }
      })
      .catch((e) => {
        console.error("[usePaintingSession] Failed to claim guest session:", e);
      })
      .finally(() => {
        claimingGuestSessionRef.current = false;
      });
  }, [sessionId, authenticatedUser, session, claimGuestSession]);

  // Reset per-session ack tracking when switching sessions
  useEffect(() => {
    localLastAckedStrokeOrderRef.current = 0;
  }, [sessionId]);

  // Effect to initialize lastAckedStrokeOrder from server
  useEffect(() => {
    if (getViewerState?.lastAckedStrokeOrder) {
      localLastAckedStrokeOrderRef.current = getViewerState.lastAckedStrokeOrder;
    }
  }, [getViewerState]);


  // Effect to process strokes and update viewer acknowledgement (editors only)
  useEffect(() => {
    if (canEdit && strokes && strokes.length > 0 && sessionId && currentUser.id) {
      const maxStrokeOrder = strokes.reduce((max, stroke) => Math.max(max, stroke.strokeOrder), 0);
      if (maxStrokeOrder > localLastAckedStrokeOrderRef.current) {
        localLastAckedStrokeOrderRef.current = maxStrokeOrder;
        upsertViewerState({
          sessionId,
          viewerId: currentUser.id,
          lastAckedStrokeOrder: maxStrokeOrder,
          guestKey: localGuestKey || undefined,
          editKey: localEditKey || undefined,
        }).catch((e) => reportSyncFailure(e));
      }
    }
  }, [canEdit, strokes, sessionId, currentUser.id, upsertViewerState, localGuestKey, localEditKey]);

  // Create a new session
  const createNewSession = useCallback(async (
    name?: string,
    canvasWidth: number = 800,
    canvasHeight: number = 600
  ) => {
    const payload: {
      name?: string;
      canvasWidth: number;
      canvasHeight: number;
      isPublic: boolean;
      guestKey?: string;
    } = { name, canvasWidth, canvasHeight, isPublic: false };
    // Private by default; guests authenticate with a per-session guestOwnerKey
    if (!authenticatedUser) {
      const guestKey = generateGuestKey();
      payload.guestKey = guestKey;
      const newId = await createSession(payload);
      if (newId) {
        setGuestKey(newId, guestKey);
        setCreatedGuestKey({ sessionId: newId, key: guestKey });
      }
      return newId;
    }
    return await createSession(payload);
  }, [createSession, authenticatedUser]);

  // Add a stroke to the session
  const addStrokeToSession = useCallback(async (
    points: PaintPoint[],
    brushColor: string,
    brushSize: number,
    opacity: number = 1,
    isEraser: boolean = false,
    layerId?: string | null,
    colorMode?: 'solid' | 'rainbow'
  ) => {
    if (!sessionId || !canEdit) return;
    
    console.log('[usePaintingSession] Adding stroke with isEraser:', isEraser, 'layerId:', layerId, 'colorMode:', colorMode);

    const strokeArgs = {
      sessionId,
      layerId: layerId ? (layerId as Id<"paintLayers"> | Id<"uploadedImages"> | Id<"aiGeneratedImages">) : undefined,
      userId: currentUser.id || undefined,  // Allow undefined for guest users
      userColor: currentUser.color,
      points,
      brushColor,
      brushSize,
      opacity,
      isEraser,
      colorMode,
      guestKey: localGuestKey || undefined,
      editKey: localEditKey || undefined,
    };

    // While earlier strokes are queued for replay, route new strokes through
    // the queue too — sending them directly would save them ahead of the
    // queued ones, inverting stroke order (and making undo hit the wrong
    // stroke). The returned promise resolves with the backend id on replay.
    if (hasPendingStrokes()) {
      const replayPromise = enqueueStroke(strokeArgs);
      void retrySync();
      return replayPromise;
    }

    beginInFlightStroke();
    try {
      const strokeId = await addStroke(strokeArgs);
      reportSyncSuccess();
      return strokeId;
    } catch (e) {
      // Queue the stroke for replay after re-auth/reconnect and surface the
      // failure via the sync banner instead of failing silently. The replay
      // promise resolves with the eventual backend id (or undefined if the
      // stroke is dropped) so the canvas can reconcile its optimistic copy.
      console.error('[usePaintingSession] Failed to save stroke:', e);
      return reportSyncFailure(e, strokeArgs);
    } finally {
      endInFlightStroke();
    }
  }, [sessionId, canEdit, addStroke, currentUser, localGuestKey, localEditKey]);

  // Opaque id of this browser's own presence row (from updatePresence), used
  // to filter ourselves out of presence lists. Guests' per-browser client id
  // is never exposed to other clients.
  const selfPresenceId = useSelfPresenceId(sessionId);

  // Presence throttling and heartbeat
  const presenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPresenceSentAtRef = useRef<number>(0);
  const pendingPresenceRef = useRef<{
    cursorX: number;
    cursorY: number;
    isDrawing: boolean;
    currentTool: string;
  } | null>(null);
  const lastSentPresenceRef = useRef<{
    cursorX: number;
    cursorY: number;
    isDrawing: boolean;
    currentTool: string;
  } | null>(null);
  const presenceInFlightRef = useRef<boolean>(false);
  // Cursor send cadence. Defaults to ~4 Hz so collaborators see each other's
  // cursors via Convex presence; when P2P is connected the editor switches to
  // 'coarse' (20s) since cursors travel over the data channel instead.
  const presenceThrottleMsRef = useRef<number>(250);
  const setPresenceCadence = useCallback((mode: 'realtime' | 'coarse') => {
    presenceThrottleMsRef.current = mode === 'realtime' ? 250 : 20000;
  }, []);

  // Reset queued/last-sent cursor presence when switching sessions
  useEffect(() => {
    pendingPresenceRef.current = null;
    lastSentPresenceRef.current = null;
    lastPresenceSentAtRef.current = 0;
  }, [sessionId]);

  // Send the latest queued presence update if not already in flight
  const flushPresence = useCallback(async () => {
    if (!sessionId || !canEdit) return;
    if (presenceInFlightRef.current) return;
    const payload = pendingPresenceRef.current;
    if (!payload) return;
    // Presence uses its own low-priority connection; wait until its auth has
    // settled so a signed-in user's cursor never goes out as anonymous.
    const presenceClient = getPresenceClient();
    const presenceAuth = getPresenceAuthState();
    if (!presenceClient || !presenceAuth.ready) return;
    if (currentUser.id && !presenceAuth.authenticated) return;
    presenceInFlightRef.current = true;
    try {
      const result = await presenceClient.mutation(api.presence.updatePresence, {
        sessionId,
        guestId: currentUser.id ? undefined : getClientId(),
        userColor: currentUser.color,
        userName: currentUser.name,
        guestKey: localGuestKey || undefined,
        editKey: localEditKey || undefined,
        ...payload,
      });
      if (result) {
        setSelfPresence(sessionId, result);
      }
      lastPresenceSentAtRef.current = Date.now();
      lastSentPresenceRef.current = payload;
      // Only clear if no newer update was queued while the mutation was in flight
      if (pendingPresenceRef.current === payload) {
        pendingPresenceRef.current = null;
      }
      // On collaborative edit-link sessions presence can succeed without user auth,
      // so presence successes must not clear an auth-kind error — reportSyncSuccess gates on source.
      reportSyncSuccess("presence");
    } catch (e) {
      // Presence is best-effort, but a failure here is the same auth/network
      // problem that breaks stroke saving — surface it via the sync banner.
      reportSyncFailure(e);
    } finally {
      presenceInFlightRef.current = false;
    }
  }, [sessionId, canEdit, currentUser.id, currentUser.color, currentUser.name, localGuestKey, localEditKey]);

  // Presence heartbeat every 20s: flush anything queued, or re-send the last
  // position so lastSeen stays fresh and idle users still count as online.
  useEffect(() => {
    if (!sessionId || !canEdit) return;

    if (presenceIntervalRef.current) {
      clearInterval(presenceIntervalRef.current);
      presenceIntervalRef.current = null;
    }

    presenceIntervalRef.current = setInterval(() => {
      if (!pendingPresenceRef.current && lastSentPresenceRef.current) {
        pendingPresenceRef.current = lastSentPresenceRef.current;
      }
      void flushPresence();
    }, 20000); // 20s

    return () => {
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
        presenceIntervalRef.current = null;
      }
    };
  }, [sessionId, canEdit, flushPresence]);

  // Update user presence (enqueue latest + leading-edge send if stale)
  const updateUserPresence = useCallback(
    async (
      cursorX: number,
      cursorY: number,
      isDrawing: boolean,
      currentTool: string
    ) => {
      if (!sessionId || !canEdit) return;

      // Nothing changed since the last send: the 20s heartbeat keeps lastSeen
      // fresh, so don't spend a mutation on it.
      const last = lastSentPresenceRef.current;
      if (
        !pendingPresenceRef.current &&
        last &&
        last.cursorX === cursorX &&
        last.cursorY === cursorY &&
        last.isDrawing === isDrawing &&
        last.currentTool === currentTool
      ) {
        return;
      }
      pendingPresenceRef.current = { cursorX, cursorY, isDrawing, currentTool };

      const now = Date.now();
      if (now - lastPresenceSentAtRef.current > presenceThrottleMsRef.current) {
        await flushPresence();
      }
    },
    [sessionId, canEdit, flushPresence]
  );

  // Clear all strokes from the session (owner only)
  const clearSession = useCallback(async () => {
    if (!sessionId || !isOwner) return;
    
    // Clear both completed strokes and live strokes
    try {
      await Promise.all([
        clearSessionMutation({ sessionId, guestKey: localGuestKey || undefined }),
        clearSessionLiveStrokes({ sessionId, guestKey: localGuestKey || undefined })
      ]);
    } catch (e) {
      // Surface via the sync banner instead of failing silently, then rethrow
      // so the caller's own error handling still runs.
      reportSyncFailure(e);
      throw e;
    }
    
    // Reset local acknowledgment state
    localLastAckedStrokeOrderRef.current = 0;
    
    // Update viewer state to reflect cleared session
    if (currentUser.id) {
      await upsertViewerState({
        sessionId,
        viewerId: currentUser.id,
        lastAckedStrokeOrder: 0,
        guestKey: localGuestKey || undefined,
        editKey: localEditKey || undefined,
      });
    }
  }, [sessionId, isOwner, clearSessionMutation, clearSessionLiveStrokes, currentUser.id, upsertViewerState, localGuestKey, localEditKey]);

  // Undo the last stroke
  const undoLastStroke = useCallback(async () => {
    if (!sessionId || !canEdit) return false;

    try {
      const result = await removeLastStroke({
        sessionId,
        guestKey: localGuestKey || undefined,
        editKey: localEditKey || undefined,
      });
      reportSyncSuccess();
      return result;
    } catch (e) {
      console.error('[usePaintingSession] Failed to undo stroke:', e);
      reportSyncFailure(e);
      return false;
    }
  }, [sessionId, canEdit, removeLastStroke, localGuestKey, localEditKey]);

  // Redo the last undone stroke
  const redoLastStroke = useCallback(async () => {
    if (!sessionId || !canEdit) return false;

    try {
      const result = await restoreLastDeletedStroke({
        sessionId,
        guestKey: localGuestKey || undefined,
        editKey: localEditKey || undefined,
      });
      reportSyncSuccess();
      return result;
    } catch (e) {
      console.error('[usePaintingSession] Failed to redo stroke:', e);
      reportSyncFailure(e);
      return false;
    }
  }, [sessionId, canEdit, restoreLastDeletedStroke, localGuestKey, localEditKey]);

  // Throttle live stroke updates to reduce lag
  const liveStrokeUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLiveStrokeRef = useRef<{
    points: PaintPoint[];
    brushColor: string;
    brushSize: number;
    opacity: number;
    colorMode?: 'solid' | 'rainbow';
  } | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);

  // Update live stroke (for in-progress drawing) with throttling
  const updateLiveStrokeForUser = useCallback((
    points: PaintPoint[],
    brushColor: string,
    brushSize: number,
    opacity: number = 1,
    colorMode?: 'solid' | 'rainbow'
  ) => {
    if (!sessionId || !canEdit) return;
    
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTimeRef.current;
    
    // Store the latest stroke data
    pendingLiveStrokeRef.current = { points, brushColor, brushSize, opacity, colorMode };
    
    // If this is the first point or enough time has passed, update immediately
    if (points.length === 1 || timeSinceLastUpdate >= 16) { // ~60 FPS for immediate updates
      lastUpdateTimeRef.current = now;
      p2pLogger.logConvex('updateLiveStroke', { pointCount: points.length });
      updateLiveStroke({
        sessionId,
        userId: currentUser.id || undefined,
        guestId: currentUser.id ? undefined : getClientId(),
        userColor: currentUser.color,
        userName: currentUser.name,
        points,
        brushColor,
        brushSize,
        opacity,
        colorMode,
        guestKey: localGuestKey || undefined,
        editKey: localEditKey || undefined,
      }).catch((e) => reportSyncFailure(e));
      pendingLiveStrokeRef.current = null;
      
      // Clear any pending timeout since we just updated
      if (liveStrokeUpdateRef.current) {
        clearTimeout(liveStrokeUpdateRef.current);
        liveStrokeUpdateRef.current = null;
      }
      return;
    }
    
    // Clear existing timeout
    if (liveStrokeUpdateRef.current) {
      clearTimeout(liveStrokeUpdateRef.current);
    }
    
    // Throttle subsequent updates to every 16ms (~60 FPS) for smooth performance
    liveStrokeUpdateRef.current = setTimeout(() => {
      const pending = pendingLiveStrokeRef.current;
      if (pending) {
        lastUpdateTimeRef.current = Date.now();
        p2pLogger.logConvex('updateLiveStroke (throttled)', { pointCount: pending.points.length });
        updateLiveStroke({
          sessionId,
          userId: currentUser.id || undefined,
          guestId: currentUser.id ? undefined : getClientId(),
          userColor: currentUser.color,
          userName: currentUser.name,
          points: pending.points,
          brushColor: pending.brushColor,
          brushSize: pending.brushSize,
          opacity: pending.opacity,
          colorMode: pending.colorMode,
          guestKey: localGuestKey || undefined,
          editKey: localEditKey || undefined,
        }).catch((e) => reportSyncFailure(e));
        pendingLiveStrokeRef.current = null;
      }
      liveStrokeUpdateRef.current = null;
    }, 16); // 16ms throttle (~60 FPS)
  }, [sessionId, canEdit, updateLiveStroke, currentUser, localGuestKey, localEditKey]);

  // Clear live stroke (when finishing drawing). Guests are keyed by their
  // stable per-browser client id instead of a user id.
  const clearLiveStrokeForUser = useCallback(async () => {
    if (!sessionId || !canEdit) return;

    return await clearLiveStroke({
      sessionId,
      userId: currentUser.id || undefined,
      guestId: currentUser.id ? undefined : getClientId(),
      guestKey: localGuestKey || undefined,
      editKey: localEditKey || undefined,
    });
  }, [sessionId, canEdit, currentUser.id, clearLiveStroke, localGuestKey, localEditKey]);

  // Leave session on unmount / session (or identity) change and cleanup timeouts.
  //
  // The effect is keyed only on the session and the viewer identity — never on
  // load state — so a transient return to "loading" (e.g. while a guest key is
  // claimed on sign-in) can't remove our presence row or viewer state. The
  // leave itself is deferred one tick and cancelled if the same session/viewer
  // re-subscribes immediately, which is what React StrictMode's simulated
  // unmount/remount does in development.
  const pendingLeaveRef = useRef<{
    key: string;
    timer: ReturnType<typeof setTimeout>;
    run: () => void;
  } | null>(null);
  useEffect(() => {
    const currentSessionId = sessionId; // Capture sessionId for cleanup
    const currentViewerId = currentUser.id; // Capture viewerId for cleanup
    const leaveKey = `${currentSessionId ?? ''}|${currentViewerId ?? 'guest'}`;

    if (pendingLeaveRef.current?.key === leaveKey) {
      // Same session + viewer re-subscribed right away: not a real leave.
      clearTimeout(pendingLeaveRef.current.timer);
      pendingLeaveRef.current = null;
    }

    // Tab close / navigation away never runs React cleanup reliably, and
    // WebSocket mutations don't flush during pagehide — use sendBeacon to an
    // HTTP action so presence and any in-progress live stroke are removed
    // immediately instead of lingering until the staleness cutoffs.
    const handlePageHide = () => {
      if (!currentSessionId || !canEditRef.current) return;
      const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
      if (!siteUrl || typeof navigator.sendBeacon !== "function") return;
      // The leave token (issued to us by updatePresence) authorizes removing
      // our own presence row; without it there is nothing to send.
      const self = getSelfPresence(currentSessionId);
      if (!self) return;
      const payload = JSON.stringify({
        sessionId: currentSessionId,
        presenceId: self.presenceId,
        leaveToken: self.leaveToken,
      });
      // text/plain keeps this a "simple" request (no CORS preflight)
      navigator.sendBeacon(
        `${siteUrl}/presence/leave`,
        new Blob([payload], { type: "text/plain" })
      );
    };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      // Clean up any pending live stroke updates
      if (liveStrokeUpdateRef.current) {
        clearTimeout(liveStrokeUpdateRef.current);
        liveStrokeUpdateRef.current = null;
      }
      if (!currentSessionId || !canEditRef.current) return;
      const runLeave = () => {
        pendingLeaveRef.current = null;
        const currentGuestKey = getGuestKey(currentSessionId) || undefined;
        const currentEditKey = getEditKey(currentSessionId) || undefined;
        // Only remove a presence row we actually established.
        if (getSelfPresence(currentSessionId)) {
          // Guests identify by their stable client id instead of a user id
          void leaveSession({
            sessionId: currentSessionId,
            guestId: currentViewerId ? undefined : getClientId(),
            guestKey: currentGuestKey,
            editKey: currentEditKey,
          }).catch(() => {});
          setSelfPresence(currentSessionId, null);
        }
        if (currentViewerId) {
          void removeViewerState({
            sessionId: currentSessionId,
            viewerId: currentViewerId,
            guestKey: currentGuestKey,
            editKey: currentEditKey,
          }).catch(() => {});
        }
      };
      const previous = pendingLeaveRef.current;
      if (previous) {
        // A different session/viewer was still pending: flush it now.
        clearTimeout(previous.timer);
        previous.run();
      }
      pendingLeaveRef.current = { key: leaveKey, timer: setTimeout(runLeave, 0), run: runLeave };
    };
  }, [sessionId, leaveSession, removeViewerState, currentUser.id]);

  // Memoized strokes with pre-sorted order and metadata for O(1) access
  const { memoizedStrokes, lastStrokeInfo } = useMemo(() => {
    if (!strokes || strokes.length === 0) {
      return { memoizedStrokes: EMPTY_STROKES, lastStrokeInfo: null };
    }
    
    // Check if strokes are already sorted to avoid unnecessary sorting
    let sorted = strokes;
    let needsSort = false;
    
    for (let i = 1; i < strokes.length; i++) {
      if (strokes[i].strokeOrder < strokes[i - 1].strokeOrder) {
        needsSort = true;
        break;
      }
    }
    
    if (needsSort) {
      sorted = [...strokes].sort((a, b) => a.strokeOrder - b.strokeOrder);
    }
    
    const last = sorted[sorted.length - 1];
    
    return {
      memoizedStrokes: sorted,
      lastStrokeInfo: {
        id: last._id,
        order: last.strokeOrder
      }
    };
  }, [strokes]);


  // TODO: Implement a more direct catch-up query if getSessionStrokes proves insufficient
  // For example, using api.strokes.getStrokesAfter with localLastAckedStrokeOrderRef.current

  return {
    // Data
    session,
    sessionStatus,
    canEdit,
    isOwner,
    guestKey: localGuestKey || undefined,
    editKey: localEditKey || undefined,
    strokes: memoizedStrokes,
    lastStrokeInfo,
    presence: presence ?? EMPTY_PRESENCE,
    liveStrokes: liveStrokes ?? EMPTY_LIVE_STROKES,
    currentUser,
    selfPresenceId,
    undoRedoAvailability,

    // Actions
    createNewSession,
    addStrokeToSession,
    updateUserPresence,
    setPresenceCadence,
    clearSession,
    undoLastStroke,
    redoLastStroke,
    updateLiveStrokeForUser,
    clearLiveStrokeForUser,
    
    // State
    isLoading: sessionId !== null && sessionStatus === 'loading',
  };
}
