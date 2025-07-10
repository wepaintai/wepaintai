# Polar Integration Setup Guide

## Prerequisites
- A Polar account (https://polar.sh)
- A Polar organization created
- Access to your Convex dashboard

## Step 1: Create a Product in Polar

1. Log in to your Polar dashboard
2. Navigate to Products
3. Create a new product:
   - Name: "100 Token Pack"
   - Price: $9.99
   - Type: One-time purchase
   - Description: "100 tokens for AI image generation"

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

### In your `.env.local` file (for local development):
```env
VITE_POLAR_PRODUCT_ID=prod_xxxxx  # Your product ID from Polar
VITE_APP_URL=https://dev.wepaint.ai  # Your app URL
```

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
- Ensure the product metadata includes `userId` and `tokens`

### Signature verification failing
- Make sure you copied the webhook secret correctly (no extra spaces)
- The secret should be set in Convex environment variables, not in `.env.local`
- Check that the webhook signature header name matches what Polar sends