#!/usr/bin/env bash
# Tear down a PR preview on the Mac mini: stop the node server, delete the
# build and Caddy route. Run by .github/workflows/cleanup-preview.yml (via
# the copy deploy-preview.sh installs at ~/apps/wepaintai-previews/bin/),
# or manually: ./remove-preview.sh <pr-number>
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

PR="${1:?usage: remove-preview.sh <pr-number>}"
case "$PR" in *[!0-9]*) echo "PR number must be numeric" >&2; exit 1 ;; esac

ROOT="$HOME/apps/wepaintai-previews"
DEST="$ROOT/prs/pr-$PR"

if [ -f "$DEST/pid" ]; then
  kill "$(cat "$DEST/pid")" 2>/dev/null || true
fi
rm -rf "$DEST"
rm -f "$ROOT/caddy/pr-$PR.caddy" "$ROOT/logs/pr-$PR.log"
caddy reload --config "$ROOT/Caddyfile" --adapter caddyfile
echo "removed preview for PR #$PR"
