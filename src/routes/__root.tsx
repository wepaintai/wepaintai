import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import type { ReactNode } from 'react'
import { ConvexClientProvider } from '../lib/convex'
import { PasswordProtection } from '../components/PasswordProtection'
import { Analytics } from '@vercel/analytics/react'
import appCss from '../styles/app.css?url'
import { ClerkProvider } from '@clerk/tanstack-start'
import { AuthSync } from '../components/AuthSync'

function NotFoundComponent() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">404</h1>
        <h2 className="text-2xl font-semibold text-gray-700 mb-4">Page Not Found</h2>
        <p className="text-gray-600 mb-8">
          The page you're looking for doesn't exist.
        </p>
        <a
          href="/"
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go back to painting
        </a>
      </div>
    </div>
  )
}

// Server function to get auth state
const getAuth = createServerFn({ method: 'GET' }).handler(async () => {
  // For now, we'll handle auth state client-side
  // Clerk handles authentication automatically
  return {
    userId: null,
  }
})

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'wePaintAI - AI-Powered Painting App',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  beforeLoad: async () => {
    const auth = await getAuth()
    return auth
  },
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
})

function RootComponent() {
  return (
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
      <ConvexClientProvider>
        <AuthSync />
        <RootDocument>
          <PasswordProtection>
            <Outlet />
          </PasswordProtection>
        </RootDocument>
      </ConvexClientProvider>
    </ClerkProvider>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
        <Analytics />
      </body>
    </html>
  )
}