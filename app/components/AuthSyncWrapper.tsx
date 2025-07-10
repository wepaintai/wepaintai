import { ReactNode } from 'react'
import { useAutoSyncConvexAuth } from '../hooks/useAutoSyncConvexAuth'

export function AuthSyncWrapper({ children }: { children: ReactNode }) {
  // Re-enabling manual sync since ConvexBetterAuthProvider isn't working
  useAutoSyncConvexAuth()
  
  return <>{children}</>
}