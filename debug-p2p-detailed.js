// Run this in the browser console to debug P2P connection issues

console.log('=== P2P Debug Script ===');

// 1. Check current user info
console.log('1. Current User:', {
  id: currentUser?.id,
  name: currentUser?.name,
  isCreated: !!currentUser?.id
});

// 2. Check presence data
const presenceElements = document.querySelectorAll('[data-presence]');
console.log('2. Visible Users:', presenceElements.length);

// 3. Monitor WebRTC activity
let rtcConnections = 0;
const originalRTCPeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = function(...args) {
  rtcConnections++;
  console.log(`3. Creating RTCPeerConnection #${rtcConnections}`, args);
  const pc = new originalRTCPeerConnection(...args);
  
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log(`   ICE State: ${pc.iceConnectionState}`);
  });
  
  pc.addEventListener('connectionstatechange', () => {
    console.log(`   Connection State: ${pc.connectionState}`);
  });
  
  return pc;
};

// 4. Check P2P manager state
console.log('4. P2P Manager exists?', typeof p2pManagerRef !== 'undefined');

// 5. Monitor Convex queries
let convexQueries = {};
const checkConvexQueries = () => {
  const queries = document.querySelectorAll('[data-convex-query]');
  queries.forEach(q => {
    const query = q.getAttribute('data-convex-query');
    if (!convexQueries[query]) {
      convexQueries[query] = 0;
    }
    convexQueries[query]++;
  });
  console.log('5. Convex Queries:', convexQueries);
};
setTimeout(checkConvexQueries, 1000);

console.log('Debug script loaded. Paint to see WebRTC activity.');