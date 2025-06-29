import { ReactNode } from 'react'
import { useAutoSyncConvexAuth } from '../hooks/useAutoSyncConvexAuth'

export function AuthSyncWrapper({ children }: { children: ReactNode }) {
  // This hook automatically syncs Better Auth session with Convex
  useAutoSyncConvexAuth()
  
  return <>{children}</>
}