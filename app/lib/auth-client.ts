/**
 * Auth Client Configuration
 * 
 * CORS Setup Requirements:
 * 1. Set CLIENT_ORIGIN in Convex dashboard (Settings > Environment Variables)
 *    - For development: http://localhost:3000
 *    - For production: https://ipaintai.com
 * 
 * 2. The convex/http.ts file handles CORS headers dynamically
 *    - Checks request origin against ALLOWED_ORIGINS list
 *    - Falls back to CLIENT_ORIGIN env var if set
 *    - Defaults to http://localhost:3000 for development
 */

import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

// Get the base URL for auth - handle different environments
function getAuthBaseURL() {
  // Use the Convex site URL from environment if available (preferred for production)
  const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
  if (convexSiteUrl) {
    console.log('[Auth Client] Using Convex site URL from env:', convexSiteUrl);
    return String(convexSiteUrl);
  }
  
  // Derive from Convex URL if site URL not available
  const convexUrl = String(import.meta.env.VITE_CONVEX_URL || '');
  if (convexUrl) {
    // Handle standard Convex cloud URLs
    if (convexUrl.includes('.convex.cloud')) {
      // Convert .cloud to .site for standard Convex URLs
      const siteUrl = convexUrl.replace('.convex.cloud', '.convex.site');
      console.log('[Auth Client] Derived site URL from Convex URL:', siteUrl);
      return siteUrl;
    } else if (convexUrl === 'https://api.wepaint.ai') {
      // Production with custom domain: Use the actions subdomain for HTTP endpoints
      const prodSiteUrl = 'https://actions.wepaint.ai';
      console.log('[Auth Client] Production custom domain - using actions subdomain for auth:', prodSiteUrl);
      return prodSiteUrl;
    } else {
      // For other custom domains, log a warning
      console.warn('[Auth Client] Custom domain detected but no VITE_CONVEX_SITE_URL set:', convexUrl);
      console.warn('Please set VITE_CONVEX_SITE_URL in your environment variables');
      // Try to use it anyway
      return convexUrl;
    }
  }
  
  // Default fallback for development
  console.log('[Auth Client] Using development Convex site URL');
  return "https://polished-flamingo-936.convex.site";
}

// Create a custom fetch that handles CORS and origin issues
const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  
  // Ensure we're using absolute URLs
  const absoluteUrl = url.startsWith('http') ? url : `${getAuthBaseURL()}${url}`;
  
  // Create headers
  const headers = new Headers(init?.headers);
  
  // Remove any origin header that might be set to 'null'
  headers.delete('Origin');
  
  // Ensure proper content type for JSON
  if (init?.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  
  const newInit: RequestInit = {
    ...init,
    headers,
    // Use 'include' to send cookies cross-origin (server is configured for this)
    credentials: 'include',
    // Ensure we're not sending 'null' as referrer
    referrerPolicy: 'no-referrer',
  };
  
  // Debug logging
  if (absoluteUrl.includes('/auth/')) {
    console.log('[Auth Client] Request:', {
      url: absoluteUrl,
      method: newInit.method || 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: newInit.body,
      credentials: newInit.credentials,
    });
  }
  
  try {
    const response = await fetch(absoluteUrl, newInit);
    
    if (absoluteUrl.includes('/auth/')) {
      const responseText = await response.clone().text();
      console.log('[Auth Client] Response:', {
        url: absoluteUrl,
        status: response.status,
        ok: response.ok,
        body: responseText.substring(0, 200),
        headers: {
          'content-type': response.headers.get('content-type'),
          'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
          'access-control-allow-credentials': response.headers.get('access-control-allow-credentials'),
        }
      });
      
      // Check for CORS issues in response
      if (!response.ok && response.status === 0) {
        console.error('[Auth Client] CORS error: Response status 0 indicates a CORS failure');
        console.error('Ensure the server allows requests from:', window.location.origin);
      }
    }
    
    return response;
  } catch (error) {
    console.error('[Auth Client] Fetch error:', error);
    
    // Enhanced CORS error detection and messaging
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      console.error('[Auth Client] CORS error detected!');
      console.error('Details:', {
        clientOrigin: window.location.origin,
        authBaseURL: getAuthBaseURL(),
        requestedURL: absoluteUrl,
        error: error.message,
      });
      console.error('Possible solutions:');
      console.error('1. Ensure CLIENT_ORIGIN is set in Convex dashboard environment variables');
      console.error('2. Check that the origin is in the ALLOWED_ORIGINS list in convex/http.ts');
      console.error('3. Verify the Convex deployment is running and accessible');
    }
    
    throw error;
  }
};

export const authClient = createAuthClient({
  baseURL: getAuthBaseURL(),
  plugins: [
    convexClient({
      // Ensure the client plugin is properly configured
      fetch: customFetch,
    }),
  ],
  fetch: customFetch,
  // Ensure cookies are used for session storage
  fetchOptions: {
    credentials: 'include',
  },
});

// Add session debug on client creation
if (typeof window !== 'undefined') {
  console.log('[Auth Client] Created with base URL:', getAuthBaseURL());
  
  // Check for session immediately
  authClient.getSession().then(session => {
    console.log('[Auth Client] Initial session check:', session);
  }).catch(err => {
    console.error('[Auth Client] Initial session check error:', err);
  });
}

// Debug function to check auth state
export function debugAuthState() {
  console.log('[Auth Debug] Environment:', {
    origin: typeof window !== 'undefined' ? window.location.origin : 'SSR',
    href: typeof window !== 'undefined' ? window.location.href : 'SSR',
    protocol: typeof window !== 'undefined' ? window.location.protocol : 'SSR',
    authBaseURL: getAuthBaseURL(),
  });
  
  if (typeof window !== 'undefined') {
    const keys = Object.keys(localStorage).filter(k => k.includes('convex') || k.includes('auth'));
    console.log('[Auth Debug] localStorage keys:', keys);
    keys.forEach(key => {
      const value = localStorage.getItem(key);
      console.log(`[Auth Debug] ${key}:`, value?.substring(0, 100) + '...');
    });
  }
}
