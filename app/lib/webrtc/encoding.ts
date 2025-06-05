import type { PreviewPacket, CursorPacket, P2PPacket } from './types';

/**
 * Encode a preview packet into a compact binary format
 * Format (22 bytes total):
 * - Type: 2 bytes ('pt' for point)
 * - Stroke ID: 8 bytes (first 8 chars of UUID)
 * - X: 4 bytes (float32, 0-1 normalized)
 * - Y: 4 bytes (float32, 0-1 normalized)
 * - Pressure: 4 bytes (float32, 0-1)
 */
export function encodePreviewPacket(packet: PreviewPacket): ArrayBuffer {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  
  // Write type (2 bytes)
  view.setUint8(0, packet.t.charCodeAt(0)); // 'p'
  view.setUint8(1, packet.t.charCodeAt(1)); // 't'
  
  // Write stroke ID (8 bytes) - take first 8 chars of UUID
  const idBytes = packet.id.substring(0, 8);
  for (let i = 0; i < 8; i++) {
    view.setUint8(2 + i, idBytes.charCodeAt(i) || 0);
  }
  
  // Write coordinates and pressure as float32
  view.setFloat32(10, packet.x, true); // little-endian
  view.setFloat32(14, packet.y, true);
  view.setFloat32(18, packet.p, true);
  
  return buffer;
}

/**
 * Decode a binary buffer back into a preview packet
 */
export function decodePreviewPacket(buffer: ArrayBuffer): PreviewPacket | null {
  if (buffer.byteLength !== 22) {
    console.error('Invalid packet size:', buffer.byteLength);
    return null;
  }
  
  const view = new DataView(buffer);
  
  // Read type
  const type = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  if (type !== 'pt') {
    console.error('Invalid packet type:', type);
    return null;
  }
  
  // Read stroke ID
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += String.fromCharCode(view.getUint8(2 + i));
  }
  
  // Read coordinates and pressure
  const x = view.getFloat32(10, true);
  const y = view.getFloat32(14, true);
  const p = view.getFloat32(18, true);
  
  return {
    t: 'pt',
    id,
    x,
    y,
    p,
  };
}

/**
 * Encode a cursor packet into a compact binary format
 * Format (10 bytes total):
 * - Type: 2 bytes ('cu' for cursor)
 * - X: 4 bytes (float32, 0-1 normalized)
 * - Y: 4 bytes (float32, 0-1 normalized) 
 * - Drawing: 1 byte (0 or 1)
 */
export function encodeCursorPacket(packet: CursorPacket): ArrayBuffer {
  const buffer = new ArrayBuffer(11);
  const view = new DataView(buffer);
  
  // Write type (2 bytes)
  view.setUint8(0, packet.t.charCodeAt(0)); // 'c'
  view.setUint8(1, packet.t.charCodeAt(1)); // 'u'
  
  // Write coordinates as float32
  view.setFloat32(2, packet.x, true); // little-endian
  view.setFloat32(6, packet.y, true);
  
  // Write drawing state
  view.setUint8(10, packet.drawing ? 1 : 0);
  
  return buffer;
}

/**
 * Decode a cursor packet
 */
export function decodeCursorPacket(buffer: ArrayBuffer): CursorPacket | null {
  if (buffer.byteLength !== 11) {
    return null;
  }
  
  const view = new DataView(buffer);
  
  // Read type
  const type = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  if (type !== 'cu') {
    return null;
  }
  
  // Read coordinates and state
  return {
    t: 'cu',
    x: view.getFloat32(2, true),
    y: view.getFloat32(6, true),
    drawing: view.getUint8(10) === 1,
  };
}

/**
 * Decode any P2P packet based on type
 */
export function decodeP2PPacket(buffer: ArrayBuffer): P2PPacket | null {
  if (buffer.byteLength === 22) {
    return decodePreviewPacket(buffer);
  } else if (buffer.byteLength === 11) {
    return decodeCursorPacket(buffer);
  }
  return null;
}

/**
 * Batch encode multiple packets for efficiency
 */
export function encodeBatch(packets: PreviewPacket[]): ArrayBuffer {
  const totalSize = 2 + (packets.length * 22); // 2 bytes for count + packets
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  
  // Write packet count
  view.setUint16(0, packets.length, true);
  
  // Write each packet
  let offset = 2;
  for (const packet of packets) {
    const packetBuffer = encodePreviewPacket(packet);
    const packetView = new Uint8Array(packetBuffer);
    const targetView = new Uint8Array(buffer, offset, 22);
    targetView.set(packetView);
    offset += 22;
  }
  
  return buffer;
}

/**
 * Decode a batch of packets
 */
export function decodeBatch(buffer: ArrayBuffer): PreviewPacket[] {
  if (buffer.byteLength < 2) {
    return [];
  }
  
  const view = new DataView(buffer);
  const count = view.getUint16(0, true);
  const packets: PreviewPacket[] = [];
  
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset + 22 > buffer.byteLength) {
      console.error('Buffer underrun while decoding batch');
      break;
    }
    
    const packetBuffer = buffer.slice(offset, offset + 22);
    const packet = decodePreviewPacket(packetBuffer);
    if (packet) {
      packets.push(packet);
    }
    offset += 22;
  }
  
  return packets;
}