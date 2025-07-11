# P2P Preview Layer Testing Guide

## Implementation Summary

We've implemented a complete P2P Preview Layer for wepaintAI that provides sub-40ms latency for live paint strokes. The implementation includes:

### Core Components

1. **WebRTC Infrastructure** (`/app/lib/webrtc/`)
   - `types.ts`: TypeScript interfaces for P2P components
   - `config.ts`: WebRTC configuration (STUN/TURN servers)
   - `encoding.ts`: Binary message encoding/decoding (22-byte packets)
   - `P2PManager.ts`: Main WebRTC connection manager

2. **Convex Signaling** (`/convex/webrtc.ts`)
   - SDP offer/answer exchange
   - ICE candidate exchange
   - Peer discovery
   - Automatic cleanup of old signals

3. **React Integration**
   - `useP2PPainting` hook: Manages P2P connections and remote strokes
   - `P2PStatus` component: Visual indicator of connection status
   - Updated `Canvas` component: Renders P2P strokes with priority

### Key Features

- **Automatic mesh/SFU switching**: Uses direct P2P for ≤4 peers, switches to relay for larger groups
- **Binary protocol**: 22-byte messages for minimal overhead
- **Fallback to Convex**: Seamlessly falls back to Convex if P2P fails
- **Performance metrics**: Real-time latency and packet tracking

## Testing Instructions

### 1. Basic P2P Connection Test

1. Start the development server:
   ```bash
   pnpm dev
   ```

2. Open two browser windows (preferably different browsers or incognito):
   - Window 1: http://localhost:3000
   - Window 2: Copy the URL from Window 1 (includes session ID)

3. Check P2P status indicator (bottom left):
   - Green dot + "P2P Direct" = Direct connection established
   - Blue dot + "P2P Relay" = Using relay (5+ users)
   - Yellow dot + "Fallback Mode" = Using Convex

### 2. Latency Test

1. In Window 1, start drawing continuously
2. In Window 2, observe:
   - Strokes should appear within 40ms
   - P2P metrics show latency and packet counts
   - No flickering or delays

### 3. Fallback Test

1. Simulate P2P failure by:
   - Blocking WebRTC in browser settings
   - Using a restrictive firewall
2. System should automatically fall back to Convex
3. Status indicator shows "Fallback Mode"

### 4. Scale Test

1. Open 5+ browser windows with same session
2. System should automatically switch to SFU mode
3. Status shows "P2P Relay" for all users

## Troubleshooting

### No P2P Connection
- Check browser console for WebRTC errors
- Ensure browsers support WebRTC
- Check firewall/network settings

### High Latency
- Check network conditions
- Verify STUN/TURN server availability
- Monitor P2P metrics for packet loss

### Convex Integration Issues
- Run `pnpm dev:convex:local` to ensure Convex is running
- Check for schema migration errors
- Verify webrtcSignals table exists

## Configuration

Environment variables for production:
```
VITE_SFU_URL=wss://your-sfu-server.com
VITE_TURN_URL=turn:your-turn-server.com:3478
VITE_TURN_USERNAME=username
VITE_TURN_CREDENTIAL=password
```

## Architecture Notes

The P2P layer operates independently of Convex for preview strokes:
- P2P handles ephemeral, in-progress strokes
- Convex remains the authoritative source for completed strokes
- No dependency between the two systems for real-time previews

This ensures that even if Convex experiences delays, the P2P preview remains responsive.