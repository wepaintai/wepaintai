export interface PreviewPacket {
  t: 'pt';  // type: point
  id: string;  // stroke id (truncated UUID)
  x: number;  // 0-1 normalized
  y: number;  // 0-1 normalized
  p: number;  // pressure 0-1
}

export interface CursorPacket {
  t: 'cu';  // type: cursor
  x: number;  // 0-1 normalized
  y: number;  // 0-1 normalized
  drawing: boolean;  // is drawing
}

export type P2PPacket = PreviewPacket | CursorPacket;

export interface PeerConnection {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  isConnected: boolean;
}

export interface P2PConfig {
  iceServers: RTCIceServer[];
  dataChannelOptions: RTCDataChannelInit;
  maxPeersForMesh: number;
  sfuUrl?: string;
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
}

export interface P2PMetrics {
  latency: number;
  packetsSent: number;
  packetsReceived: number;
  bytesTransferred: number;
  connectedPeers: number;
}

export type ConnectionMode = 'mesh' | 'sfu' | 'fallback';

export interface RemoteStroke {
  peerId: string;
  strokeId: string;
  points: Array<{ x: number; y: number; pressure: number }>;
  color: string;
  size: number;
  lastUpdate: number;
}