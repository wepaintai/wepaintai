import { createFileRoute } from '@tanstack/react-router'
import { PaintingView } from '../components/PaintingView'
import { AuthDebug } from '../components/AuthDebug'
import { AuthTest } from '../components/AuthTest'
import { ConvexTokenTest } from '../components/ConvexTokenTest'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <>
      <PaintingView />
      <AuthDebug />
      <AuthTest />
      <ConvexTokenTest />
    </>
  )
}
