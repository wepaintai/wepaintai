import { useEffect, useState } from 'react'
import { convexHigh } from '../lib/convex'

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline'

/**
 * Tracks the Convex WebSocket connection state (plus navigator.onLine) so the
 * UI can show a live/reconnecting/offline indicator.
 */
export function useConnectionStatus(): ConnectionStatus {
  // Assume connected during SSR/first paint; touching connectionState() before
  // mount could spin up the sync client on the server.
  const [wsConnected, setWsConnected] = useState<boolean>(true)
  // Also assume online for the first render so hydration matches the server
  // HTML; the real navigator.onLine is read after mount.
  const [browserOnline, setBrowserOnline] = useState<boolean>(true)

  useEffect(() => {
    setWsConnected(convexHigh.connectionState().isWebSocketConnected)
    const unsubscribe = convexHigh.subscribeToConnectionState((state) => {
      setWsConnected(state.isWebSocketConnected)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    setBrowserOnline(navigator.onLine)
    const handleOnline = () => setBrowserOnline(true)
    const handleOffline = () => setBrowserOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  if (!browserOnline) return 'offline'
  if (!wsConnected) return 'reconnecting'
  return 'connected'
}
