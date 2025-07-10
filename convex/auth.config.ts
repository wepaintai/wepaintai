export default {
  providers: [
    {
      domain: process.env.CLERK_ISSUER_URL ?? "https://coherent-bobcat-42.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};