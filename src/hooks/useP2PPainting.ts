import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useConvex } from "convex/react";
import { Id } from "../../convex/_generated/dataModel";
import { P2PManager } from '../lib/webrtc/P2PManager';
import { getGuestKey } from '../utils/guestKey';
import {
  createP2PLiveStore,
  resetP2PLiveStore,
  type P2PLiveStore,
} from '../lib/webrtc/p2pLiveStore';
import type {
  PreviewPacket,
  CursorPacket,
  P2PPacket,
  RemoteStroke,
  ConnectionMode,
  P2PMetrics,
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
  /**
   * Remote cursors, remote live strokes and metrics. Not React state: read it
   * with useRemoteCursors / useRemoteStrokes / useP2PMetrics in the component
   * that draws it, so incoming packets don't re-render the editor host.
   * Stable for the lifetime of the hook.
   */
  liveStore: P2PLiveStore;
  sendStrokePoint: (strokeId: string, x: number, y: number, pressure: number) => void;
  sendCursorPosition: (x: number, y: number, drawing: boolean) => void;
  clearRemoteStroke: (peerId: string, strokeId: string) => void;
}

const EMPTY_PRESENCE: ReadonlyArray<P2PPresencePeer> = [];

function sameMetrics(a: P2PMetrics | null, b: P2PMetrics): boolean {
  return (
    !!a &&
    a.latency === b.latency &&
    a.packetsSent === b.packetsSent &&
    a.packetsReceived === b.packetsReceived &&
    a.bytesTransferred === b.bytesTransferred &&
    a.connectedPeers === b.connectedPeers
  );
}

/** Apply one incoming packet to the live store (pure w.r.t. React). */
export function applyP2PPacket(
  store: P2PLiveStore,
  peerId: string,
  packet: P2PPacket,
  presence: ReadonlyArray<P2PPresencePeer>,
  now: number = Date.now(),
): void {
  if (packet.t === 'cu') {
    store.cursors.set((prev) => {
      const current = prev.get(peerId);
      if (
        current &&
        current.x === packet.x &&
        current.y === packet.y &&
        current.drawing === packet.drawing
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(peerId, { x: packet.x, y: packet.y, drawing: packet.drawing });
      return next;
    });
    return;
  }

  const strokeKey = `${peerId}:${packet.id}`;
  const point = { x: packet.x, y: packet.y, pressure: packet.p };
  store.strokes.set((prev) => {
    const next = new Map(prev);
    const existing = prev.get(strokeKey);
    if (existing) {
      next.set(strokeKey, {
        ...existing,
        points: [...existing.points, point],
        lastUpdate: now,
      });
    } else {
      const peerInfo = presence.find(
        (p) => p.userName === peerId || p.userId?.toString() === peerId
      );
      const stroke: RemoteStroke = {
        peerId,
        strokeId: packet.id,
        points: [point],
        // Peer color from the latest presence snapshot
        color: peerInfo?.userColor || '#FF0000',
        size: 20, // Default brush size
        lastUpdate: now,
      };
      next.set(strokeKey, stroke);
    }
    return next;
  });
}

function removePeerFromStore(store: P2PLiveStore, peerId: string): void {
  store.strokes.set((prev) => {
    let next: Map<string, RemoteStroke> | null = null;
    for (const key of prev.keys()) {
      if (key.startsWith(`${peerId}:`)) {
        next ??= new Map(prev);
        next.delete(key);
      }
    }
    return next ?? prev;
  });
  store.cursors.set((prev) => {
    if (!prev.has(peerId)) return prev;
    const next = new Map(prev);
    next.delete(peerId);
    return next;
  });
}

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
  const [liveStore] = useState(createP2PLiveStore);
  // Peers connected to the *current* manager. Each manager gets its own set;
  // a destroyed manager can never touch the live one's.
  const connectedPeersRef = useRef<Set<string>>(new Set());
  const allowedPeerIdsRef = useRef(allowedPeerIds);
  allowedPeerIdsRef.current = allowedPeerIds;
  const presenceRef = useRef<ReadonlyArray<P2PPresencePeer>>(presence);

  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

  const resolvedGuestKey =
    guestKey !== undefined ? guestKey : getGuestKey(sessionId) || undefined;

  // Initialize P2P manager
  useEffect(() => {
    if (!enabled || !sessionId || !userId) {
      return;
    }

    const connectedPeers = new Set<string>();
    connectedPeersRef.current = connectedPeers;
    let manager: P2PManager | null = null;
    // Callbacks are bound to this manager: once it is replaced or destroyed,
    // late events (e.g. a data channel's onclose firing after destroy) are
    // ignored instead of mutating the live manager's peers or the store.
    const isCurrent = () => manager !== null && p2pManagerRef.current === manager;

    manager = new P2PManager({
      sessionId,
      peerId: userId,
      guestKey: resolvedGuestKey,
      editKey,
      convexClient: convex,
      onPacketReceived: (peerId, packet) => {
        if (!isCurrent()) return;
        if (!isPacketFromEditor(peerId, allowedPeerIdsRef.current)) {
          // Not (or no longer) an editor of this session: ignore its packets.
          return;
        }
        applyP2PPacket(liveStore, peerId, packet, presenceRef.current);
      },
      onPeerConnected: (peerId) => {
        if (!isCurrent()) return;
        connectedPeers.add(peerId);
        setIsConnected(true);
      },
      onPeerDisconnected: (peerId) => {
        if (!isCurrent()) return;
        connectedPeers.delete(peerId);
        // Drop back to disconnected when the last peer leaves so the app can
        // fall back to Convex presence for cursors
        if (connectedPeers.size === 0) {
          setIsConnected(false);
        }
        removePeerFromStore(liveStore, peerId);
      },
      onModeChanged: (mode) => {
        if (isCurrent()) {
          setConnectionMode(mode);
        }
      },
    });
    const current = manager;
    p2pManagerRef.current = current;

    current.init().catch(error => {
      if (!isCurrent()) return;
      console.error('Failed to initialize P2P:', error);
      // No fallback - P2P is required
      setIsConnected(false);
    });

    // Metrics go to the live store (only components showing them re-render),
    // and only when something actually changed.
    const metricsInterval = setInterval(() => {
      if (!isCurrent()) return;
      const next = current.getMetrics();
      liveStore.metrics.set((prev) => (sameMetrics(prev, next) ? prev : next));
    }, 1000);

    // Expire remote strokes that stopped updating (older than 5 seconds)
    const sweepInterval = setInterval(() => {
      const now = Date.now();
      liveStore.strokes.set((prev) => {
        let next: Map<string, RemoteStroke> | null = null;
        for (const [key, stroke] of prev) {
          if (now - stroke.lastUpdate > 5000) {
            next ??= new Map(prev);
            next.delete(key);
          }
        }
        return next ?? prev;
      });
    }, 1000);

    return () => {
      clearInterval(metricsInterval);
      clearInterval(sweepInterval);
      if (p2pManagerRef.current === current) {
        p2pManagerRef.current = null;
      }
      void current.destroy();
      connectedPeers.clear();
      setIsConnected(false);
      setConnectionMode('disconnected');
      resetP2PLiveStore(liveStore);
    };
  }, [enabled, sessionId, userId, resolvedGuestKey, editKey, convex, liveStore]);

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

  // Send cursor position (throttled to ~30 Hz with a trailing send inside
  // P2PManager.sendCursorPacket)
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
    const key = `${peerId}:${strokeId}`;
    liveStore.strokes.set((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, [liveStore]);

  return useMemo(() => ({
    isConnected,
    connectionMode,
    liveStore,
    sendStrokePoint,
    sendCursorPosition,
    clearRemoteStroke,
  }), [
    isConnected,
    connectionMode,
    liveStore,
    sendStrokePoint,
    sendCursorPosition,
    clearRemoteStroke,
  ]);
}
