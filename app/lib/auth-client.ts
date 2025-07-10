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

console.log('[Auth Client] Loading auth-client.ts module...');

import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

// Check if auth is disabled for local development
const authDisabled = import.meta.env.VITE_AUTH_DISABLED === 'true';
console.log('[Auth Client] Auth disabled:', authDisabled);

// Get the base URL for auth - handle different environments
function getAuthBaseURL() {
  console.log('[Auth Client] getAuthBaseURL called');
  
  // For production/staging, always use actions.wepaint.ai for auth
  if (typeof window !== 'undefined' && window.location.hostname.includes('wepaint.ai')) {
    const authUrl = 'https://actions.wepaint.ai';
    console.log('[Auth Client] Production environment detected - using:', authUrl);
    return authUrl;
  }
  
  // Use the Convex site URL from environment if available (for local dev)
  const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
  if (convexSiteUrl) {
    console.log('[Auth Client] Using Convex site URL from env:', convexSiteUrl);
    return String(convexSiteUrl);
  }
  
  // Derive from Convex URL if site URL not available
  const convexUrl = String(import.meta.env.VITE_CONVEX_URL || '');
  if (convexUrl && convexUrl.includes('.convex.cloud')) {
    // Convert .cloud to .site for standard Convex URLs
    const siteUrl = convexUrl.replace('.convex.cloud', '.convex.site');
    console.log('[Auth Client] Derived site URL from Convex URL:', siteUrl);
    return siteUrl;
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

const baseAuthClient = createAuthClient({
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

// Override getSession to use explicit endpoint
const originalGetSession = baseAuthClient.getSession;
baseAuthClient.getSession = async () => {
  console.log('[Auth Client] getSession called - using explicit endpoint');
  
  // Return mock session if auth is disabled
  if (authDisabled) {
    console.log('[Auth Client] Auth disabled - returning mock session');
    return {
      data: {
        session: {
          id: 'mock-session-id',
          userId: 'mock-user-id',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
        },
        user: {
          id: 'mock-user-id',
          email: 'local-dev@example.com',
          name: 'Local Dev User',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          emailVerified: true,
        }
      },
      error: null
    };
  }
  
  try {
    const response = await customFetch(`${getAuthBaseURL()}/api/auth/session`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.error('[Auth Client] Session fetch failed:', response.status);
      return null;
    }
    
    const data = await response.json();
    console.log('[Auth Client] Session data received:', data);
    
    // Return in the format Better Auth expects
    if (data && (data.user || data.session)) {
      return {
        data,
        error: null
      };
    }
    
    return null;
  } catch (error) {
    console.error('[Auth Client] getSession error:', error);
    // Try the original method as fallback
    return originalGetSession();
  }
};

// Extend the auth client to add the missing convex.token method
// Override signIn method when auth is disabled
const originalSignIn = baseAuthClient.signIn;
baseAuthClient.signIn = {
  email: async (credentials: any) => {
    if (authDisabled) {
      console.log('[Auth Client] Auth disabled - mock sign in');
      return {
        data: {
          session: {
            id: 'mock-session-id',
            userId: 'mock-user-id',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          user: {
            id: 'mock-user-id',
            email: credentials.email || 'local-dev@example.com',
            name: 'Local Dev User',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            emailVerified: true,
          }
        },
        error: null
      };
    }
    return originalSignIn.email(credentials);
  }
};

// Override signUp method when auth is disabled
const originalSignUp = baseAuthClient.signUp;
baseAuthClient.signUp = {
  email: async (credentials: any) => {
    if (authDisabled) {
      console.log('[Auth Client] Auth disabled - mock sign up');
      return {
        data: {
          session: {
            id: 'mock-session-id',
            userId: 'mock-user-id',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          user: {
            id: 'mock-user-id',
            email: credentials.email || 'local-dev@example.com',
            name: credentials.name || 'Local Dev User',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            emailVerified: true,
          }
        },
        error: null
      };
    }
    return originalSignUp.email(credentials);
  }
};

export const authClient = Object.assign(baseAuthClient, {
  convex: {
    token: async () => {
      console.log('[Auth Client] Fetching Convex token...');
      console.log('[Auth Client] Auth base URL:', getAuthBaseURL());
      
      // Return mock token if auth is disabled
      if (authDisabled) {
        console.log('[Auth Client] Auth disabled - returning mock token');
        return { 
          data: { 
            token: 'mock-convex-token-for-local-dev'
          }, 
          error: null 
        };
      }
      
      try {
        // First check if we have a session
        const sessionCheck = await baseAuthClient.getSession();
        console.log('[Auth Client] Session check before token fetch:', sessionCheck?.data ? 'Session exists' : 'No session');
        
        if (!sessionCheck?.data?.session) {
          console.error('[Auth Client] No session available, cannot fetch token');
          return { data: null, error: { message: 'No session available' } };
        }
        
        const tokenUrl = `${getAuthBaseURL()}/api/auth/convex/token`;
        console.log('[Auth Client] Fetching token from:', tokenUrl);
        
        const response = await customFetch(tokenUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        if (!response.ok) {
          console.error('[Auth Client] Token fetch failed:', response.status, response.statusText);
          let errorDetails;
          try {
            const text = await response.text();
            console.error('[Auth Client] Error response text:', text);
            // Try to parse as JSON
            try {
              errorDetails = JSON.parse(text);
              console.error('[Auth Client] Error details:', errorDetails);
            } catch {
              errorDetails = text;
            }
          } catch (e) {
            console.error('[Auth Client] Could not read error response');
          }
          return { data: null, error: { status: response.status, statusText: response.statusText, details: errorDetails } };
        }
        
        const data = await response.json();
        console.log('[Auth Client] Token received:', data);
        
        // Validate token response
        if (!data || !data.token) {
          console.error('[Auth Client] Invalid token response:', data);
          return { data: null, error: { message: 'Invalid token response' } };
        }
        
        return { data, error: null };
      } catch (error) {
        console.error('[Auth Client] Token fetch error:', error);
        return { data: null, error };
      }
    }
  }
});

// Add session debug on client creation
if (typeof window !== 'undefined') {
  console.log('[Auth Client] Created with base URL:', getAuthBaseURL());
  
  // Check for session immediately
  baseAuthClient.getSession().then(session => {
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
