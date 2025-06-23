import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { betterAuthComponent, createAuth } from './auth'

const http = httpRouter()

// Get allowed origins from Better Auth configuration
const getAllowedOrigins = async (request: Request): Promise<string[]> => {
  // Get the auth instance configuration
  const auth = createAuth({} as any);
  
  // Start with the base URL and trusted origins from auth config
  const origins: string[] = [
    auth.options.baseURL,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "https://ipaintai.com",
    "https://www.ipaintai.com",
  ];
  
  // Add CLIENT_ORIGIN from env if set
  if (process.env.CLIENT_ORIGIN) {
    origins.push(process.env.CLIENT_ORIGIN);
  }
  
  // Allow any localhost origin in development
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin?.startsWith("http://localhost:")) {
    origins.push(requestOrigin);
  }
  
  // Remove duplicates and filter out undefined/null
  return [...new Set(origins.filter(Boolean))];
};

// Create CORS headers getter
const getCorsHeaders = async (request: Request) => {
  const allowedOrigins = await getAllowedOrigins(request);
  const origin = request.headers.get('Origin');
  const headers = new Headers();
  
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    // For development, be more permissive
    console.log('[CORS] Origin not in allowed list:', origin, 'Allowed:', allowedOrigins);
    headers.set('Access-Control-Allow-Origin', origin);
  }
  
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, Better-Auth-Cookie');
  headers.set('Access-Control-Expose-Headers', 'Set-Cookie, Set-Better-Auth-Cookie');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');
  
  return headers;
};

// Handle preflight OPTIONS requests
const handlePreflight = httpAction(async (_, request) => {
  const headers = await getCorsHeaders(request);
  return new Response(null, {
    status: 200,
    headers,
  });
});

// Create the auth request handler with CORS
const authRequestHandler = httpAction(async (ctx, request) => {
  console.log('[AUTH] Incoming request:', {
    method: request.method,
    url: request.url,
    origin: request.headers.get('Origin'),
    authorization: request.headers.get('Authorization') ? 'Present' : 'Missing',
    cookie: request.headers.get('Cookie') ? 'Present' : 'Missing',
  });
  
  const auth = createAuth(ctx);
  const response = await auth.handler(request);
  
  console.log('[AUTH] Response:', {
    status: response.status,
    statusText: response.statusText,
    setCookie: response.headers.get('Set-Cookie') ? 'Present' : 'Missing',
  });
  
  // Log response body for token endpoints
  if (request.url.includes('/convex/token') || request.url.includes('/get-session')) {
    try {
      const responseClone = response.clone();
      const bodyText = await responseClone.text();
      console.log('[AUTH] Response body preview:', bodyText.substring(0, 200));
    } catch (e) {
      console.log('[AUTH] Could not read response body');
    }
  }
  
  // Add CORS headers to the response
  const corsHeaders = await getCorsHeaders(request);
  const newHeaders = new Headers(response.headers);
  
  corsHeaders.forEach((value, key) => {
    newHeaders.set(key, value);
  });
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});

// Register Better Auth routes with CORS support
const path = "/api/auth"; // Better Auth's default path

// Register OPTIONS handlers
http.route({
  pathPrefix: `${path}/`,
  method: "OPTIONS",
  handler: handlePreflight,
});

// Register actual auth handlers
http.route({
  pathPrefix: `${path}/`,
  method: "GET",
  handler: authRequestHandler,
});

http.route({
  pathPrefix: `${path}/`,
  method: "POST",
  handler: authRequestHandler,
});

export default http
