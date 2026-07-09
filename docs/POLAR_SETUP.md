# Polar Integration Setup Guide

## Prerequisites

- A Polar account (https://polar.sh for production, https://sandbox.polar.sh for testing)
- A Polar organization created
- Access to your Convex dashboard

## Step 1: Create a Product in Polar

1. Log in to your Polar dashboard
2. Navigate to Products
3. Create two products:

   **Product 1:**
   - Name: "50 Token Pack"
   - Price: $4.99
   - Type: One-time purchase
   - Description: "50 tokens for AI image generation"

   **Product 2:**
   - Name: "125 Token Pack"
   - Price: $9.99
   - Type: One-time purchase
   - Description: "125 tokens for AI image generation"

## Step 2: Set Up Webhook

1. In Polar dashboard, go to Settings → Webhooks
2. Create a new webhook:
   - URL: `https://actions.wepaint.ai/webhooks/polar`
   - Events: Select `checkout.created` and `checkout.updated`
3. Copy the webhook secret that Polar provides

## Step 3: Configure Environment Variables

### In Convex Dashboard (https://dashboard.convex.dev):

1. Go to Settings → Environment Variables
2. Add the following variables:
   - `POLAR_API_KEY`: Your Polar API key (from Polar dashboard → Settings → API)
   - `POLAR_WEBHOOK_SECRET`: The webhook secret from Step 2
   - `POLAR_PRODUCT_ID_50`: Product ID for the $4.99 / 50-token product
   - `POLAR_PRODUCT_ID_125`: Product ID for the $9.99 / 125-token product
   - `POLAR_API_BASE_URL`: (Optional) API base URL
     - For sandbox (default): Leave empty or set to `https://sandbox-api.polar.sh`
     - For production: Set to `https://api.polar.sh`
   - `SITE_URL`: The application origin used for checkout success and return URLs

Product IDs and the Polar API key belong only in the Convex deployment
environment. Do not use `VITE_` variables for them. The server maps the public
package keys `50_tokens` and `125_tokens` to those product IDs and to fixed
grants of 50 and 125 tokens, expected prices of 499 and 999 cents, and `usd`.
The corresponding Polar products must use those exact one-time prices and
currency. Discount codes are disabled for these checkout sessions.

## Step 4: Deploy

1. Deploy your Convex functions:

   ```bash
   npx convex deploy
   ```

2. Run the migration to add tokens to existing users:
   ```bash
   npx convex run migrations/addInitialTokensToUsers:addInitialTokensToUsers
   ```

## Testing

1. Create a test account in your app
2. Check that you have 10 initial tokens
3. Try to generate an AI image (costs 1 token)
4. Click "Buy more" to purchase tokens
5. Complete the Polar checkout
6. Verify tokens are credited to your account

## Webhook Security

The webhook handler verifies signatures to ensure requests are from Polar:

- In production (when `POLAR_WEBHOOK_SECRET` is set), all webhook requests are verified
- Invalid signatures return a 401 Unauthorized response
- The signature is verified using HMAC-SHA256

## Troubleshooting

### Webhook not receiving events

- Check the webhook URL is correct: `https://actions.wepaint.ai/webhooks/polar`
- Verify the webhook is active in Polar dashboard
- Check Convex logs for any errors

### Tokens not credited after purchase

- Check Convex logs for webhook errors
- Verify the `POLAR_WEBHOOK_SECRET` is set correctly
- Verify the completed checkout product, amount, and currency match the selected package
- Verify Polar preserved the checkout `external_customer_id` set by the server

### Signature verification failing

- Make sure you copied the webhook secret correctly (no extra spaces)
- The secret should be set in Convex environment variables, not in `.env.local`
- Check that the webhook signature header name matches what Polar sends

## Sandbox Testing Setup

For development and testing, you can use Polar's sandbox environment:

### Step 1: Create Sandbox Account

1. Go to https://sandbox.polar.sh/start
2. Create a new account (separate from production)
3. Create a new organization for testing

### Step 2: Create Test Products

1. In sandbox dashboard, create the same product structure:

   **Product 1:**
   - Name: "50 Token Pack"
   - Price: $4.99
   - Type: One-time purchase

   **Product 2:**
   - Name: "125 Token Pack"
   - Price: $9.99
   - Type: One-time purchase

### Step 3: Configure Sandbox Environment

1. In Convex Dashboard, set these environment variables for your development deployment:
   - `POLAR_API_KEY`: Your sandbox API key
   - `POLAR_WEBHOOK_SECRET`: Your sandbox webhook secret
   - `POLAR_PRODUCT_ID_50`: Your sandbox 50-token product ID
   - `POLAR_PRODUCT_ID_125`: Your sandbox 125-token product ID
   - `POLAR_API_BASE_URL`: `https://sandbox-api.polar.sh`
   - `SITE_URL`: Your local or development application origin

### Step 4: Test Payments

- Use Stripe test card: `4242 4242 4242 4242`
- Any future expiration date
- Any CVC code
- Subscriptions in sandbox are automatically canceled after 90 days

### Switching Between Environments

To switch between sandbox and production:

1. Update the Convex environment variables
2. Ensure you're using the correct API keys and webhook secrets
3. The `POLAR_API_BASE_URL` determines which environment is used
