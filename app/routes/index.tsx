import { createFileRoute } from '@tanstack/react-router'
import { PaintingView } from '../components/PaintingView'
import { AuthDebug } from '../components/AuthDebug'
import { AuthTest } from '../components/AuthTest'
import { ConvexTokenTest } from '../components/ConvexTokenTest'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  // Check if auth is disabled via environment variable
  const authDisabled = import.meta.env.VITE_AUTH_DISABLED === 'true'
  
  return (
    <>
      <PaintingView />
      {/* Only show auth debug components when auth is not disabled */}
      {!authDisabled && (
        <>
          <AuthDebug />
          <AuthTest />
          <ConvexTokenTest />
        </>
      )}
    </>
  )
}
