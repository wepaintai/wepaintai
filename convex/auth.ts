import { betterAuth } from "better-auth/minimal";
import {
  createClient,
  type AuthFunctions,
  type GenericCtx,
} from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import authConfig from "./auth.config";
import { components, internal } from "./_generated/api";
import { query } from "./_generated/server";
import type { DataModel } from "./_generated/dataModel";
import { createUserWithWelcomeTokens, getUserByAuthId } from "./users";

const authFunctions: AuthFunctions = internal.auth;

export const authComponent = createClient<DataModel>(components.betterAuth, {
  authFunctions,
  triggers: {
    user: {
      // Runs in the same transaction as Better Auth user creation:
      // every new signup gets an app users row with the welcome token grant.
      onCreate: async (ctx, authUser) => {
        await createUserWithWelcomeTokens(ctx, {
          authId: authUser._id,
          email: authUser.email,
          name: authUser.name,
        });
      },
      onUpdate: async (ctx, newDoc) => {
        const user = await getUserByAuthId(ctx, newDoc._id);
        if (user) {
          await ctx.db.patch(user._id, {
            email: newDoc.email,
            name: newDoc.name,
            updatedAt: Date.now(),
          });
        }
      },
    },
  },
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

const siteUrl = process.env.SITE_URL!;

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    // To add OAuth later, add e.g.:
    // socialProviders: {
    //   google: { clientId: ..., clientSecret: ... },
    //   github: { clientId: ..., clientSecret: ... },
    // },
    plugins: [convex({ authConfig })],
  });
};

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await getUserByAuthId(ctx, identity.subject);
  },
});
