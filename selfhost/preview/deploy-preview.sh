#!/usr/bin/env bash
# Build and serve a PR preview on the Mac mini.
#
# Run by .github/workflows/deploy-preview.yml on the mini's self-hosted
# runner (user claw), from the PR checkout. The preview is the production
# frontend build of the PR branch, served at
# https://preview-pr-<N>.wepaint.ai and pointed at the LIVE production
# Convex backend (same .env.production as prod). Nothing under convex/ is
# deployed — backend changes in a PR are not reflected in its preview.
#
# Routing: Cloudflare Tunnel wildcard (*.wepaint.ai -> :3299) -> Caddy
# (~/apps/wepaintai-previews/Caddyfile) -> per-PR node server.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

PR="${1:?usage: deploy-preview.sh <pr-number>}"
case "$PR" in *[!0-9]*) echo "PR number must be numeric" >&2; exit 1 ;; esac

ROOT="$HOME/apps/wepaintai-previews"
DEST="$ROOT/prs/pr-$PR"
PORT=$((3300 + PR % 700))
HOST_NAME="preview-pr-$PR.wepaint.ai"
PROD_ENV="$HOME/apps/wepaintai/.env.production"

mkdir -p "$ROOT/prs" "$ROOT/caddy" "$ROOT/logs" "$ROOT/bin"

# Same frontend env as production; the preview differs from prod only by
# the branch's code. (VITE_ vars are baked into the build.)
cp "$PROD_ENV" .env.production

corepack pnpm install
corepack pnpm build

# Keep a current copy of the remover where the cleanup workflow (which
# deliberately checks nothing out) can find it.
cp "$(cd "$(dirname "$0")" && pwd)/remove-preview.sh" "$ROOT/bin/remove-preview.sh"
chmod +x "$ROOT/bin/remove-preview.sh"

# Replace any previous instance of this PR's preview.
if [ -f "$DEST/pid" ]; then
  kill "$(cat "$DEST/pid")" 2>/dev/null || true
  sleep 1
fi
mkdir -p "$DEST"
rsync -a --delete .output/ "$DEST/output/"

PORT="$PORT" HOST=127.0.0.1 nohup node "$DEST/output/server/index.mjs" \
  >> "$ROOT/logs/pr-$PR.log" 2>&1 &
echo $! > "$DEST/pid"
disown

cat > "$ROOT/caddy/pr-$PR.caddy" <<EOF
@pr$PR host $HOST_NAME
handle @pr$PR {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
caddy reload --config "$ROOT/Caddyfile" --adapter caddyfile

ok=""
for _ in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "preview server failed to start; log tail:" >&2
  tail -30 "$ROOT/logs/pr-$PR.log" >&2
  exit 1
fi
echo "preview for PR #$PR serving on :$PORT -> https://$HOST_NAME/"
