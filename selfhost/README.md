# Self-hosting wepaintai on the Mac mini

Everything runs locally: the TanStack Start app as a launchd service, the
Convex backend + dashboard in Docker, exposed publicly via Cloudflare Tunnel.
External SaaS that remains: Replicate/Gemini (AI generation), Polar (payments).

```
Internet ──▶ Cloudflare Tunnel ──▶ app.YOUR_DOMAIN         → localhost:3000 (node server)
                                 ├▶ convex.YOUR_DOMAIN      → localhost:3210 (Convex API/WS)
                                 └▶ convex-site.YOUR_DOMAIN → localhost:3211 (HTTP actions/webhooks)
LAN only:                           localhost:6791          (Convex dashboard)
```

> **Repo location on the mini**: clone to `~/apps/wepaintai`, NOT under
> `~/Documents` — macOS TCC blocks launchd agents from reading
> Documents/Desktop/Downloads, and the app service will fail with exit 127.
> Set `WEPAINTAI_DIR` in the plists' `EnvironmentVariables` accordingly.

## 1. Prerequisites

- Docker Desktop or OrbStack running
- Node via nvm, pnpm via corepack (already set up if you can `pnpm build`)
- A domain on Cloudflare
- `brew install cloudflared`

## 2. Convex backend (Docker)

```bash
cd selfhost
cp .env.example .env            # set INSTANCE_SECRET: openssl rand -hex 32
docker compose up -d
docker compose exec backend ./generate_admin_key.sh   # save this key!
```

Then create `selfhost/.env.convex` from `.env.convex.example` with the URL and
admin key. The dashboard is at http://localhost:6791 (login with the admin key).

## 3. Deploy the Convex functions

```bash
pnpm deploy:convex
```

Set backend environment variables (dashboard → Settings → Environment
Variables, or `pnpm exec convex env set --env-file selfhost/.env.convex KEY value`):

- `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `REPLICATE_TIMEOUT_SECONDS`
- `GEMINI_API_KEY`
- `POLAR_API_KEY`, `POLAR_WEBHOOK_SECRET`, `POLAR_API_BASE_URL`

## 4. Import the production backup

One-time migration of content data (sessions, strokes, images, file storage):

```bash
pnpm exec convex import --env-file selfhost/.env.convex \
  ~/Backups/wepaintai/graceful-blackbird-369-2026-07-07.zip
```

## 5. Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create wepaintai
cp selfhost/cloudflared/config.example.yml ~/.cloudflared/config.yml
# edit: set your domain and the credentials-file tunnel ID
cloudflared tunnel route dns wepaintai app.YOUR_DOMAIN
cloudflared tunnel route dns wepaintai convex.YOUR_DOMAIN
cloudflared tunnel route dns wepaintai convex-site.YOUR_DOMAIN
sudo cloudflared service install    # persistent launchd daemon
```

Then update `selfhost/.env` so the backend advertises its public URLs
(`CONVEX_CLOUD_ORIGIN=https://convex.YOUR_DOMAIN`,
`CONVEX_SITE_ORIGIN=https://convex-site.YOUR_DOMAIN`) and
`docker compose up -d` again to apply.

## 6. Build and run the app

Create `.env.production` in the repo root (gitignored):

```
VITE_CONVEX_URL=https://convex.YOUR_DOMAIN
# plus auth keys — see auth migration notes
```

```bash
pnpm build
cp selfhost/launchd/com.wepaintai.app.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wepaintai.app.plist
```

Logs: `/tmp/wepaintai-app.log`. Redeploy after changes:
`pnpm build && launchctl kickstart -k gui/$(id -u)/com.wepaintai.app`.

## 7. Nightly backups

```bash
cp selfhost/launchd/com.wepaintai.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wepaintai.backup.plist
```

Exports (tables + file storage) land in `~/Backups/wepaintai/selfhosted/`
at 03:30 nightly, keeping the last 14. Test manually: `selfhost/bin/backup.sh`.
Keep an offsite copy of this directory (iCloud/Backblaze/etc.).

## 8. Webhooks

Point the Polar webhook at `https://convex-site.YOUR_DOMAIN/webhooks/polar`
(defined in convex/http.ts) in the Polar dashboard.
Health check endpoint: `https://convex-site.YOUR_DOMAIN/health`.

## Upgrading Convex

```bash
cd selfhost
docker compose pull && docker compose up -d
```

Take a manual backup first. Pin image tags in docker-compose.yml once stable.
