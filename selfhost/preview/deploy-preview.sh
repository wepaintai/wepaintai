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

# Replace any previous instance of this PR's preview. Each preview runs as
# a launchd agent (like prod's com.wepaintai.app): a plain background
# process would be killed by the runner's orphan-process cleanup when the
# job ends, and launchd also restarts previews after a mini reboot.
LABEL="com.wepaintai.preview.pr-$PR"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
mkdir -p "$DEST"
rsync -a --delete .output/ "$DEST/output/"

NODE_BIN="$(command -v node)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$DEST/output/server/index.mjs</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key><string>$PORT</string>
		<key>HOST</key><string>127.0.0.1</string>
	</dict>
	<key>WorkingDirectory</key><string>$DEST</string>
	<key>StandardOutPath</key><string>$ROOT/logs/pr-$PR.log</string>
	<key>StandardErrorPath</key><string>$ROOT/logs/pr-$PR.log</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

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
