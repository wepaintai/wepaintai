/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aiGeneration from "../aiGeneration.js";
import type * as auth from "../auth.js";
import type * as backgroundRemoval from "../backgroundRemoval.js";
import type * as crons from "../crons.js";
import type * as geminiGeneration from "../geminiGeneration.js";
import type * as http from "../http.js";
import type * as imageMerger from "../imageMerger.js";
import type * as images from "../images.js";
import type * as layers from "../layers.js";
import type * as liveStrokes from "../liveStrokes.js";
import type * as migrations_addDefaultPaintLayers from "../migrations/addDefaultPaintLayers.js";
import type * as migrations_addInitialTokensToUsers from "../migrations/addInitialTokensToUsers.js";
import type * as migrations_normalizeLayerOrders from "../migrations/normalizeLayerOrders.js";
import type * as paintLayer from "../paintLayer.js";
import type * as paintLayers from "../paintLayers.js";
import type * as paintingSessions from "../paintingSessions.js";
import type * as polar from "../polar.js";
import type * as polarWebhook from "../polarWebhook.js";
import type * as presence from "../presence.js";
import type * as strokes from "../strokes.js";
import type * as tokens from "../tokens.js";
import type * as userPrompts from "../userPrompts.js";
import type * as users from "../users.js";
import type * as viewerAcks from "../viewerAcks.js";
import type * as webrtc from "../webrtc.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aiGeneration: typeof aiGeneration;
  auth: typeof auth;
  backgroundRemoval: typeof backgroundRemoval;
  crons: typeof crons;
  geminiGeneration: typeof geminiGeneration;
  http: typeof http;
  imageMerger: typeof imageMerger;
  images: typeof images;
  layers: typeof layers;
  liveStrokes: typeof liveStrokes;
  "migrations/addDefaultPaintLayers": typeof migrations_addDefaultPaintLayers;
  "migrations/addInitialTokensToUsers": typeof migrations_addInitialTokensToUsers;
  "migrations/normalizeLayerOrders": typeof migrations_normalizeLayerOrders;
  paintLayer: typeof paintLayer;
  paintLayers: typeof paintLayers;
  paintingSessions: typeof paintingSessions;
  polar: typeof polar;
  polarWebhook: typeof polarWebhook;
  presence: typeof presence;
  strokes: typeof strokes;
  tokens: typeof tokens;
  userPrompts: typeof userPrompts;
  users: typeof users;
  viewerAcks: typeof viewerAcks;
  webrtc: typeof webrtc;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
