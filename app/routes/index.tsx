import { createFileRoute } from '@tanstack/react-router'
import { PaintingView } from '../components/PaintingView'
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
          <ConvexTokenTest />
        </>
      )}
    </>
  )
}
