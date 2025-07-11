import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { handlePolarWebhook } from "./polarWebhook";

const http = httpRouter();

// Add a simple health check endpoint
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("OK", { status: 200 });
  }),
});

// Polar webhook endpoint
http.route({
  path: "/webhooks/polar",
  method: "POST",
  handler: handlePolarWebhook,
});

export default http;