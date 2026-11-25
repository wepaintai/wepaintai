import type { ConvexReactClient } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { 
  P2PConfig, 
  PeerConnection, 
  ConnectionMode, 
  P2PMetrics,
  PreviewPacket,
  CursorPacket,
  P2PPacket 
} from './types';
import { loadConfig } from './config';
import { encodePreviewPacket, decodeP2PPacket, encodeCursorPacket } from './encoding';
import { p2pLogger } from '../p2p-logger';

export interface P2PManagerOptions {
  sessionId: Id<"paintingSessions">;
  peerId: string;
  guestKey?: string; // Session guest-owner key for authorization on private sessions
  editKey?: string; // Collaboration edit-link key (separate secret from the guest owner key)
  convexClient: ConvexReactClient;
  onPacketReceived?: (peerId: string, packet: P2PPacket) => void;
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onModeChanged?: (mode: ConnectionMode) => void;
  /**
   * Minimum interval between outgoing cursor packets (default ~30 Hz). Extra
   * cursor moves inside the window are coalesced into one trailing send that
   * carries the latest position and drawing flag.
   */
  cursorSendIntervalMs?: number;
}

export const DEFAULT_CURSOR_SEND_INTERVAL_MS = 33;

export class P2PManager {
  private config: P2PConfig;
  private peers: Map<string, PeerConnection> = new Map();
  private mode: ConnectionMode = 'mesh';
  private convexClient: ConvexReactClient;
  private sessionId: Id<"paintingSessions">;
  private peerId: string;
  private guestKey?: string;
  private editKey?: string;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private cursorSendIntervalMs: number;
  private lastCursorSentAt = Number.NEGATIVE_INFINITY;
  private pendingCursorPacket: CursorPacket | null = null;
  private cursorFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private metrics: P2PMetrics = {
    latency: 0,
    packetsSent: 0,
    packetsReceived: 0,
    bytesTransferred: 0,
    connectedPeers: 0,
  };
  
  // Callbacks
  private onPacketReceived?: (peerId: string, packet: P2PPacket) => void;
  private onPeerConnected?: (peerId: string) => void;
  private onPeerDisconnected?: (peerId: string) => void;
  private onModeChanged?: (mode: ConnectionMode) => void;

  constructor(options: P2PManagerOptions) {
    this.config = loadConfig();
    this.convexClient = options.convexClient;
    this.sessionId = options.sessionId;
    this.peerId = options.peerId;
    this.guestKey = options.guestKey;
    this.editKey = options.editKey;
    this.onPacketReceived = options.onPacketReceived;
    this.onPeerConnected = options.onPeerConnected;
    this.onPeerDisconnected = options.onPeerDisconnected;
    this.onModeChanged = options.onModeChanged;
    this.cursorSendIntervalMs = options.cursorSendIntervalMs ?? DEFAULT_CURSOR_SEND_INTERVAL_MS;
    
    console.log('P2PManager created with peerId:', this.peerId);
  }

  /**
   * Initialize P2P connections
   */
  async init(): Promise<void> {
    try {
      console.log('🚀 P2P: Initializing...', { sessionId: this.sessionId, peerId: this.peerId });
      
      // Join P2P session and get list of peers
      const { peers, mode } = await this.convexClient.mutation(
        api.webrtc.joinP2PSession,
        {
          sessionId: this.sessionId,
          peerId: this.peerId,
          guestKey: this.guestKey,
          editKey: this.editKey,
        }
      );

      console.log('🔍 P2P: Found peers:', peers.length, 'Mode:', mode);
      if (this.destroyed) {
        return;
      }
      this.mode = mode;
      this.onModeChanged?.(mode);

      // Connect to each peer
      for (const peerId of peers) {
        if (this.destroyed) {
          return;
        }
        console.log('🤝 P2P: Connecting to peer:', peerId);
        await this.connectToPeer(peerId);
      }

      if (this.destroyed) {
        return;
      }

      // Start polling for signaling messages
      this.startSignalPolling();
      console.log('✅ P2P: Initialization complete');
    } catch (error) {
      console.error('❌ P2P: Failed to initialize:', error);
      // No fallback - P2P is required
      throw error;
    }
  }

  /**
   * Connect to a specific peer
   */
  private async connectToPeer(targetPeerId: string): Promise<void> {
    if (this.peers.has(targetPeerId)) {
      return; // Already connected
    }

    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
    });

    const peerConn: PeerConnection = {
      peerId: targetPeerId,
      connection: pc,
      dataChannel: null,
      isConnected: false,
    };

    this.peers.set(targetPeerId, peerConn);

    // Set up ICE candidate handling
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        // Serialize ICE candidate to plain object for Convex
        await this.sendSignal(targetPeerId, 'ice-candidate', {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        });
      }
    };

    // Create data channel
    const dataChannel = pc.createDataChannel('paint-preview', this.config.dataChannelOptions);
    this.setupDataChannel(dataChannel, peerConn);

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Serialize offer for Convex
    await this.sendSignal(targetPeerId, 'offer', {
      type: offer.type,
      sdp: offer.sdp,
    });
  }

  /**
   * Set up data channel event handlers
   */
  private setupDataChannel(channel: RTCDataChannel, peerConn: PeerConnection): void {
    peerConn.dataChannel = channel;

    // A destroyed manager must never report peers or packets: its channels
    // close asynchronously after destroy(), and a late onclose would otherwise
    // reach the owner's callbacks (and e.g. drop a peer a newer manager has).
    channel.onopen = () => {
      if (this.destroyed) return;
      console.log('✅ P2P: Data channel opened with peer:', peerConn.peerId);
      peerConn.isConnected = true;
      this.metrics.connectedPeers++;
      this.onPeerConnected?.(peerConn.peerId);
      p2pLogger.logP2P('peerConnected', { peerId: peerConn.peerId });
    };

    channel.onclose = () => {
      if (this.destroyed) return;
      peerConn.isConnected = false;
      this.metrics.connectedPeers--;
      this.onPeerDisconnected?.(peerConn.peerId);
    };

    channel.onmessage = (event) => {
      if (this.destroyed) return;
      this.handleDataChannelMessage(peerConn.peerId, event.data);
    };

    channel.onerror = (error) => {
      console.error(`Data channel error with peer ${peerConn.peerId}:`, error);
    };
  }

  /**
   * Handle incoming data channel messages
   */
  private handleDataChannelMessage(peerId: string, data: any): void {
    if (data instanceof ArrayBuffer) {
      const packet = decodeP2PPacket(data);
      if (packet) {
        this.metrics.packetsReceived++;
        this.metrics.bytesTransferred += data.byteLength;
        
        if (packet.t === 'pt') {
          console.log('📥 P2P: Received stroke packet', { 
            from: peerId, 
            strokeId: packet.id,
            x: packet.x,
            y: packet.y,
            pressure: packet.p
          });
          p2pLogger.logP2P('receivePacket', { from: peerId, strokeId: packet.id });
        } else if (packet.t === 'cu') {
          // Don't log cursor packets (too frequent)
        }
        
        this.onPacketReceived?.(peerId, packet);
      } else {
        console.error('❌ P2P: Failed to decode packet from', peerId);
      }
    }
  }

  /**
   * Send a signal through Convex
   */
  private async sendSignal(
    toPeerId: string,
    type: 'offer' | 'answer' | 'ice-candidate',
    data: any
  ): Promise<void> {
    await this.convexClient.mutation(api.webrtc.sendSignal, {
      sessionId: this.sessionId,
      fromPeerId: this.peerId,
      toPeerId,
      type,
      data,
      guestKey: this.guestKey,
      editKey: this.editKey,
    });
  }

  /**
   * Start polling for signaling messages
   */
  private startSignalPolling(): void {
    if (this.destroyed || this.pollingInterval) {
      return;
    }
    this.pollingInterval = setInterval(async () => {
      if (this.destroyed) {
        return;
      }
      try {
        const signals = await this.convexClient.query(api.webrtc.getSignals, {
          sessionId: this.sessionId,
          peerId: this.peerId,
          guestKey: this.guestKey,
          editKey: this.editKey,
        });

        if (this.destroyed) {
          return;
        }

        if (signals.length > 0) {
          // Process signals
          console.log(`📨 P2P: Received ${signals.length} signals`);
          for (const signal of signals) {
            if (this.destroyed) {
              return;
            }
            await this.handleSignal(signal);
          }
          
          // Delete processed signals
          const signalIds = signals.map(s => s.id);
          await this.convexClient.mutation(api.webrtc.deleteSignals, {
            signalIds,
            sessionId: this.sessionId,
            peerId: this.peerId,
            guestKey: this.guestKey,
            editKey: this.editKey,
          });
        }
      } catch (error) {
        console.error('Signal polling error:', error);
      }
    }, 1000); // Poll every second
  }

  /**
   * Handle incoming signaling messages
   */
  private async handleSignal(signal: {
    id: any;
    fromPeerId: string;
    type: 'offer' | 'answer' | 'ice-candidate';
    data: any;
  }): Promise<void> {
    let peerConn = this.peers.get(signal.fromPeerId);

    if (signal.type === 'offer') {
      // Create new peer connection for incoming offer
      if (!peerConn) {
        const pc = new RTCPeerConnection({
          iceServers: this.config.iceServers,
        });

        peerConn = {
          peerId: signal.fromPeerId,
          connection: pc,
          dataChannel: null,
          isConnected: false,
        };

        this.peers.set(signal.fromPeerId, peerConn);

        // Set up ICE candidate handling
        pc.onicecandidate = async (event) => {
          if (event.candidate) {
            // Serialize ICE candidate to plain object for Convex
            await this.sendSignal(signal.fromPeerId, 'ice-candidate', {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            });
          }
        };

        // Set up data channel for incoming connection
        pc.ondatachannel = (event) => {
          this.setupDataChannel(event.channel, peerConn!);
        };
      }

      // Set remote description and create answer
      await peerConn.connection.setRemoteDescription(new RTCSessionDescription(signal.data));
      const answer = await peerConn.connection.createAnswer();
      await peerConn.connection.setLocalDescription(answer);
      // Serialize answer for Convex
      await this.sendSignal(signal.fromPeerId, 'answer', {
        type: answer.type,
        sdp: answer.sdp,
      });
    } else if (signal.type === 'answer' && peerConn) {
      await peerConn.connection.setRemoteDescription(new RTCSessionDescription(signal.data));
    } else if (signal.type === 'ice-candidate' && peerConn) {
      // Reconstruct RTCIceCandidate from plain object
      const candidate = new RTCIceCandidate(signal.data);
      await peerConn.connection.addIceCandidate(candidate);
    }
  }

  /**
   * Send a preview packet to all connected peers
   */
  sendPacket(packet: PreviewPacket): void {
    const data = encodePreviewPacket(packet);
    
    let sentCount = 0;
    for (const peer of this.peers.values()) {
      if (peer.isConnected && peer.dataChannel?.readyState === 'open') {
        try {
          peer.dataChannel.send(data);
          this.metrics.packetsSent++;
          this.metrics.bytesTransferred += data.byteLength;
          sentCount++;
        } catch (error) {
          console.error(`Failed to send packet to peer ${peer.peerId}:`, error);
        }
      }
    }
    
    if (sentCount > 0) {
      p2pLogger.logP2P('sendPacket', { strokeId: packet.id, peers: sentCount });
    }
  }

  /**
   * Send a cursor packet to all connected peers
   */
  sendCursorPacket(packet: CursorPacket): void {
    if (this.destroyed) return;
    const now = Date.now();
    const elapsed = now - this.lastCursorSentAt;
    if (elapsed >= this.cursorSendIntervalMs && !this.cursorFlushTimer) {
      this.lastCursorSentAt = now;
      this.writeCursorPacket(packet);
      return;
    }
    // Inside the throttle window: keep only the latest packet and send it on
    // the trailing edge so the final position (and drawing flag) always lands.
    this.pendingCursorPacket = packet;
    if (!this.cursorFlushTimer) {
      this.cursorFlushTimer = setTimeout(() => {
        this.cursorFlushTimer = null;
        const pending = this.pendingCursorPacket;
        this.pendingCursorPacket = null;
        if (!pending || this.destroyed) return;
        this.lastCursorSentAt = Date.now();
        this.writeCursorPacket(pending);
      }, Math.max(0, this.cursorSendIntervalMs - elapsed));
    }
  }

  private writeCursorPacket(packet: CursorPacket): void {
    const data = encodeCursorPacket(packet);
    
    for (const peer of this.peers.values()) {
      if (peer.isConnected && peer.dataChannel?.readyState === 'open') {
        try {
          peer.dataChannel.send(data);
          // Don't count cursor packets in metrics (too frequent)
        } catch (error) {
          // Ignore cursor send errors
        }
      }
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): P2PMetrics {
    return { ...this.metrics };
  }

  /**
   * Clean up and disconnect
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    // Drop any trailing cursor send
    if (this.cursorFlushTimer) {
      clearTimeout(this.cursorFlushTimer);
      this.cursorFlushTimer = null;
    }
    this.pendingCursorPacket = null;

    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Close all peer connections
    for (const peer of this.peers.values()) {
      if (peer.dataChannel) {
        peer.dataChannel.close();
      }
      peer.connection.close();
    }
    this.peers.clear();

    // Leave P2P session
    try {
      await this.convexClient.mutation(api.webrtc.leaveP2PSession, {
        sessionId: this.sessionId,
        peerId: this.peerId,
        guestKey: this.guestKey,
        editKey: this.editKey,
      });
    } catch (error) {
      console.error('Error leaving P2P session:', error);
    }
  }
}