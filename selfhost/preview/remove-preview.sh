#!/usr/bin/env bash
# Tear down a PR frontend and release its isolated Convex preview slot.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pool-common.sh
source "$SCRIPT_DIR/pool-common.sh"

PR="${1:?usage: remove-preview.sh <pr-number>}"
preview_validate_pr "$PR"

ROOT="$PREVIEW_ROOT"
DEST="$ROOT/prs/pr-$PR"
LABEL="com.wepaintai.preview.pr-$PR"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$DEST"
rm -f "$ROOT/caddy/pr-$PR.caddy" "$ROOT/logs/pr-$PR.log" "$ROOT/queue/pr-$PR"

preview_acquire_lock
slot=""
for candidate in $(seq 1 "$PREVIEW_POOL_SIZE"); do
  owner="$(preview_slot_owner "$candidate" || true)"
  if [ "$owner" = "$PR" ]; then
    slot="$candidate"
    break
  fi
done

if [ -n "$slot" ]; then
  slot_dir="$(preview_slot_dir "$slot")"
  compose_env="$slot_dir/compose.env"
  if [ -f "$compose_env" ]; then
    docker compose --env-file "$compose_env" \
      -f "$ROOT/bin/slot-compose.yml" \
      -p "wepaintai-preview-slot-$slot" down --remove-orphans || true
  else
    docker rm -f "wepaintai-preview-slot-$slot" 2>/dev/null || true
  fi
  rm -rf "$slot_dir"
  rm -f "$ROOT/caddy/slot-$slot.caddy"
fi
preview_release_lock

preview_reload_caddy
echo "POOL_REMOVED pr=$PR slot=${slot:-none}"
