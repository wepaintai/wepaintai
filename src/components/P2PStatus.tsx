import React from 'react';
import type { ConnectionMode, P2PMetrics } from '../lib/webrtc/types';

interface P2PStatusProps {
  isConnected: boolean;
  connectionMode: ConnectionMode;
  metrics: P2PMetrics | null;
  className?: string;
}

export function P2PStatus({ isConnected, connectionMode, metrics, className = '' }: P2PStatusProps) {
  const getStatusColor = () => {
    if (!isConnected) return 'bg-red-500'; // Red when not connected (no fallback)
    if (connectionMode === 'mesh') return 'bg-green-500';
    if (connectionMode === 'sfu') return 'bg-blue-500';
    return 'bg-gray-500';
  };

  const getStatusText = () => {
    if (!isConnected) return 'P2P Required';
    if (connectionMode === 'mesh') return 'P2P Direct';
    if (connectionMode === 'sfu') return 'P2P Relay';
    return 'P2P Only';
  };

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      <div className="flex items-center gap-1">
        <div className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
        <span className="text-gray-600">{getStatusText()}</span>
      </div>
      
      {metrics && isConnected && (
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span>Peers: {metrics.connectedPeers}</span>
          <span>Latency: {metrics.latency}ms</span>
          <span>Sent: {metrics.packetsSent}</span>
          <span>Recv: {metrics.packetsReceived}</span>
        </div>
      )}
    </div>
  );
}