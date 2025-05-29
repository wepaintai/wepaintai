import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useCallback, useEffect, useState } from "react";

export interface PaintPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface Stroke {
  _id: Id<"strokes">;
  _creationTime: number;
  sessionId: Id<"paintingSessions">;
  userId?: Id<"users">;
  userColor: string;
  points: PaintPoint[];
  brushColor: string;
  brushSize: number;
  opacity: number;
  strokeOrder: number;
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

export function usePaintingSession(sessionId: Id<"paintingSessions"> | null) {
  const [currentUser] = useState(() => ({
    id: crypto.randomUUID(),
    name: `User ${Math.floor(Math.random() * 1000)}`,
    color: `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`,
  }));

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

  // Mutations
  const createSession = useMutation(api.paintingSessions.createSession);
  const addStroke = useMutation(api.strokes.addStroke);
  const updatePresence = useMutation(api.presence.updatePresence);
  const leaveSession = useMutation(api.presence.leaveSession);

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
    opacity: number = 1
  ) => {
    if (!sessionId) return;
    
    return await addStroke({
      sessionId,
      userColor: currentUser.color,
      points,
      brushColor,
      brushSize,
      opacity,
    });
  }, [sessionId, addStroke, currentUser.color]);

  // Update user presence
  const updateUserPresence = useCallback(async (
    cursorX: number,
    cursorY: number,
    isDrawing: boolean,
    currentTool: string
  ) => {
    if (!sessionId) return;
    
    return await updatePresence({
      sessionId,
      userColor: currentUser.color,
      userName: currentUser.name,
      cursorX,
      cursorY,
      isDrawing,
      currentTool,
    });
  }, [sessionId, updatePresence, currentUser]);

  // Leave session on unmount
  useEffect(() => {
    return () => {
      if (sessionId) {
        leaveSession({ sessionId });
      }
    };
  }, [sessionId, leaveSession]);

  return {
    // Data
    session,
    strokes: strokes || [],
    presence: presence || [],
    currentUser,
    
    // Actions
    createNewSession,
    addStrokeToSession,
    updateUserPresence,
    
    // State
    isLoading: session === undefined,
  };
}
