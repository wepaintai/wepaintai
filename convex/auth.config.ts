export default {
  providers: [
    {
      domain: process.env.CLERK_FRONTEND_API_URL ?? "https://coherent-bobcat-42.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};