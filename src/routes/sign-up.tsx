import { createFileRoute, redirect } from '@tanstack/react-router'

// Sign-up and sign-in are the same Google OAuth flow; keep the old URL working.
export const Route = createFileRoute('/sign-up')({
  beforeLoad: () => {
    throw redirect({ to: '/login' })
  },
})
