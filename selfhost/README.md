# Self-hosting wepaintai on the Mac mini

Everything runs locally: the TanStack Start app as a launchd service, the
Convex backend + dashboard in Docker, exposed publicly via Cloudflare Tunnel.
External SaaS that remains: Replicate/Gemini (AI generation), Polar (payments).

Full-stack PR previews use a separate bounded pool of disposable Convex
containers. See [`preview/README.md`](preview/README.md); previews must never
point at this production deployment.

```
Internet ──▶ Cloudflare Tunnel ──▶ app.YOUR_DOMAIN         → 127.0.0.1:3000 (node server)
                                 ├▶ convex.YOUR_DOMAIN      → 127.0.0.1:3210 (Convex API/WS)
                                 └▶ convex-site.YOUR_DOMAIN → 127.0.0.1:3211 (HTTP actions/webhooks)
Loopback only:                      127.0.0.1:6791          (Convex dashboard, via ssh -L)
```

Every service binds to `127.0.0.1` only (`start-app.sh` sets `HOST=127.0.0.1`;
Docker publishes on `CONVEX_BIND_HOST=127.0.0.1`), so the tunnel config must
target `127.0.0.1`, not `localhost` (which may resolve to `::1`). Nothing is
reachable from the LAN. After changing `~/.cloudflared/config.yml`, restart
cloudflared and verify `https://app.YOUR_DOMAIN/` and
`https://convex-site.YOUR_DOMAIN/health` respond.

> **Repo location on the mini**: clone to `~/apps/wepaintai`, NOT under
> `~/Documents` — macOS TCC blocks launchd agents from reading
> Documents/Desktop/Downloads, and the app service will fail with exit 127.
> Set `WEPAINTAI_DIR` in the plists' `EnvironmentVariables` accordingly.

## 1. Prerequisites

- Docker Desktop or OrbStack running, **and configured to start at login**.
  In Docker Desktop: Settings → General → enable "Start Docker Desktop when
  you sign in to your computer". Production was down for months because this
  was off (`AutoStart=false`) and Docker never came back after a reboot. The
  compose services use `restart: unless-stopped`, so they come back on their
  own once the Docker engine is running. After any reboot, check
  `docker ps` shows `selfhost-backend-1` healthy.
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
admin key. The dashboard is at http://127.0.0.1:6791 on the mini (login with the
admin key). It is bound to loopback only; from another machine, tunnel both the
dashboard and the API it talks to:

```bash
ssh -L 6791:127.0.0.1:6791 -L 3210:127.0.0.1:3210 <mini>
# then open http://127.0.0.1:6791 locally
```

The images are pinned by digest in `docker-compose.yml`
(`ghcr.io/convex/convex-backend`, `ghcr.io/convex/convex-dashboard`; the old
`ghcr.io/get-convex/*` paths now return 403).

## 3. Deploy the Convex functions

```bash
pnpm deploy:convex
```

Set backend environment variables (dashboard → Settings → Environment
Variables, or `pnpm exec convex env set --env-file selfhost/.env.convex KEY value`):

- `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION`, `REPLICATE_TIMEOUT_SECONDS`
- `GEMINI_API_KEY`
- `POLAR_API_KEY`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID_50`,
  `POLAR_PRODUCT_ID_125`, `POLAR_API_BASE_URL`

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
sed "s|/Users/YOUR_USER|$HOME|g" selfhost/launchd/com.wepaintai.app.plist \
  > ~/Library/LaunchAgents/com.wepaintai.app.plist
launchctl load ~/Library/LaunchAgents/com.wepaintai.app.plist
```

Logs: `/tmp/wepaintai-app.log`. Redeploy after changes:
`pnpm build && launchctl kickstart -k gui/$(id -u)/com.wepaintai.app`.

## 7. Nightly backups

```bash
sed "s|/Users/YOUR_USER|$HOME|g" selfhost/launchd/com.wepaintai.backup.plist \
  > ~/Library/LaunchAgents/com.wepaintai.backup.plist
launchctl load ~/Library/LaunchAgents/com.wepaintai.backup.plist
```

Exports (tables + file storage) land in `~/Backups/wepaintai/selfhosted/`
at 03:30 nightly, keeping the last 14. Test manually: `selfhost/bin/backup.sh`.
Keep an offsite copy of this directory (iCloud/Backblaze/etc.).

`backup.sh` defaults to the checkout at `~/apps/wepaintai` (override with
`WEPAINTAI_DIR`) and exits non-zero with a clear message if the checkout,
`selfhost/.env.convex`, or the installed Convex CLI (`node_modules/.bin/convex`,
from `corepack pnpm install --frozen-lockfile`) is missing.

**Backups must be checked, not assumed.** A launchd job that fails every night
is silent. At least weekly (and after every reboot or deploy):

```bash
ls -lt ~/Backups/wepaintai/selfhosted | head -3   # newest zip is from last night
tail -20 /tmp/wepaintai-backup.log                # ends with "Backup complete"
unzip -tq "$(ls -t ~/Backups/wepaintai/selfhosted/*.zip | head -1)"
```

## 8. Webhooks

Point the Polar webhook at `https://convex-site.YOUR_DOMAIN/webhooks/polar`
(defined in convex/http.ts) in the Polar dashboard.
Health check endpoint: `https://convex-site.YOUR_DOMAIN/health`.

## Upgrading Convex

Images are pinned by digest, so `docker compose pull` alone does nothing.
Take a manual backup first, then resolve the new digest and set it explicitly:

```bash
docker pull ghcr.io/convex/convex-backend:latest
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/convex/convex-backend:latest
# put the ghcr.io/convex/convex-backend@sha256:... value in selfhost/.env as
# CONVEX_BACKEND_IMAGE (same for the dashboard), then:
cd selfhost && docker compose up -d
```

Once validated, update the default digests in `docker-compose.yml`.
