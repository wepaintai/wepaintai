import { createFileRoute } from '@tanstack/react-router'
import { PaintingView } from '../components/PaintingView'
import { AuthDebug } from '../components/AuthDebug'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <>
      <PaintingView />
      <AuthDebug />
    </>
  )
}
