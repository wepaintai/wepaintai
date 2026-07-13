import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { p2pLogger } from "../lib/p2p-logger";
import { convexLow } from "../lib/convex";
import {
  reportSyncFailure,
  reportSyncSuccess,
  enqueueStroke,
  hasPendingStrokes,
  retrySync,
} from "../lib/syncStatus";
import { beginInFlightStroke, endInFlightStroke } from "../lib/unsavedChanges";
import {
  generateGuestKey,
  getGuestKey,
  setGuestKey,
  removeGuestKey,
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
  guestId?: string;
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

export function usePaintingSession(sessionId: Id<"paintingSessions"> | null) {
  // Get current authenticated user from Better Auth
  const authenticatedUser = useQuery(api.auth.getCurrentUser);
  
  // Generate a consistent color based on user ID or use a random one for anonymous users
  const getUserColor = (userId: string | null) => {
    if (!userId) return `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`;
    // Generate a consistent color based on user ID
    const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return `hsl(${hash % 360}, 70%, 50%)`;
  };
  
  const [currentUser, setCurrentUser] = useState<{
    id: Id<"users"> | null;
    name: string;
    color: string;
  }>({
    id: null,
    name: 'Anonymous User',
    color: getUserColor(null),
  });

  // Guest key state (in-memory) to ensure we always pass it on initial queries
  const [guestKeyState, setGuestKeyState] = useState<string | null>(null);
  useEffect(() => {
    // Re-read on session change so a stale key from a previous session is never sent
    setGuestKeyState(getGuestKey(sessionId as any));
  }, [sessionId]);

  // Queries
  const localGuestKey = guestKeyState || getGuestKey(sessionId as any);
  // Always fetch session when we have an ID; backend will enforce access.
  // getSession accepts an arbitrary string and reports not_found for malformed
  // IDs, so a mangled ?session= URL param never throws a validation error.
  const sessionResult = useQuery(
    api.paintingSessions.getSession,
    sessionId ? { sessionId, guestKey: localGuestKey || undefined } : "skip"
  );
  const session = sessionResult?.status === "ok" ? sessionResult.session : null;
  // 'loading' until both the session query and auth state have resolved, so
  // the UI never flashes an unauthorized/not-found state for the owner.
  const sessionStatus: 'loading' | 'ok' | 'not_found' | 'unauthorized' =
    sessionResult === undefined || authenticatedUser === undefined
      ? 'loading'
      : sessionResult.status;
  const canReadSessionData = sessionStatus === 'ok';
  
  const strokes = useQuery(
    api.strokes.getSessionStrokes,
    sessionId && canReadSessionData ? { sessionId, guestKey: localGuestKey || undefined } : "skip"
  );
  
  const presence = useQuery(
    api.presence.getSessionPresence,
    sessionId && canReadSessionData ? { sessionId, guestKey: localGuestKey || undefined } : "skip"
  );
  
  const liveStrokes = useQuery(
    api.liveStrokes.getLiveStrokes,
    sessionId && canReadSessionData ? { sessionId, guestKey: localGuestKey || undefined } : "skip"
  );
  
  const undoRedoAvailability = useQuery(
    api.strokes.getUndoRedoAvailability,
    sessionId && canReadSessionData ? { sessionId, guestKey: localGuestKey || undefined } : "skip"
  );

  // Mutations
  const createSession = useMutation(api.paintingSessions.createSession);
  const addStroke = useMutation(api.strokes.addStroke);
  const clearSessionMutation = useMutation(api.strokes.clearSession);
  const removeLastStroke = useMutation(api.strokes.removeLastStroke);
  const restoreLastDeletedStroke = useMutation(api.strokes.restoreLastDeletedStroke);
  // presence updates use convexLow.mutation with throttling; see updateUserPresence below
  const leaveSession = useMutation(api.presence.leaveSession);
  const updateLiveStroke = useMutation(api.liveStrokes.updateLiveStroke);
  const clearLiveStroke = useMutation(api.liveStrokes.clearLiveStroke);
  const clearSessionLiveStrokes = useMutation(api.liveStrokes.clearSessionLiveStrokes);
  const upsertViewerState = useMutation(api.viewerAcks.upsertViewerState);
  const removeViewerState = useMutation(api.viewerAcks.removeViewerState);
  const claimSessionOwnership = useMutation(api.paintingSessions.claimSessionOwnership);
  const claimGuestSession = useMutation(api.paintingSessions.claimGuestSession);
  
  // For viewer state, use user ID if authenticated, otherwise use name as viewer ID
  const viewerId = currentUser.id || currentUser.name;
  const getViewerState = useQuery(api.viewerAcks.getViewerState,
    sessionId && viewerId && canReadSessionData ? { sessionId, viewerId } : "skip"
  );

  const localLastAckedStrokeOrderRef = useRef<number>(0);

  // Update current user when authenticated user changes
  useEffect(() => {
    if (authenticatedUser) {
      setCurrentUser({
        id: authenticatedUser._id as Id<"users">,
        name: authenticatedUser.name || authenticatedUser.email || 'User',
        color: getUserColor(authenticatedUser._id),
      });
    } else {
      // For anonymous users, we'll use a session-based identifier
      setCurrentUser({
        id: null,
        name: `Guest ${Math.floor(Math.random() * 1000)}`,
        color: getUserColor(null),
      });
    }
  }, [authenticatedUser]);

  // If the session has no owner and no guestOwnerKey, and we are authenticated, claim it
  useEffect(() => {
    if (!sessionId) return;
    if (!authenticatedUser) return;
    if (!session) return;
    if (session.createdBy !== undefined) return;
    // Avoid claiming sessions that have a guest owner key
    if (session.hasGuestOwner) return;
    claimSessionOwnership({ sessionId });
  }, [sessionId, authenticatedUser, session, claimSessionOwnership]);

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
        setGuestKeyState(null);
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

  // Remove duplicate warming queries as they're ineffective and already defined above

  // Effect to initialize lastAckedStrokeOrder from server
  useEffect(() => {
    if (getViewerState?.lastAckedStrokeOrder) {
      localLastAckedStrokeOrderRef.current = getViewerState.lastAckedStrokeOrder;
    }
  }, [getViewerState]);


  // Effect to process strokes and update viewer acknowledgement
  useEffect(() => {
    if (strokes && strokes.length > 0 && sessionId && currentUser.id) {
      const maxStrokeOrder = strokes.reduce((max, stroke) => Math.max(max, stroke.strokeOrder), 0);
      if (maxStrokeOrder > localLastAckedStrokeOrderRef.current) {
        localLastAckedStrokeOrderRef.current = maxStrokeOrder;
        upsertViewerState({
          sessionId,
          viewerId: currentUser.id,
          lastAckedStrokeOrder: maxStrokeOrder,
          guestKey: localGuestKey || undefined,
        }).catch((e) => reportSyncFailure(e));
      }
    }
  }, [strokes, sessionId, currentUser.id, upsertViewerState, localGuestKey]);

  // Create a new session
  const createNewSession = useCallback(async (
    name?: string,
    canvasWidth: number = 800,
    canvasHeight: number = 600
  ) => {
    const payload: any = { name, canvasWidth, canvasHeight };
    // Private by default for authenticated users, public for guests
    if (authenticatedUser) {
      payload.isPublic = false;
    } else {
      // Generate a guest key and send to server
      const guestKey = generateGuestKey();
      setGuestKeyState(guestKey);
      payload.guestKey = guestKey;
      // When frontend auth is disabled for local dev, make sessions public
      // so mutations don't require guestKey authorization.
      if (import.meta.env.VITE_AUTH_DISABLED === 'true') {
        payload.isPublic = true;
      }
      const newId = await createSession(payload);
      if (newId) setGuestKey(newId, guestKey);
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
    if (!sessionId) return;
    
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
  }, [sessionId, addStroke, currentUser, localGuestKey]);

  // Stable per-browser id used to key guest presence records (guests have no userId)
  const presenceGuestId = currentUser.id ? undefined : getClientId();

  // Presence throttling and heartbeat
  const presenceIntervalRef = useRef<NodeJS.Timeout | null>(null);
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
  // cursors via Convex presence; when P2P is connected the canvas switches to
  // 'coarse' (20s) since cursors travel over the data channel instead.
  const presenceThrottleMsRef = useRef<number>(250);
  const setPresenceCadence = useCallback((mode: 'realtime' | 'coarse') => {
    presenceThrottleMsRef.current = mode === 'realtime' ? 250 : 20000;
  }, []);

  // Send the latest queued presence update if not already in flight
  const flushPresence = useCallback(async () => {
    if (!sessionId) return;
    if (presenceInFlightRef.current) return;
    const payload = pendingPresenceRef.current;
    if (!payload) return;
    presenceInFlightRef.current = true;
    try {
      await convexLow.mutation(api.presence.updatePresence, {
        sessionId,
        userId: currentUser.id || undefined,
        guestId: currentUser.id ? undefined : getClientId(),
        userColor: currentUser.color,
        userName: currentUser.name,
        ...payload,
      });
      lastPresenceSentAtRef.current = Date.now();
      lastSentPresenceRef.current = payload;
      // Only clear if no newer update was queued while the mutation was in flight
      if (pendingPresenceRef.current === payload) {
        pendingPresenceRef.current = null;
      }
      // updatePresence is unauthenticated, so this success can't clear an
      // auth-kind error — reportSyncSuccess gates on the source.
      reportSyncSuccess("presence");
    } catch (e) {
      // Presence is best-effort, but a failure here is the same auth/network
      // problem that breaks stroke saving — surface it via the sync banner.
      reportSyncFailure(e);
    } finally {
      presenceInFlightRef.current = false;
    }
  }, [sessionId, currentUser.id, currentUser.color, currentUser.name]);

  // Presence heartbeat every 20s: flush anything queued, or re-send the last
  // position so lastSeen stays fresh and idle users still count as online.
  useEffect(() => {
    if (!sessionId) return;

    if (presenceIntervalRef.current) {
      clearInterval(presenceIntervalRef.current);
      presenceIntervalRef.current = null;
    }

    presenceIntervalRef.current = setInterval(() => {
      if (!pendingPresenceRef.current && lastSentPresenceRef.current) {
        pendingPresenceRef.current = lastSentPresenceRef.current;
      }
      flushPresence();
    }, 20000); // 20s

    return () => {
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
        presenceIntervalRef.current = null;
      }
    };
  }, [sessionId, currentUser.id, currentUser.color, currentUser.name, flushPresence]);

  // Update user presence (enqueue latest + leading-edge send if stale)
  const updateUserPresence = useCallback(
    async (
      cursorX: number,
      cursorY: number,
      isDrawing: boolean,
      currentTool: string
    ) => {
      if (!sessionId) return;

      pendingPresenceRef.current = { cursorX, cursorY, isDrawing, currentTool };

      const now = Date.now();
      if (now - lastPresenceSentAtRef.current > presenceThrottleMsRef.current) {
        await flushPresence();
      }
    },
    [sessionId, currentUser.id, currentUser.color, currentUser.name, flushPresence]
  );

  // Clear all strokes from the session
  const clearSession = useCallback(async () => {
    if (!sessionId) return;
    
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
      });
    }
  }, [sessionId, clearSessionMutation, clearSessionLiveStrokes, currentUser.id, upsertViewerState, localGuestKey]);

  // Undo the last stroke
  const undoLastStroke = useCallback(async () => {
    if (!sessionId) return false;

    try {
      const result = await removeLastStroke({ sessionId, guestKey: localGuestKey || undefined });
      reportSyncSuccess();
      return result;
    } catch (e) {
      console.error('[usePaintingSession] Failed to undo stroke:', e);
      reportSyncFailure(e);
      return false;
    }
  }, [sessionId, removeLastStroke, localGuestKey]);

  // Redo the last undone stroke
  const redoLastStroke = useCallback(async () => {
    if (!sessionId) return false;

    try {
      const result = await restoreLastDeletedStroke({ sessionId, guestKey: localGuestKey || undefined });
      reportSyncSuccess();
      return result;
    } catch (e) {
      console.error('[usePaintingSession] Failed to redo stroke:', e);
      reportSyncFailure(e);
      return false;
    }
  }, [sessionId, restoreLastDeletedStroke, localGuestKey]);

  // Throttle live stroke updates to reduce lag
  const liveStrokeUpdateRef = useRef<NodeJS.Timeout | null>(null);
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
    if (!sessionId) return;
    
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
        }).catch((e) => reportSyncFailure(e));
        pendingLiveStrokeRef.current = null;
      }
      liveStrokeUpdateRef.current = null;
    }, 16); // 16ms throttle (~60 FPS)
  }, [sessionId, updateLiveStroke, currentUser, localGuestKey]);

  // Clear live stroke (when finishing drawing). Guests are keyed by their
  // stable per-browser client id instead of a user id.
  const clearLiveStrokeForUser = useCallback(async () => {
    if (!sessionId) return;

    return await clearLiveStroke({
      sessionId,
      userId: currentUser.id || undefined,
      guestId: currentUser.id ? undefined : getClientId(),
      guestKey: localGuestKey || undefined,
    });
  }, [sessionId, currentUser.id, clearLiveStroke, localGuestKey]);

  // Leave session on unmount and cleanup timeouts
  useEffect(() => {
    const currentSessionId = sessionId; // Capture sessionId for cleanup
    const currentViewerId = currentUser.id; // Capture viewerId for cleanup

    // Tab close / navigation away never runs React cleanup reliably, and
    // WebSocket mutations don't flush during pagehide — use sendBeacon to an
    // HTTP action so presence and any in-progress live stroke are removed
    // immediately instead of lingering until the staleness cutoffs.
    const handlePageHide = () => {
      if (!currentSessionId) return;
      const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
      if (!siteUrl || typeof navigator.sendBeacon !== "function") return;
      const payload = JSON.stringify({
        sessionId: currentSessionId,
        userId: currentViewerId || undefined,
        guestId: currentViewerId ? undefined : getClientId(),
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
      if (currentSessionId) {
        // Guests identify by their stable client id instead of a user id
        convexLow.mutation(api.presence.leaveSession, {
          sessionId: currentSessionId,
          userId: currentViewerId || undefined,
          guestId: currentViewerId ? undefined : getClientId(),
        });
        if (currentViewerId) {
          removeViewerState({
            sessionId: currentSessionId,
            viewerId: currentViewerId,
            guestKey: getGuestKey(currentSessionId) || undefined,
          });
        }
      }
      // Clean up any pending live stroke updates
      if (liveStrokeUpdateRef.current) {
        clearTimeout(liveStrokeUpdateRef.current);
      }
    };
  }, [sessionId, leaveSession, removeViewerState, currentUser.id]);

  // Memoized strokes with pre-sorted order and metadata for O(1) access
  const { memoizedStrokes, lastStrokeInfo } = useMemo(() => {
    if (!strokes || strokes.length === 0) {
      return { memoizedStrokes: [], lastStrokeInfo: null };
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
    strokes: memoizedStrokes,
    lastStrokeInfo,
    presence: presence || [],
    liveStrokes: liveStrokes || [],
    currentUser,
    presenceGuestId,
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
