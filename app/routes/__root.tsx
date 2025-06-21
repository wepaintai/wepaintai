import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, getWebRequest } from '@tanstack/react-start/server'
import type { ReactNode } from 'react'
import { ConvexClientProvider } from '../lib/convex'
import { PasswordProtection } from '../components/PasswordProtection'
import { Analytics } from '@vercel/analytics/react'
import appCss from '../styles/app.css?url'
import {
  fetchSession,
  getCookieName,
} from '@convex-dev/better-auth/react-start'
import { createAuth } from '../../convex/auth'

// Simple in-memory cache for auth state
let authCache: { userId: string | null; token: string | null; timestamp: number } | null = null
const AUTH_CACHE_TTL = 5000 // 5 seconds

// Clear cache on initial load
if (typeof window === 'undefined') {
  authCache = null
}

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

// Server side session request - memoized to prevent repeated calls
const fetchAuth = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    // Check cache first
    if (authCache && Date.now() - authCache.timestamp < AUTH_CACHE_TTL) {
      return authCache
    }
    
    const sessionCookieName = await getCookieName(createAuth)
    const token = getCookie(sessionCookieName)
    
    // Debug logging
    if (process.env.NODE_ENV === 'development') {
      console.log('[fetchAuth] Cookie name:', sessionCookieName)
      console.log('[fetchAuth] Token exists:', !!token)
    }
    
    // If no token, skip the session fetch
    if (!token) {
      const result = {
        userId: null,
        token: null,
        timestamp: Date.now()
      }
      authCache = result
      return result
    }
    
    const request = getWebRequest()
    const { session } = await fetchSession(createAuth, request)
    
    // Debug logging
    if (process.env.NODE_ENV === 'development') {
      console.log('[fetchAuth] Session:', session)
      console.log('[fetchAuth] User ID:', session?.user?.id)
    }
    
    const result = {
      userId: session?.user?.id || null,
      token: token || null,
      timestamp: Date.now()
    }
    authCache = result
    return result
  } catch (error) {
    // Only log errors in development
    if (process.env.NODE_ENV === 'development') {
      console.error('Error fetching auth:', error)
    }
    const result = {
      userId: null,
      token: null,
      timestamp: Date.now()
    }
    authCache = result
    return result
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
  beforeLoad: async ({ context }) => {
    // Return cached auth if available
    if (context?.userId !== undefined) {
      return { userId: context.userId, token: context.token }
    }
    
    // Get auth state for the app
    const auth = await fetchAuth()
    const { userId, token } = auth

    return { userId, token }
  },
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
})

function RootComponent() {
  return (
    <ConvexClientProvider>
      <RootDocument>
        <PasswordProtection>
          <Outlet />
        </PasswordProtection>
      </RootDocument>
    </ConvexClientProvider>
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
