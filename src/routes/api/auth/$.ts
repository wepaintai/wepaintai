import { createFileRoute } from '@tanstack/react-router'
import { authProxyHandler } from '../../../lib/auth-server'

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => authProxyHandler(request),
      POST: ({ request }) => authProxyHandler(request),
    },
  },
})
