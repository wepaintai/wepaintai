import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { betterAuthComponent, createAuth } from './auth'

const http = httpRouter()

// Define allowed origins for CORS
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001", // Alternative port when 3000 is busy
  "http://localhost:5173", // Vite default port
  "https://ipaintai.com",
  "https://www.ipaintai.com",
  // Add production URLs here when needed
];

// Helper function to get allowed origin from request
function getAllowedOrigin(request: Request): string {
  const origin = request.headers.get("Origin");
  
  // If no origin header or origin is in allowed list, use it
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  
  // Check if we have a CLIENT_ORIGIN env var set in Convex dashboard
  if (process.env.CLIENT_ORIGIN) {
    return process.env.CLIENT_ORIGIN;
  }
  
  // Default to localhost for development
  return "http://localhost:3000";
}

// Handle preflight OPTIONS requests for all auth routes
// Handle both /auth/ and /api/auth/ prefixes
const handlePreflight = httpAction(async (_, request) => {
  // Make sure the necessary headers are present
  // for this to be a valid pre-flight request
  const headers = request.headers;
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null &&
    headers.get("Access-Control-Request-Headers") !== null
  ) {
    const allowedOrigin = getAllowedOrigin(request);
    console.log("[CORS] Preflight request from:", headers.get("Origin"), "-> allowed:", allowedOrigin);
    
    return new Response(null, {
      status: 200,
      headers: new Headers({
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      }),
    });
  } else {
    return new Response();
  }
});

// Register preflight handlers for both possible auth route prefixes
http.route({
  pathPrefix: "/auth/",
  method: "OPTIONS",
  handler: handlePreflight,
});

http.route({
  pathPrefix: "/api/auth/",
  method: "OPTIONS",
  handler: handlePreflight,
});

// Create a wrapper that adds CORS headers to Better Auth responses
const createAuthWithCORS = (ctx: any) => {
  const authHandler = createAuth(ctx);
  
  // Return the auth handler object with wrapped handler function
  return {
    ...authHandler,
    handler: async (request: Request) => {
      const allowedOrigin = getAllowedOrigin(request);
      const requestOrigin = request.headers.get("Origin");
      
      console.log("[AUTH] Request from origin:", requestOrigin, "-> allowed:", allowedOrigin);
      console.log("[AUTH] Request URL:", request.url);
      console.log("[AUTH] Request method:", request.method);
      
      // For null origin (could be from file:// or certain browser contexts), 
      // we'll allow it but log a warning
      if (requestOrigin === "null") {
        console.warn("[AUTH] Received request with null origin - this may be from a file:// URL or certain browser contexts");
      }
      
      try {
        // Call the original auth handler
        const response = await authHandler.handler(request);
        
        // Clone the response to modify headers
        const newHeaders = new Headers(response.headers);
        
        // Add CORS headers following Convex documentation pattern
        newHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
        newHeaders.set("Access-Control-Allow-Credentials", "true");
        newHeaders.set("Vary", "Origin");
        
        console.log("[AUTH] Response status:", response.status);
        // Log specific headers for debugging
        console.log("[AUTH] Response headers:", {
          'access-control-allow-origin': newHeaders.get('access-control-allow-origin'),
          'access-control-allow-credentials': newHeaders.get('access-control-allow-credentials'),
          'vary': newHeaders.get('vary'),
          'content-type': newHeaders.get('content-type'),
        });
        
        // Return new response with CORS headers
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      } catch (error) {
        console.error('[AUTH] Handler error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: new Headers({
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": allowedOrigin,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
          }),
        });
      }
    }
  };
};

// Register Better Auth routes with CORS support
// Pass allowed origins to the Better Auth component
betterAuthComponent.registerRoutes(http, createAuthWithCORS, {
  allowedOrigins: ALLOWED_ORIGINS,
});

export default http
