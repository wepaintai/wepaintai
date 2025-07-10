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
import type * as crons from "../crons.js";
import type * as http from "../http.js";
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
import type * as users from "../users.js";
import type * as viewerAcks from "../viewerAcks.js";
import type * as webrtc from "../webrtc.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  aiGeneration: typeof aiGeneration;
  auth: typeof auth;
  crons: typeof crons;
  http: typeof http;
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
  users: typeof users;
  viewerAcks: typeof viewerAcks;
  webrtc: typeof webrtc;
}>;
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

export declare const components: {};
