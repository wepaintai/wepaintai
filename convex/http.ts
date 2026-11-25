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
      const raw = await request.text();
      if (raw.length > 2048) return new Response(null, { status: 200 });
      const body = JSON.parse(raw);
      const isShortString = (value: unknown): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= 256;
      // The leave token proves the beacon comes from the presence owner (it
      // is returned only to that client by updatePresence). Payloads without
      // one, including old clients' {userId, guestId}, are ignored.
      if (
        isShortString(body?.sessionId) &&
        isShortString(body?.presenceId) &&
        isShortString(body?.leaveToken)
      ) {
        await ctx.runMutation(internal.presence.beaconLeave, {
          sessionId: body.sessionId,
          presenceId: body.presenceId,
          leaveToken: body.leaveToken,
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