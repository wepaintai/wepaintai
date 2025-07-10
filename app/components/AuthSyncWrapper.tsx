import { ReactNode } from 'react'
import { useAutoSyncConvexAuth } from '../hooks/useAutoSyncConvexAuth'

export function AuthSyncWrapper({ children }: { children: ReactNode }) {
  // Temporarily disabled - ConvexBetterAuthProvider should handle this
  // useAutoSyncConvexAuth()
  
  console.log('[AuthSyncWrapper] Disabled - ConvexBetterAuthProvider handles auth sync')
  
  return <>{children}</>
}