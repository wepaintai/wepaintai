---
name: deploy-mini
description: Deploy wepaintai to production (the self-hosted Mac mini serving wepaint.ai). Use this whenever the user asks to deploy, ship, release, push to prod, update production, restart the app, deploy Convex functions, set production env vars, check production status/logs, or roll anything out to the Mac mini / wepaint.ai — whether the session is running on the mini itself or on another machine. Also use it before answering questions about how production is deployed or why it might be down.
---

# Deploying wepaintai to the Mac mini

Production is fully self-hosted on the Mac mini (`claws-mac-mini`):
frontend as a launchd service on port 3000, Convex backend in Docker
(3210/3211), all exposed via an existing Cloudflare Tunnel.

| Public URL | Serves |
|---|---|
| https://app.wepaint.ai (+ apex) | app (node server, port 3000) |
| https://api.wepaint.ai | Convex API/WebSocket (docker, 3210) |
| https://site.wepaint.ai | Convex HTTP actions/webhooks (3211) |

## Am I on the mini or remote?

Check `whoami`/hostname. On the mini: user `claw`, repo at
`/Users/claw/apps/wepaintai`. From any other machine, run every command
through SSH over Tailscale:

```bash
ssh claw@claws-mac-mini.tailc81e10.ts.net '<command>'
```

Two constraints that will bite you if forgotten:

- **PATH**: non-interactive SSH shells get a minimal PATH. Prefix
  commands with `export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH`
  (docker lives in /usr/local/bin; node/pnpm/cloudflared/corepack in
  /opt/homebrew/bin). Use `corepack pnpm`, not bare `pnpm`, if pnpm is
  ever missing.
- **Repo location**: the repo must stay at `~/apps/wepaintai`. Do NOT
  move it under `~/Documents` — macOS TCC blocks launchd agents from
  reading Documents/Desktop/Downloads and the app service dies with
  exit 127.

Machine-local files that must never be overwritten or committed:
`.env.production` (frontend build vars), `selfhost/.env` (docker),
`selfhost/.env.convex` (deploy/admin credentials).

## Standard deploy (after merging to main)

Take a backup first if the change includes a schema migration or
anything data-touching: `selfhost/bin/backup.sh`.

```bash
ssh claw@claws-mac-mini.tailc81e10.ts.net 'export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH
  cd ~/apps/wepaintai
  git checkout -- convex/_generated   # discard local codegen churn or pull fails
  git pull
  corepack pnpm install               # cheap no-op if lockfile unchanged
  corepack pnpm deploy:convex         # backend functions + schema/indexes
  corepack pnpm build                 # bakes .env.production VITE_ vars
  launchctl kickstart -k gui/$(id -u)/com.wepaintai.app'
```

Backend-only change (convex/ dir): just `deploy:convex`, skip
build/kickstart — zero frontend downtime. Frontend-only change: skip
`deploy:convex`. When unsure, run both; each is idempotent.

Deploy from a branch only when the user explicitly wants unmerged code
in production (`git fetch && git checkout <branch>` first); note it so
main can be restored later.

## Verify (always do this after deploying)

```bash
curl -s -o /dev/null -w "app: %{http_code}\n"  https://app.wepaint.ai/
curl -s https://api.wepaint.ai/version          # expect 200 w/ body
curl -s https://site.wepaint.ai/health          # expect OK
```

A 502 from app.wepaint.ai means the node service is down — check
`/tmp/wepaintai-app.log` on the mini and `launchctl list | grep
wepaintai` (second column is the last exit code). 000/SSL errors point
at the tunnel: `pgrep -fl "cloudflared tunnel"`.

## Env var changes

- **Backend (secrets, API keys)** — takes effect immediately, no build:
  ```bash
  cd ~/apps/wepaintai && corepack pnpm exec convex env --env-file selfhost/.env.convex set KEY value
  ```
- **Frontend (VITE_*)** — edit `.env.production` in the repo root on
  the mini, then rebuild + kickstart (VITE_ vars are baked at build
  time; restarting alone does nothing).

## Infra changes (rarer)

- **Convex backend/docker**: edit `selfhost/.env` or the compose file,
  then `cd ~/apps/wepaintai/selfhost && docker compose up -d`. To
  upgrade Convex images: backup first, then `docker compose pull && up -d`.
- **Tunnel hostnames**: edit `~/.cloudflared/config.yml` (it is SHARED
  with events.vibetolaunch.com — never remove existing rules), then
  `pkill -f "cloudflared tunnel"`; the com.jasonevents.tunnel
  LaunchDaemon restarts it with the new config within seconds. New
  hostnames also need `cloudflared tunnel route dns --overwrite-dns
  ba58b754-173e-4652-878a-2f4762da9608 <hostname>` — the cert.pem on
  the mini is authorized for the wepaint.ai zone
  (cert-vibetolaunch.pem is the vibetolaunch.com one; point
  TUNNEL_ORIGIN_CERT at the right cert for the zone you're routing).
- **Convex dashboard**: http://localhost:6791 on the mini (or via
  Tailscale `ssh -L 6791:localhost:6791 ...`), login with the admin
  key from `selfhost/.env.convex`. Deliberately not tunnel-exposed.

## Recovery notes

- Nightly backups (03:30, 14 kept): `~/Backups/wepaintai/selfhosted/`
  on the mini. Restore: `corepack pnpm exec convex import --env-file
  selfhost/.env.convex <zip>` (add `--replace-all` over existing data).
- Full setup-from-scratch runbook: `selfhost/README.md`.
- DNS rollback (extreme case): wepaint.ai records live in Cloudflare;
  the tunnel CNAMEs can be repointed there.
