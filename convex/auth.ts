import {
  BetterAuth,
  convexAdapter,
  type AuthFunctions,
} from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { components, internal } from "./_generated/api";
import { query, type GenericCtx } from "./_generated/server";
import type { Id, DataModel } from "./_generated/dataModel";

// Typesafe way to pass Convex functions defined in this file
const authFunctions: AuthFunctions = internal.auth;

// Initialize the component
export const betterAuthComponent = new BetterAuth(
  components.betterAuth,
  {
    authFunctions,
  }
);

export const createAuth = (ctx: GenericCtx) => {
  // For Better Auth to work properly, the baseURL must match where the auth endpoints are served
  // Use the custom domain if available, otherwise fall back to .convex.site
  const convexSiteUrl = process.env.CONVEX_SITE_URL || "https://actions.wepaint.ai";
  
  // Determine cookie domain based on SITE_URL environment variable
  const getCookieDomain = () => {
    const siteUrl = process.env.SITE_URL || '';
    if (siteUrl.includes('wepaint.ai')) {
      return '.wepaint.ai'; // Allow sharing across all wepaint.ai subdomains
    }
    return undefined; // Don't set domain for localhost
  };
  
  // Configure your Better Auth instance here
  return betterAuth({
    // Use the Convex site URL as the base URL for auth
    // This must match where the HTTP actions are actually served
    baseURL: convexSiteUrl,
    database: convexAdapter(ctx, betterAuthComponent),
    secret: process.env.BETTER_AUTH_SECRET,

    // Simple non-verified email/password to get started
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    
    // Configure trusted origins for CORS
    trustedOrigins: [
      "http://localhost:3000",
      "http://localhost:3001", // Alternative port when 3000 is busy
      "http://localhost:5173", // Vite default port
      "https://ipaintai.com",
      "https://www.ipaintai.com",
      "https://dev.wepaint.ai",
      "https://wepaint.ai",
    ],
    
    plugins: [
      // The Convex plugin is required
      convex(),
      // JWT plugin commented out temporarily to test basic auth
      // jwt({
      //   jwks: {
      //     // Disable private key encryption to fix the decryption error
      //     disablePrivateKeyEncryption: true,
      //     // Auto-generate keys if they don't exist
      //     autoGenerateKeys: true,
      //     // Key configuration
      //     keyPairConfig: {
      //       // Use RS256 algorithm (RSA signature with SHA-256)
      //       alg: "RS256",
      //       // Key size in bits
      //       modulusLength: 2048,
      //     }
      //   },
      //   // Issuer for the JWT tokens
      //   issuer: process.env.SITE_URL || "https://dev.wepaint.ai",
      //   // Disable JWT verification temporarily to allow initialization
      //   skipJWTVerification: false,
      // }),
    ],
    
    // Advanced configuration to handle cross-origin requests
    advanced: {
      // Disable origin checking to allow requests from localhost
      disableCSRFCheck: true,
      // Use insecure cookies for localhost development
      useSecureCookies: false, // This prevents the __Secure- prefix
      // Configure cookies for cross-domain access
      // Note: For localhost development, we need special handling
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true, // Required for SameSite=none
        partitioned: false, // Don't use partitioned for now as it may cause issues
        httpOnly: true,
        path: "/",
        // Set domain dynamically based on environment
        // This allows cookies to be shared between actions.wepaint.ai and dev.wepaint.ai
        domain: getCookieDomain(),
      },
    },
  });
};

// These are required named exports
export const {
  createUser,
  updateUser,
  deleteUser,
  createSession,
} =
  betterAuthComponent.createAuthFunctions<DataModel>({
    // Must create a user and return the user id
    onCreateUser: async (ctx, user) => {
      console.log('[onCreateUser] Creating user:', user);
      const userId = await ctx.db.insert("users", {
        email: user.email,
        name: user.name,
      });
      console.log('[onCreateUser] Created user with ID:', userId);
      return userId;
    },

    // Delete the user when they are deleted from Better Auth
    onDeleteUser: async (ctx, userId) => {
      await ctx.db.delete(userId as Id<"users">);
    },
    
    // Log when sessions are created
    onCreateSession: async (ctx, session) => {
      console.log('[onCreateSession] Creating session:', {
        userId: session.userId,
        token: session.token?.substring(0, 10) + '...',
        expiresAt: new Date(session.expiresAt),
      });
    },
  });

// Example function for getting the current user
// Feel free to edit, omit, etc.
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    console.log('[getCurrentUser] Starting...');
    
    // Check if we have auth identity
    const identity = await ctx.auth.getUserIdentity();
    console.log('[getCurrentUser] Identity:', identity ? { subject: identity.subject, tokenIdentifier: identity.tokenIdentifier } : 'null');
    
    // Get user data from Better Auth - email, name, image, etc.
    const userMetadata = await betterAuthComponent.getAuthUser(ctx);
    console.log('[getCurrentUser] User metadata:', userMetadata);
    
    if (!userMetadata) {
      console.log('[getCurrentUser] No user metadata found');
      return null;
    }
    
    // Get user data from your application's database
    // (skip this if you have no fields in your users table schema)
    const user = await ctx.db.get(userMetadata.userId as Id<"users">);
    console.log('[getCurrentUser] User from DB:', user);
    
    return {
      ...user,
      ...userMetadata,
    };
  },
});
