# PR previews

Every open pull request (from a branch in this repo — not forks) gets a live
preview at **`https://preview-pr-<N>.wepaint.ai`**, redeployed on each push
and torn down when the PR closes. A sticky comment on the PR carries the URL.

## What a preview is (and isn't)

A preview is the **production frontend build of the PR branch** — built with
prod's `.env.production`, so it talks to the **live production Convex
backend** (`api.wepaint.ai`). It extends the existing mini deployment rather
than running a parallel stack. Consequences:

- Changes under `convex/` are **not** deployed anywhere. A PR that adds or
  changes backend functions previews against prod's currently-deployed
  functions (new function calls will error until merged + deployed).
- Guest painting works normally and writes real data to the prod database,
  exactly like a guest on the prod site.
- Google sign-in can't complete on a preview host (the OAuth redirect URI is
  pinned to `app.wepaint.ai`), so previews are effectively guest-mode.

## Moving parts

| Piece | Where |
|---|---|
| GitHub Actions runner (label `mini`) | mini, `~/actions-runner`, launchd `actions.runner.wepaintai-wepaintai.mini` |
| Deploy workflow | [.github/workflows/deploy-preview.yml](../../.github/workflows/deploy-preview.yml) — `pull_request` opened/reopened/synchronize |
| Cleanup workflow | [.github/workflows/cleanup-preview.yml](../../.github/workflows/cleanup-preview.yml) — `pull_request` closed |
| Build + serve script | [deploy-preview.sh](deploy-preview.sh) (run from the PR checkout on the mini) |
| Teardown script | [remove-preview.sh](remove-preview.sh) (deploy installs a copy at `~/apps/wepaintai-previews/bin/` so cleanup needs no checkout) |
| Per-PR node servers | mini, launchd agents `com.wepaintai.preview.pr-<N>` serving `~/apps/wepaintai-previews/prs/pr-<N>/` on port `3300 + (N % 700)`, logs in `~/apps/wepaintai-previews/logs/` |
| Hostname router | Caddy on `:3299` (`brew services`, config `~/apps/wepaintai-previews/Caddyfile`, per-PR snippets in `caddy/*.caddy`) |
| Public routing | Cloudflare Tunnel ingress rule `*.wepaint.ai → 127.0.0.1:3299` (in the shared `~/.cloudflared/config.yml`, after the exact prod hostnames) + wildcard DNS `*.wepaint.ai` CNAME to the tunnel |

## Security notes (public repo + self-hosted runner)

- Deploy/cleanup jobs are guarded with
  `github.event.pull_request.head.repo.full_name == github.repository`, so
  fork PRs never run on the mini.
- The repo Actions setting "approval for fork PR workflows" is set to
  **all outside collaborators** — fork workflow runs never start unapproved.
- Keep it that way, and never add mini-targeting workflows triggered by
  events fork authors control.

## Ops

```bash
# list running previews
ssh claw@claws-mac-mini.tailc81e10.ts.net 'launchctl list | grep com.wepaintai.preview'

# manually remove one
ssh claw@claws-mac-mini.tailc81e10.ts.net '~/apps/wepaintai-previews/bin/remove-preview.sh <N>'

# a preview's server log
ssh claw@claws-mac-mini.tailc81e10.ts.net 'tail -50 ~/apps/wepaintai-previews/logs/pr-<N>.log'
```

Previews run as launchd agents (a plain background process would be killed
by the runner's orphan-process cleanup at job end), so they survive crashes
and mini reboots. If a preview 404s, check Caddy (`launchctl list | grep
caddy`) and the tunnel (`pgrep -fl cloudflared`); a 502 means the node
agent is down (`tail` its log above).
