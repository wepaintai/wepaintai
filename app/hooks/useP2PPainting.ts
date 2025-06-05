import { useEffect, useRef, useState, useCallback } from 'react';
import { useConvex } from "convex/react";
import { Id } from "../../convex/_generated/dataModel";
import { P2PManager } from '../lib/webrtc/P2PManager';
import type { 
  PreviewPacket, 
  CursorPacket,
  P2PPacket,
  RemoteStroke, 
  ConnectionMode, 
  P2PMetrics 
} from '../lib/webrtc/types';

export interface P2PPaintingOptions {
  sessionId: Id<"paintingSessions"> | null;
  userId: string;
  enabled?: boolean;
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

export function useP2PPainting({
  sessionId,
  userId,
  enabled = true,
}: P2PPaintingOptions): P2PPaintingResult {
  const convex = useConvex();
  const p2pManagerRef = useRef<P2PManager | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('fallback');
  const [remoteStrokes, setRemoteStrokes] = useState<Map<string, RemoteStroke>>(new Map());
  const [remoteCursors, setRemoteCursors] = useState<Map<string, { x: number; y: number; drawing: boolean }>>(new Map());
  const [metrics, setMetrics] = useState<P2PMetrics | null>(null);
  const metricsIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Handle incoming packets
  const handlePacketReceived = useCallback((peerId: string, packet: P2PPacket) => {
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
        const newStroke = {
          peerId,
          strokeId: packet.id,
          points: [{
            x: packet.x,
            y: packet.y,
            pressure: packet.p,
          }],
          color: '#FF0000', // Red for remote strokes (temporary)
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
    setIsConnected(true);
  }, []);

  const handlePeerDisconnected = useCallback((peerId: string) => {
    console.log(`Peer disconnected: ${peerId}`);
    // Clean up strokes from disconnected peer
    setRemoteStrokes(prev => {
      const newStrokes = new Map(prev);
      for (const [key] of newStrokes) {
        if (key.startsWith(`${peerId}:`)) {
          newStrokes.delete(key);
        }
      }
      return newStrokes;
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

    const roomKey = `session-${sessionId}`; // Simple room key for now

    const manager = new P2PManager({
      sessionId,
      peerId: userId,
      roomKey,
      convexClient: convex,
      onPacketReceived: handlePacketReceived,
      onPeerConnected: handlePeerConnected,
      onPeerDisconnected: handlePeerDisconnected,
      onModeChanged: setConnectionMode,
    });

    p2pManagerRef.current = manager;

    // Initialize connection
    manager.init().catch(error => {
      console.error('Failed to initialize P2P:', error);
      setConnectionMode('fallback');
    });

    // Start metrics collection
    metricsIntervalRef.current = setInterval(() => {
      if (p2pManagerRef.current) {
        setMetrics(p2pManagerRef.current.getMetrics());
      }
    }, 1000);

    // Cleanup
    return () => {
      if (metricsIntervalRef.current) {
        clearInterval(metricsIntervalRef.current);
      }
      manager.destroy();
      p2pManagerRef.current = null;
      setIsConnected(false);
      setRemoteStrokes(new Map());
      setRemoteCursors(new Map());
    };
  }, [enabled, sessionId, userId, convex, handlePacketReceived, handlePeerConnected, handlePeerDisconnected]);

  // Clean up old remote strokes (older than 5 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setRemoteStrokes(prev => {
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
  }, []);

  // Send stroke point
  const sendStrokePoint = useCallback((
    strokeId: string,
    x: number,
    y: number,
    pressure: number
  ) => {
    if (!p2pManagerRef.current || !isConnected) {
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
  }, [isConnected]);

  // Send cursor position
  const sendCursorPosition = useCallback((
    x: number,
    y: number,
    drawing: boolean
  ) => {
    if (!p2pManagerRef.current || !isConnected) {
      return;
    }

    const packet: CursorPacket = {
      t: 'cu',
      x,
      y,
      drawing,
    };

    p2pManagerRef.current.sendCursorPacket(packet);
  }, [isConnected]);

  // Clear a remote stroke (useful when stroke is completed)
  const clearRemoteStroke = useCallback((peerId: string, strokeId: string) => {
    setRemoteStrokes(prev => {
      const newStrokes = new Map(prev);
      newStrokes.delete(`${peerId}:${strokeId}`);
      return newStrokes;
    });
  }, []);

  return {
    isConnected,
    connectionMode,
    remoteStrokes,
    remoteCursors,
    sendStrokePoint,
    sendCursorPosition,
    clearRemoteStroke,
    metrics,
  };
}