import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useConvex } from "convex/react";
import { Id } from "../../convex/_generated/dataModel";
import { P2PManager } from '../lib/webrtc/P2PManager';
import { getGuestKey } from '../utils/guestKey';
import type { 
  PreviewPacket, 
  CursorPacket,
  P2PPacket,
  RemoteStroke, 
  ConnectionMode, 
  P2PMetrics 
} from '../lib/webrtc/types';

export interface P2PPresencePeer {
  userId?: Id<"users"> | string;
  userName: string;
  userColor: string;
}

export interface P2PPaintingOptions {
  sessionId: Id<"paintingSessions"> | null;
  userId: string;
  guestKey?: string;
  enabled?: boolean;
  presence?: ReadonlyArray<P2PPresencePeer>; // To get peer colors
  /** Edit-link key for signaling authorization (never the guest owner key). */
  editKey?: string;
  /**
   * Peer ids (user id strings) currently allowed to edit. When provided,
   * stroke and cursor packets from any other peer are ignored, so a
   * collaborator whose edit link was revoked can't keep painting into open
   * data channels. Derived from presence, which only editors can write and
   * which the server clears for collaborators on revoke/rotate.
   */
  allowedPeerIds?: ReadonlySet<string> | null;
}

/** Editor peer ids from presence rows (P2P peers are identified by user id). */
export function editorPeerIdsFromPresence(
  presence: ReadonlyArray<{ userId?: string | null }> | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const row of presence ?? []) {
    if (row.userId) ids.add(String(row.userId));
  }
  return ids;
}

/** True when a packet from `peerId` may be applied. */
export function isPacketFromEditor(
  peerId: string,
  allowedPeerIds: ReadonlySet<string> | null | undefined,
): boolean {
  return !allowedPeerIds || allowedPeerIds.has(peerId);
}

export interface P2PPaintingResult {
  isConnected: boolean;
  connectionMode: ConnectionMode;
  remoteStrokes: Map<string, RemoteStroke>;
  remoteCursors: Map<string, { x: number; y: number; drawing: boolean }>;
  sendStrokePoint: (strokeId: string, x: number, y: number, pressure: number) => void;
  sendCursorPosition: (x: number, y: number, drawing: boolean) => void;
  clearRemoteStroke: (peerId: string, strokeId: string) => void;
  metrics: P2PMetrics | null;
}

const EMPTY_PRESENCE: ReadonlyArray<P2PPresencePeer> = [];

export function useP2PPainting({
  sessionId,
  userId,
  guestKey,
  enabled = true,
  presence = EMPTY_PRESENCE,
  editKey,
  allowedPeerIds = null,
}: P2PPaintingOptions): P2PPaintingResult {
  const convex = useConvex();
  const p2pManagerRef = useRef<P2PManager | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('disconnected');
  const [remoteStrokes, setRemoteStrokes] = useState<Map<string, RemoteStroke>>(new Map());
  const [remoteCursors, setRemoteCursors] = useState<Map<string, { x: number; y: number; drawing: boolean }>>(new Map());
  const [metrics, setMetrics] = useState<P2PMetrics | null>(null);
  const metricsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedPeersRef = useRef<Set<string>>(new Set());
  const allowedPeerIdsRef = useRef(allowedPeerIds);
  allowedPeerIdsRef.current = allowedPeerIds;
  const presenceRef = useRef<ReadonlyArray<P2PPresencePeer>>(presence);

  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

  const resolvedGuestKey =
    guestKey !== undefined ? guestKey : getGuestKey(sessionId) || undefined;

  // Handle incoming packets
  const handlePacketReceived = useCallback((peerId: string, packet: P2PPacket) => {
    if (!isPacketFromEditor(peerId, allowedPeerIdsRef.current)) {
      // Not (or no longer) an editor of this session: ignore its packets.
      return;
    }
    if (packet.t === 'cu') {
      // Handle cursor packet
      setRemoteCursors(prev => {
        const newCursors = new Map(prev);
        newCursors.set(peerId, {
          x: packet.x,
          y: packet.y,
          drawing: packet.drawing,
        });
        return newCursors;
      });
      return;
    }
    
    // Handle stroke packet
    console.log('🎨 P2P: Processing remote stroke', { peerId, strokeId: packet.id });
    
    setRemoteStrokes(prev => {
      const newStrokes = new Map(prev);
      const strokeKey = `${peerId}:${packet.id}`;
      
      const existingStroke = newStrokes.get(strokeKey);
      if (existingStroke) {
        // Add point to existing stroke
        existingStroke.points.push({
          x: packet.x,
          y: packet.y,
          pressure: packet.p,
        });
        existingStroke.lastUpdate = Date.now();
        console.log('🔄 P2P: Updated stroke', strokeKey, 'points:', existingStroke.points.length);
      } else {
        // Create new stroke
        const peerInfo = presenceRef.current.find(
          p => p.userName === peerId || p.userId?.toString() === peerId
        );
        const newStroke = {
          peerId,
          strokeId: packet.id,
          points: [{
            x: packet.x,
            y: packet.y,
            pressure: packet.p,
          }],
          // Try to find peer color from latest presence snapshot
          color: peerInfo?.userColor || '#FF0000',
          size: 20, // Default brush size
          lastUpdate: Date.now(),
        };
        newStrokes.set(strokeKey, newStroke);
        console.log('✨ P2P: Created new stroke', strokeKey);
      }
      
      console.log('📋 P2P: Total remote strokes:', newStrokes.size);
      return newStrokes;
    });
  }, []);

  // Handle peer connections
  const handlePeerConnected = useCallback((peerId: string) => {
    console.log(`Peer connected: ${peerId}`);
    connectedPeersRef.current.add(peerId);
    setIsConnected(true);
  }, []);

  const handlePeerDisconnected = useCallback((peerId: string) => {
    console.log(`Peer disconnected: ${peerId}`);
    connectedPeersRef.current.delete(peerId);
    // Drop back to disconnected when the last peer leaves so the app can fall
    // back to Convex presence for cursors
    if (connectedPeersRef.current.size === 0) {
      setIsConnected(false);
    }
    // Clean up strokes and cursor from disconnected peer
    setRemoteStrokes(prev => {
      const newStrokes = new Map(prev);
      for (const [key] of newStrokes) {
        if (key.startsWith(`${peerId}:`)) {
          newStrokes.delete(key);
        }
      }
      return newStrokes;
    });
    setRemoteCursors(prev => {
      if (!prev.has(peerId)) return prev;
      const newCursors = new Map(prev);
      newCursors.delete(peerId);
      return newCursors;
    });
  }, []);

  // Initialize P2P manager
  useEffect(() => {
    console.log('🔍 P2P Hook - Enabled:', enabled, 'SessionId:', sessionId, 'UserId:', userId);
    
    if (!enabled || !sessionId || !userId) {
      console.log('⚠️ P2P Hook - Skipping initialization:', {
        enabled,
        hasSession: !!sessionId,
        hasUserId: !!userId
      });
      return;
    }

    let cancelled = false;
    const connectedPeers = connectedPeersRef.current;
    const manager = new P2PManager({
      sessionId,
      peerId: userId,
      guestKey: resolvedGuestKey,
      editKey,
      convexClient: convex,
      onPacketReceived: handlePacketReceived,
      onPeerConnected: handlePeerConnected,
      onPeerDisconnected: handlePeerDisconnected,
      onModeChanged: (mode) => {
        if (!cancelled) {
          setConnectionMode(mode);
        }
      },
    });

    p2pManagerRef.current = manager;

    // Initialize connection
    manager.init().catch(error => {
      if (cancelled) return;
      console.error('Failed to initialize P2P:', error);
      // No fallback - P2P is required
      setIsConnected(false);
    });

    // Start metrics collection
    metricsIntervalRef.current = setInterval(() => {
      if (p2pManagerRef.current) {
        setMetrics(p2pManagerRef.current.getMetrics());
      }
    }, 1000);

    // Cleanup
    return () => {
      cancelled = true;
      if (metricsIntervalRef.current) {
        clearInterval(metricsIntervalRef.current);
        metricsIntervalRef.current = null;
      }
      void manager.destroy();
      p2pManagerRef.current = null;
      connectedPeers.clear();
      setIsConnected(false);
      setConnectionMode('disconnected');
      setMetrics(null);
      setRemoteStrokes(new Map());
      setRemoteCursors(new Map());
    };
  }, [enabled, sessionId, userId, resolvedGuestKey, editKey, convex, handlePacketReceived, handlePeerConnected, handlePeerDisconnected]);

  // Clean up old remote strokes (older than 5 seconds) only while P2P is active
  useEffect(() => {
    if (!enabled || !sessionId || !userId) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setRemoteStrokes(prev => {
        if (prev.size === 0) return prev;
        const newStrokes = new Map(prev);
        let changed = false;
        
        for (const [key, stroke] of newStrokes) {
          if (now - stroke.lastUpdate > 5000) {
            newStrokes.delete(key);
            changed = true;
          }
        }
        
        return changed ? newStrokes : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [enabled, sessionId, userId]);

  // Send stroke point
  const sendStrokePoint = useCallback((
    strokeId: string,
    x: number,
    y: number,
    pressure: number
  ) => {
    if (!p2pManagerRef.current || connectedPeersRef.current.size === 0) {
      return;
    }

    const packet: PreviewPacket = {
      t: 'pt',
      id: strokeId.substring(0, 8), // Take first 8 chars
      x,
      y,
      p: pressure,
    };

    p2pManagerRef.current.sendPacket(packet);
  }, []);

  // Send cursor position
  const sendCursorPosition = useCallback((
    x: number,
    y: number,
    drawing: boolean
  ) => {
    if (!p2pManagerRef.current || connectedPeersRef.current.size === 0) {
      return;
    }

    const packet: CursorPacket = {
      t: 'cu',
      x,
      y,
      drawing,
    };

    p2pManagerRef.current.sendCursorPacket(packet);
  }, []);

  // Clear a remote stroke (useful when stroke is completed)
  const clearRemoteStroke = useCallback((peerId: string, strokeId: string) => {
    setRemoteStrokes(prev => {
      const key = `${peerId}:${strokeId}`;
      if (!prev.has(key)) return prev;
      const newStrokes = new Map(prev);
      newStrokes.delete(key);
      return newStrokes;
    });
  }, []);

  return useMemo(() => ({
    isConnected,
    connectionMode,
    remoteStrokes,
    remoteCursors,
    sendStrokePoint,
    sendCursorPosition,
    clearRemoteStroke,
    metrics,
  }), [
    isConnected,
    connectionMode,
    remoteStrokes,
    remoteCursors,
    sendStrokePoint,
    sendCursorPosition,
    clearRemoteStroke,
    metrics,
  ]);
}