#!/usr/bin/env bash
# Tear down a PR frontend and release its isolated Convex preview slot.
# Workflows run this from a trusted main checkout; setup-pool.sh also installs
# a copy under $PREVIEW_ROOT/bin for manual use. Either way it only uses the
# helpers next to itself.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=pool-common.sh
source "$SCRIPT_DIR/pool-common.sh"

PR="${1:?usage: remove-preview.sh <pr-number>}"
preview_validate_pr "$PR"

ROOT="$PREVIEW_ROOT"
DEST="$ROOT/prs/pr-$PR"

# When run from a trusted checkout (the cleanup workflow), also verify and
# repair the host-installed copies under $ROOT/bin.
mkdir -p "$ROOT/bin"
if [ "$SCRIPT_DIR" != "$(cd "$ROOT/bin" && pwd -P)" ]; then
  preview_sync_host_bin "$SCRIPT_DIR"
fi

LABEL="com.wepaintai.preview.pr-$PR"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$DEST"
rm -f "$ROOT/caddy/pr-$PR.caddy" "$ROOT/logs/pr-$PR.log" "$ROOT/queue/pr-$PR"

# Install the release trap only once the lock is ours.
preview_acquire_lock
trap 'preview_release_lock' EXIT
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
      -f "$SCRIPT_DIR/slot-compose.yml" \
      -p "wepaintai-preview-slot-$slot" down --remove-orphans \
      || docker rm -f "wepaintai-preview-slot-$slot" 2>/dev/null || true
  else
    docker rm -f "wepaintai-preview-slot-$slot" 2>/dev/null || true
  fi
  rm -rf "$slot_dir"
  rm -f "$ROOT/caddy/slot-$slot.caddy"
fi
preview_release_lock
trap - EXIT

preview_reload_caddy
echo "POOL_REMOVED pr=$PR slot=${slot:-none}"
