# Debugging P2P Connection Issues

The warning "[CONVEX] updateLiveStroke - P2P should handle this!" indicates that P2P is not connecting properly. Here's how to debug:

## 1. Check P2P Connection Status

In the browser console, check:
```javascript
// Look for P2P connection logs
console.log('Check for P2P connection messages');

// Check the P2P Debug Panel
// - It should show "✓ Connected" if P2P is working
// - It should show connection mode as "mesh" or "sfu"
```

## 2. Common Reasons P2P Might Not Connect

### A. Single Browser Tab
**P2P requires at least 2 users to establish a connection.**
- Open a second browser tab/window with the same session URL
- Use incognito mode or different browser for true P2P test

### B. Browser Compatibility
Check if your browser supports WebRTC:
```javascript
console.log('RTCPeerConnection:', typeof RTCPeerConnection);
console.log('RTCDataChannel:', typeof RTCDataChannel);
```

### C. Firewall/Network Issues
- Corporate networks often block WebRTC
- Try on a different network
- Check browser console for WebRTC errors

### D. Local Development Issues
- Ensure both tabs are on the same URL (with session ID)
- Check that Convex is running (`pnpm dev`)

## 3. Quick Diagnostic Steps

1. **Open 2 browser windows** with the same painting session
2. **Check P2P Status** (bottom-left corner):
   - Should show "P2P Direct" (green) when connected
   - Shows "Disconnected" (gray) if not connected
   - Shows "Fallback Mode" (yellow) if using Convex

3. **Check Console** for errors:
   ```javascript
   // Filter console by "P2P" or "WebRTC"
   ```

4. **Check Debug Panel**:
   - Click "P2P Debug" button (bottom-right)
   - Look at "P2P Messages" counter
   - Should increase when painting if P2P works

## 4. Force P2P Testing

Add this temporary code to verify P2P capability:
```javascript
// In browser console
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});
console.log('WebRTC test:', pc);
pc.createDataChannel('test');
pc.createOffer().then(offer => {
  console.log('Can create offer:', !!offer);
});
```

## 5. Expected Behavior When P2P Works

When P2P is properly connected:
- NO "[CONVEX] updateLiveStroke" warnings
- P2P message count increases rapidly while painting
- Latency shows <40ms in debug panel
- Remote strokes appear instantly

## 6. Fallback is Working Correctly

The warning actually shows the fallback is working:
- When P2P fails, system uses Convex (as designed)
- This ensures painting always works
- Fix: Get P2P connection established

## Next Steps

1. Ensure you have 2+ browser tabs open
2. Check for WebRTC errors in console
3. Try different browsers (Chrome/Firefox)
4. Check network allows peer-to-peer connections

The implementation is correct - the issue is likely that P2P hasn't connected yet.