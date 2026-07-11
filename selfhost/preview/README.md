# Full-stack PR previews

Every open same-repository pull request can receive an isolated preview at
`https://preview-pr-<N>.wepaint.ai`. A preview slot runs the PR branch's:

- TanStack Start frontend;
- Convex functions, schema, database, and file storage;
- Better Auth users and sessions; and
- small synthetic seed dataset.

No preview reads or writes the production Convex deployment. Preview data is
disposable and is removed when the PR closes.

## Pool architecture

The Mac mini has a bounded pool of fixed Convex slots. The default pool size is
three and is configurable in the machine-local `config.env`. A PR keeps its
slot across pushes so schema changes and migrations are exercised against its
existing preview data. The slot is reset before assignment to another PR.

| Resource | Slot 1 example |
|---|---|
| Frontend | `preview-pr-<N>.wepaint.ai` → launchd node process |
| Convex API/WebSocket | `preview-api-1.wepaint.ai` → `127.0.0.1:4300` |
| Convex HTTP actions | `preview-site-1.wepaint.ai` → `127.0.0.1:4301` |
| Google callback | `preview-auth-1.wepaint.ai/api/auth/callback/google` |
| Container | `wepaintai-preview-slot-1` |
| Persistent data while assigned | `~/apps/wepaintai-previews/slots/slot-1/data` |

Caddy receives all wildcard `*.wepaint.ai` traffic on port 3299 and routes the
frontend plus the fixed slot hosts. The existing Cloudflare wildcard tunnel
and DNS records require no per-PR changes.

When every slot is occupied, the workflow records the PR in a FIFO queue and
posts a waiting comment. Closing a PR releases its slot and dispatches the
oldest queued preview automatically.

## One-time setup

On the mini, from the production checkout:

```bash
cd ~/apps/wepaintai
selfhost/preview/setup-pool.sh
chmod 600 ~/apps/wepaintai-previews/config.env
```

Edit `~/apps/wepaintai-previews/config.env` using
[`config.example.env`](config.example.env) as the reference. Use only
preview-scoped, budget-limited credentials because same-repository PR build
code executes on the self-hosted runner.

Create a Google OAuth web client for previews and register one exact callback
per enabled slot:

```text
https://preview-auth-1.wepaint.ai/api/auth/callback/google
https://preview-auth-2.wepaint.ai/api/auth/callback/google
https://preview-auth-3.wepaint.ai/api/auth/callback/google
```

Google does not allow wildcard redirect URIs. Better Auth runs its
cross-domain one-time-token handoff only when `PREVIEW_URL` is present in an
isolated preview backend. Production keeps its normal host-only OAuth flow.

If Polar checkout testing is enabled, configure sandbox credentials/products
and register each `preview-site-<slot>.wepaint.ai/webhooks/polar` endpoint.
AI provider credentials should use separate preview budgets or quotas.

## Deployment lifecycle

[`deploy-preview.yml`](../../.github/workflows/deploy-preview.yml) calls
[`deploy-preview.sh`](deploy-preview.sh), which:

1. atomically allocates or reuses a slot;
2. starts a resource-limited Convex container using the exact image currently
   running in production unless a pinned preview image is configured;
3. sets preview-only backend environment variables;
4. deploys the PR's Convex schema and functions;
5. seeds representative users, tokens, sessions, layers, and strokes only on
   first allocation;
6. builds the frontend against the slot URLs;
7. starts the PR launchd process and publishes Caddy routes; and
8. verifies the public frontend, API, and HTTP-action health endpoints.

[`cleanup-preview.yml`](../../.github/workflows/cleanup-preview.yml) invokes
the installed [`remove-preview.sh`](remove-preview.sh) without checking out PR
code. It stops the frontend and backend, removes the slot data and routes, then
starts the oldest queued preview.

## Capacity and Convex export constraint

On 2026-07-10 the production backend measured about 450–470 MiB after a clean
restart. A single file-storage snapshot export retained an additional
430–550 MiB of anonymous memory indefinitely. This matches
`get-convex/convex-backend#435`; reducing export concurrency lowered peak
memory but did not fix retention.

Preview containers therefore:

- have a default 768 MiB memory limit and 1.5 CPU limit;
- never run snapshot exports;
- seed only small representative files/data; and
- are destroyed completely when their PR releases the slot.

Production's nightly backup script restarts only the Convex backend after a
successful downloaded export to reclaim retained memory. The upstream bug also
leaves large server-side export objects, so disk usage must be monitored and
the Convex image upgraded when a supported cleanup/fix becomes available.
Never delete files directly inside the production Convex volume.

## Operations

```bash
# Slot owners and queued PRs
for f in ~/apps/wepaintai-previews/slots/slot-*/owner; do
  [ -f "$f" ] && echo "$f: $(cat "$f")"
done
ls -lt ~/apps/wepaintai-previews/queue

# Container resource use
docker stats --no-stream 'wepaintai-preview-slot-*'

# Frontend processes and logs
launchctl list | grep com.wepaintai.preview
tail -100 ~/apps/wepaintai-previews/logs/pr-<N>.log

# Manual teardown; queued work is normally dispatched by the cleanup workflow
~/apps/wepaintai-previews/bin/remove-preview.sh <N>
```

Do not increase `PREVIEW_POOL_SIZE` without measuring Docker's configured
memory, host disk space, production backup peaks, and a representative preview
under AI/image workloads.
## Security invariants

- Fork PRs never execute on the mini.
- Manual dispatch verifies that the PR is open and belongs to this repository.
- Production secrets are never copied into a preview build.
- Preview containers bind only to loopback; public access goes through the
  existing tunnel and Caddy routes.
- Each preview trusts only its exact `preview-pr-<N>.wepaint.ai` origin.
- Session cookies remain host-only; production sessions are not shared with
  preview subdomains.
- Slot data and secrets are mode-restricted machine-local files and are
  deleted on release.
