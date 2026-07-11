import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { handlePolarWebhook } from "./polarWebhook";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// Better Auth routes (/api/auth/*), reached via the TanStack Start proxy
authComponent.registerRoutes(http, createAuth);

// Add a simple health check endpoint
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("OK", { status: 200 });
  }),
});

// Best-effort presence cleanup fired via navigator.sendBeacon on pagehide.
// sendBeacon posts as a "simple" request (text/plain), so no CORS preflight
// is needed and the response is never read — always answer 200.
http.route({
  path: "/presence/leave",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = JSON.parse(await request.text());
      if (typeof body?.sessionId === "string") {
        await ctx.runMutation(internal.presence.beaconLeave, {
          sessionId: body.sessionId,
          userId: typeof body.userId === "string" ? body.userId : undefined,
          guestId: typeof body.guestId === "string" ? body.guestId : undefined,
        });
      }
    } catch {
      // Malformed beacon payloads are ignored; this endpoint is best-effort.
    }
    return new Response(null, { status: 200 });
  }),
});

// Polar webhook endpoint
http.route({
  path: "/webhooks/polar",
  method: "POST",
  handler: handlePolarWebhook,
});

export default http;