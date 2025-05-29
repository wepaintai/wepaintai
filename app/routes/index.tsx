import { createFileRoute } from '@tanstack/react-router'
import { PaintingView } from '../components/PaintingView'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

function RouteComponent() {
  return <PaintingView />
}
