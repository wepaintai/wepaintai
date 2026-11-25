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
| Frontend | `preview-pr-<N>.wepaint.ai` → launchd node process on `127.0.0.1:3301` (`3300 + slot`) |
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

> **Port scheme change:** frontend ports used to be `3300 + PR % 700` and are
> now `3300 + slot`. Previews that were already running keep their old port
> (and their old Caddy route, which still works) until they are redeployed.
> Redeploy every running preview after this change rolls out (push to the PR
> or re-run "Deploy PR preview" with its number). A redeploy and
> `remove-preview.sh` both key off the launchd label and Caddy file, not the
> port, so they stop the old-port process automatically; the deploy also
> refuses to start if something else still listens on the slot's port.

## One-time setup

On the mini, from the production checkout (which tracks `main`):

```bash
cd ~/apps/wepaintai
selfhost/preview/setup-pool.sh
chmod 600 ~/apps/wepaintai-previews/config.env
```

`setup-pool.sh` installs `pool-common.sh`, `slot-compose.yml` and
`remove-preview.sh` into `~/apps/wepaintai-previews/bin/` for manual use.
The workflows never execute those copies; every deploy and cleanup verifies
their SHA-256 against the trusted `main` checkout and reinstalls any mismatch
with a `Preview host helper mismatch` warning annotation. Treat an unexpected
warning as a sign of tampering and audit the mini.

In the GitHub repository settings, create the `preview` environment
(Settings → Environments) and add required reviewers so each preview deploy
waits for a maintainer's approval. Both `pull_request_target` and the
queue's `workflow_dispatch` runs execute on `main`, so the environment's
deployment-branch rule can be "All branches" or restricted to `main`.

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

[`deploy-preview.yml`](../../.github/workflows/deploy-preview.yml) runs on
`pull_request_target` (and `workflow_dispatch` from the queue), so the
workflow file itself always comes from `main`. It verifies the PR, checks out
`main` into `trusted/` and the verified PR head SHA into `pr/` (neither
checkout keeps the token), then runs
`trusted/selfhost/preview/deploy-preview.sh <N> pr/ <sha>`. Changes a PR makes
to the workflow or to `selfhost/preview/*` therefore only take effect for
previews after they merge. [`deploy-preview.sh`](deploy-preview.sh):

1. verifies `~/apps/wepaintai-previews/bin/*` against the trusted copies;
1. atomically allocates or reuses a slot;
2. starts a resource-limited Convex container using the exact image currently
   running in production unless a pinned preview image is configured;
3. sets preview-only backend environment variables;
4. installs the PR's dependencies with `pnpm install --frozen-lockfile
   --ignore-scripts` and deploys its Convex schema and functions;
5. seeds representative users, tokens, sessions, layers, and strokes only on
   first allocation;
6. builds the frontend against the slot URLs;
7. starts the PR launchd process and publishes Caddy routes; and
8. verifies the public frontend, API, and HTTP-action health endpoints.

[`cleanup-preview.yml`](../../.github/workflows/cleanup-preview.yml) checks
out `main` and runs [`remove-preview.sh`](remove-preview.sh) from that trusted
checkout without checking out PR code. It stops the frontend and backend,
removes the slot data and routes, then starts the oldest queued preview.

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

# Manual teardown from the trusted production checkout; queued work is
# normally dispatched by the cleanup workflow
~/apps/wepaintai/selfhost/preview/remove-preview.sh <N>
```

Do not increase `PREVIEW_POOL_SIZE` without measuring Docker's configured
memory, host disk space, production backup peaks, and a representative preview
under AI/image workloads.

## Security invariants

What the design guarantees:

- The deploy and cleanup workflow files always come from `main`
  (`pull_request_target`, `workflow_dispatch`); a PR cannot change their
  guards, the `preview` environment gate, or which scripts run.
- Trusted scripts (`deploy-preview.sh`, `pool-common.sh`, `slot-compose.yml`,
  `remove-preview.sh`) run only from a fresh `main` checkout. The PR head is
  checked out separately, pinned to the SHA verified through the API, and
  passed to them as data.
- Neither checkout persists the `GITHUB_TOKEN`; the token is only given to the
  steps that call the GitHub API, never to the build.
- `~/apps/wepaintai-previews/bin/*` is never sourced or executed by a
  workflow. Its contents are checksum-verified against `main` on every deploy
  and cleanup and reinstalled on mismatch.
- Dependencies are installed with `--ignore-scripts`, so package lifecycle
  scripts do not run.
- The deploy job only runs for open same-repository PRs (the head repo and
  author are re-checked through the API) and never for `dependabot[bot]`;
  manual dispatch validates that `PR` is strictly numeric.
- Production secrets are never copied into a preview build, and preview Polar
  configuration rejects non-sandbox API URLs.
- Preview containers bind only to loopback; public access goes through the
  existing tunnel and Caddy routes.
- Each preview trusts only its exact `preview-pr-<N>.wepaint.ai` origin.
- Session cookies remain host-only; production sessions are not shared with
  preview subdomains.
- Slot data and secrets are mode-restricted machine-local files and are
  deleted on release.

What it does **not** guarantee (residual risk, as of this writing):

- **Building a PR executes PR code on the mini.** `vite build`, the Vite and
  Convex config files, and Convex bundling all run code from the PR as the
  runner's OS user. That code can read or modify anything that user can:
  today the runner runs as the production user, whose home holds
  `~/apps/wepaintai/.env*`, `~/Backups/`, `~/.cloudflared/`, the Docker
  socket, the preview pool (`config.env` is sourced by the scripts), and the
  runner's own work directory. A malicious build could plant code that a
  later run or a manual operation executes. Only collaborators with write
  access can open same-repository PRs, and the `preview` environment's
  required reviewers are the approval point; review the diff before approving.
- **Fork PRs are not fully excluded.** This repository is public. The guards
  above stop *this* workflow from deploying fork PRs, but a fork PR can add its
  own workflow file targeting `runs-on: [self-hosted, mini]`. GitHub runs it
  once a maintainer clicks "Approve and run" (the repository requires approval
  for all outside contributors). **Never approve workflow runs for fork PRs**
  until the runner is restricted as below.

Remaining hardening that cannot be done from this repository (needs GitHub
org-admin rights or `sudo` on the mini):

1. Re-register the `mini` runner in an **organization runner group** (it is
   currently registered at the repository level) and restrict the group to
   *selected workflows*:
   `wepaintai/wepaintai/.github/workflows/deploy-preview.yml@refs/heads/main`
   and `.../cleanup-preview.yml@refs/heads/main`. Because both workflows now
   run from `main` (`pull_request_target`, `workflow_dispatch`), that
   restriction should leave previews working while refusing any other
   workflow file (including a fork's) on the mini. Confirm the exact
   workflow-ref format GitHub expects when configuring the group, then open a
   test PR and check that its preview still deploys.
2. Run the runner as a **dedicated unprivileged macOS user**, separate from
   the production user, with no read access to `~/apps/wepaintai/.env*`,
   `~/Backups/`, `~/.cloudflared/`, or the production Docker context.
3. Better still, move preview builds into an **ephemeral VM or container**
   that is destroyed after each run, so no PR can persist anything.
