import type { P2PConfig } from './types';

export const defaultConfig: P2PConfig = {
  iceServers: [
    // Google's public STUN servers
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Additional STUN servers for redundancy
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  dataChannelOptions: {
    ordered: false,
    maxRetransmits: 0,
    protocol: 'paint-preview',
  },
  maxPeersForMesh: 4,
  // SFU and TURN will be configured via environment variables
  sfuUrl: undefined,
  turnUrl: undefined,
  turnUsername: undefined,
  turnCredential: undefined,
};

// Load config from environment if available
export function loadConfig(): P2PConfig {
  const config = { ...defaultConfig };
  
  // Load from environment variables if running in browser
  if (typeof window !== 'undefined') {
    const env = (window as any).__ENV__ || {};
    
    if (env.VITE_SFU_URL) {
      config.sfuUrl = env.VITE_SFU_URL;
    }
    
    if (env.VITE_TURN_URL) {
      config.turnUrl = env.VITE_TURN_URL;
      config.turnUsername = env.VITE_TURN_USERNAME;
      config.turnCredential = env.VITE_TURN_CREDENTIAL;
      
      // Add TURN server to ICE servers
      config.iceServers.push({
        urls: config.turnUrl,
        username: config.turnUsername,
        credential: config.turnCredential,
      });
    }
  }
  
  return config;
}