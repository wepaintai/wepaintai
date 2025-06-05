import React, { useState, useEffect } from 'react';
import type { ConnectionMode, P2PMetrics } from '../lib/webrtc/types';

interface P2PDebugPanelProps {
  isConnected: boolean;
  connectionMode: ConnectionMode;
  metrics: P2PMetrics | null;
  remoteStrokesCount: number;
}

export function P2PDebugPanel({ 
  isConnected, 
  connectionMode, 
  metrics, 
  remoteStrokesCount 
}: P2PDebugPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [convexCallCount, setConvexCallCount] = useState(0);
  const [p2pMessageCount, setP2PMessageCount] = useState(0);

  // Monitor Convex calls
  useEffect(() => {
    const originalFetch = window.fetch;
    let count = 0;
    
    // @ts-ignore
    window.fetch = function(...args) {
      if (args[0]?.toString?.().includes?.('convex')) {
        count++;
        setConvexCallCount(count);
        
        // Log mutation details
        if (args[1]?.body) {
          try {
            const body = JSON.parse(args[1].body);
            if (body.path?.includes('updateLiveStroke')) {
              console.warn('⚠️ CONVEX LIVE STROKE DETECTED - P2P may not be working!');
            }
          } catch (e) {}
        }
      }
      return originalFetch.apply(this, args);
    };

    return () => {
      // @ts-ignore
      window.fetch = originalFetch;
    };
  }, []);

  // Track P2P messages
  useEffect(() => {
    if (metrics) {
      setP2PMessageCount(metrics.packetsSent + metrics.packetsReceived);
    }
  }, [metrics]);

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="fixed bottom-20 right-4 bg-blue-600 text-white px-3 py-1 rounded text-xs hover:bg-blue-700"
      >
        P2P Debug
      </button>
    );
  }

  return (
    <div className="fixed bottom-20 right-4 bg-white border-2 border-gray-300 rounded-lg shadow-lg p-4 w-80 z-50">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-bold text-sm">P2P Debug Panel</h3>
        <button
          onClick={() => setIsExpanded(false)}
          className="text-gray-500 hover:text-gray-700"
        >
          ✕
        </button>
      </div>

      <div className="space-y-2 text-xs">
        {/* Connection Status */}
        <div className="border-b pb-2">
          <div className="flex justify-between">
            <span>P2P Status:</span>
            <span className={isConnected ? 'text-green-600' : 'text-red-600'}>
              {isConnected ? '✓ Connected' : '✗ Disconnected'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Mode:</span>
            <span className="font-mono">{connectionMode}</span>
          </div>
        </div>

        {/* Real-time Metrics */}
        <div className="border-b pb-2">
          <div className="font-semibold mb-1">Live Activity:</div>
          <div className="flex justify-between">
            <span>P2P Messages:</span>
            <span className="font-mono text-green-600">{p2pMessageCount}</span>
          </div>
          <div className="flex justify-between">
            <span>Convex Calls:</span>
            <span className={`font-mono ${convexCallCount > 10 ? 'text-red-600' : 'text-gray-600'}`}>
              {convexCallCount}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Remote Strokes:</span>
            <span className="font-mono">{remoteStrokesCount}</span>
          </div>
        </div>

        {/* P2P Metrics */}
        {metrics && (
          <div className="border-b pb-2">
            <div className="font-semibold mb-1">P2P Performance:</div>
            <div className="flex justify-between">
              <span>Latency:</span>
              <span className={`font-mono ${metrics.latency < 50 ? 'text-green-600' : 'text-yellow-600'}`}>
                {metrics.latency}ms
              </span>
            </div>
            <div className="flex justify-between">
              <span>Peers:</span>
              <span className="font-mono">{metrics.connectedPeers}</span>
            </div>
            <div className="flex justify-between">
              <span>Sent:</span>
              <span className="font-mono">{metrics.packetsSent}</span>
            </div>
            <div className="flex justify-between">
              <span>Received:</span>
              <span className="font-mono">{metrics.packetsReceived}</span>
            </div>
            <div className="flex justify-between">
              <span>Bandwidth:</span>
              <span className="font-mono">{(metrics.bytesTransferred / 1024).toFixed(1)}KB</span>
            </div>
          </div>
        )}

        {/* Isolation Status */}
        <div className="bg-gray-50 p-2 rounded">
          <div className="font-semibold mb-1">Isolation Check:</div>
          {isConnected && connectionMode !== 'fallback' ? (
            <div className="text-green-600">
              ✓ P2P Active - Convex bypassed for live strokes
            </div>
          ) : (
            <div className="text-yellow-600">
              ⚠ Using Convex fallback - P2P not available
            </div>
          )}
          {convexCallCount > 10 && isConnected && (
            <div className="text-red-600 mt-1">
              ⚠ High Convex activity detected during P2P mode!
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="text-gray-500 text-xs pt-2">
          <p>• P2P messages should increase while painting</p>
          <p>• Convex calls should stay low during painting</p>
          <p>• Check console for detailed warnings</p>
        </div>
      </div>
    </div>
  );
}