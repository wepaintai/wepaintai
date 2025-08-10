import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { p2pLogger } from "../lib/p2p-logger";
import { convexLow } from "../lib/convex";

export interface PaintPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface Stroke {
  _id: Id<"strokes">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  layerId?: Id<"paintLayers">;
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

  // Queries
  const session = useQuery(
    api.paintingSessions.getSession,
    sessionId ? { sessionId } : "skip"
  );
  
  const strokes = useQuery(
    api.strokes.getSessionStrokes,
    sessionId ? { sessionId } : "skip"
  );
  
  const presence = useQuery(
    api.presence.getSessionPresence,
    sessionId ? { sessionId } : "skip"
  );
  
  const liveStrokes = useQuery(
    api.liveStrokes.getLiveStrokes,
    sessionId ? { sessionId } : "skip"
  );
  
  const undoRedoAvailability = useQuery(
    api.strokes.getUndoRedoAvailability,
    sessionId ? { sessionId } : "skip"
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
  
  // For viewer state, use user ID if authenticated, otherwise use name as viewer ID
  const viewerId = currentUser.id || currentUser.name;
  const getViewerState = useQuery(api.viewerAcks.getViewerState, 
    sessionId && viewerId ? { sessionId, viewerId } : "skip"
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
        });
      }
    }
  }, [strokes, sessionId, currentUser.id, upsertViewerState]);

  // Create a new session
  const createNewSession = useCallback(async (
    name?: string,
    canvasWidth: number = 800,
    canvasHeight: number = 600
  ) => {
    return await createSession({
      name,
      canvasWidth,
      canvasHeight,
      isPublic: true,
    });
  }, [createSession]);

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
    
    const strokeId = await addStroke({
      sessionId,
      layerId: layerId ? layerId as Id<"paintLayers"> : undefined,
      userId: currentUser.id || undefined,  // Allow undefined for guest users
      userColor: currentUser.color,
      points,
      brushColor,
      brushSize,
      opacity,
      isEraser,
      colorMode,
    });
    
    return strokeId;
  }, [sessionId, addStroke, currentUser]);

  // Presence throttling and heartbeat
  const presenceIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastPresenceSentAtRef = useRef<number>(0);
  const pendingPresenceRef = useRef<{
    cursorX: number;
    cursorY: number;
    isDrawing: boolean;
    currentTool: string;
  } | null>(null);

  // Send coarse presence heartbeat every 20s using low-priority client
  useEffect(() => {
    if (!sessionId) return;

    if (presenceIntervalRef.current) {
      clearInterval(presenceIntervalRef.current);
      presenceIntervalRef.current = null;
    }

    presenceIntervalRef.current = setInterval(async () => {
      try {
        const payload =
          pendingPresenceRef.current || {
            cursorX: 0,
            cursorY: 0,
            isDrawing: false,
            currentTool: "brush",
          };

        await convexLow.mutation(api.presence.updatePresence, {
          sessionId,
          userId: currentUser.id || undefined,
          userColor: currentUser.color,
          userName: currentUser.name,
          ...payload,
        });
        lastPresenceSentAtRef.current = Date.now();
        pendingPresenceRef.current = null;
      } catch (e) {
        // ignore heartbeat errors
      }
    }, 20000); // 20s

    return () => {
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
        presenceIntervalRef.current = null;
      }
    };
  }, [sessionId, currentUser.id, currentUser.color, currentUser.name]);

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
      if (now - lastPresenceSentAtRef.current > 20000) {
        try {
          await convexLow.mutation(api.presence.updatePresence, {
            sessionId,
            userId: currentUser.id || undefined,
            userColor: currentUser.color,
            userName: currentUser.name,
            cursorX,
            cursorY,
            isDrawing,
            currentTool,
          });
          lastPresenceSentAtRef.current = now;
          pendingPresenceRef.current = null;
        } catch (e) {
          // ignore
        }
      }
    },
    [sessionId, currentUser.id, currentUser.color, currentUser.name]
  );

  // Clear all strokes from the session
  const clearSession = useCallback(async () => {
    if (!sessionId) return;
    
    // Clear both completed strokes and live strokes
    await Promise.all([
      clearSessionMutation({ sessionId }),
      clearSessionLiveStrokes({ sessionId })
    ]);
    
    // Reset local acknowledgment state
    localLastAckedStrokeOrderRef.current = 0;
    
    // Update viewer state to reflect cleared session
    if (currentUser.id) {
      await upsertViewerState({
        sessionId,
        viewerId: currentUser.id,
        lastAckedStrokeOrder: 0,
      });
    }
  }, [sessionId, clearSessionMutation, clearSessionLiveStrokes, currentUser.id, upsertViewerState]);

  // Undo the last stroke
  const undoLastStroke = useCallback(async () => {
    if (!sessionId) return false;
    
    return await removeLastStroke({ sessionId });
  }, [sessionId, removeLastStroke]);

  // Redo the last undone stroke
  const redoLastStroke = useCallback(async () => {
    if (!sessionId) return false;
    
    return await restoreLastDeletedStroke({ sessionId });
  }, [sessionId, restoreLastDeletedStroke]);

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
        userColor: currentUser.color,
        userName: currentUser.name,
        points,
        brushColor,
        brushSize,
        opacity,
        colorMode,
      });
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
          userColor: currentUser.color,
          userName: currentUser.name,
          points: pending.points,
          brushColor: pending.brushColor,
          brushSize: pending.brushSize,
          opacity: pending.opacity,
          colorMode: pending.colorMode,
        });
        pendingLiveStrokeRef.current = null;
      }
      liveStrokeUpdateRef.current = null;
    }, 16); // 16ms throttle (~60 FPS)
  }, [sessionId, updateLiveStroke, currentUser]);

  // Clear live stroke (when finishing drawing)
  const clearLiveStrokeForUser = useCallback(async () => {
    if (!sessionId) return;
    
    // Only clear if user has an ID (guest users don't have live strokes)
    if (currentUser.id) {
      return await clearLiveStroke({
        sessionId,
        userId: currentUser.id,
      });
    }
  }, [sessionId, currentUser.id, clearLiveStroke]);

  // Leave session on unmount and cleanup timeouts
  useEffect(() => {
    const currentSessionId = sessionId; // Capture sessionId for cleanup
    const currentViewerId = currentUser.id; // Capture viewerId for cleanup
    const currentUserName = currentUser.name; // Capture userName for cleanup
    return () => {
      if (currentSessionId && currentViewerId) {
        convexLow.mutation(api.presence.leaveSession, { sessionId: currentSessionId, userId: currentViewerId });
        removeViewerState({ sessionId: currentSessionId, viewerId: currentViewerId });
      }
      // Clean up any pending live stroke updates
      if (liveStrokeUpdateRef.current) {
        clearTimeout(liveStrokeUpdateRef.current);
      }
    };
  }, [sessionId, leaveSession, removeViewerState, currentUser.id, currentUser.name]);

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
    strokes: memoizedStrokes,
    lastStrokeInfo,
    presence: presence || [],
    liveStrokes: liveStrokes || [],
    currentUser,
    undoRedoAvailability,
    
    // Actions
    createNewSession,
    addStrokeToSession,
    updateUserPresence,
    clearSession,
    undoLastStroke,
    redoLastStroke,
    updateLiveStrokeForUser,
    clearLiveStrokeForUser,
    
    // State
    isLoading: sessionId !== null && (session === undefined || authenticatedUser === undefined),
  };
}
