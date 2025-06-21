import { reactStartHandler } from '@convex-dev/better-auth/react-start'
import { createServerFileRoute } from '@tanstack/react-start'

// Use the Convex site URL from the environment
const convexSiteUrl = process.env.CONVEX_SITE_URL || 'https://polished-flamingo-936.convex.site'

export const ServerRoute = createServerFileRoute().all(async ({ request }) => {
  console.log('[Auth Route] Request:', request.method, request.url)
  console.log('[Auth Route] Using Convex site URL:', convexSiteUrl)
  
  return reactStartHandler(request, { convexSiteUrl })
})