import { query } from "./_generated/server";

// Simple test query to check if Convex is working
export const testQuery = query({
  args: {},
  handler: async (ctx) => {
    return { status: "ok", timestamp: Date.now() };
  },
});

// Test query with auth check
export const testAuthQuery = query({
  args: {},
  handler: async (ctx) => {
    try {
      // Check if auth exists
      const hasAuth = typeof ctx.auth !== 'undefined';
      
      if (!hasAuth) {
        return { status: "no-auth", timestamp: Date.now() };
      }
      
      // Try to get user identity
      let identity = null;
      let authError = null;
      
      try {
        identity = await ctx.auth.getUserIdentity();
      } catch (error) {
        authError = error;
      }
      
      return {
        status: "ok",
        hasAuth,
        hasIdentity: !!identity,
        authError: authError ? String(authError) : null,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        status: "error",
        error: String(error),
        timestamp: Date.now()
      };
    }
  },
});