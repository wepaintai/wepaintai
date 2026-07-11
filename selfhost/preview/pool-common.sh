#!/usr/bin/env bash

set -euo pipefail

PREVIEW_ROOT="${PREVIEW_ROOT:-$HOME/apps/wepaintai-previews}"
PREVIEW_CONFIG="${PREVIEW_CONFIG:-$PREVIEW_ROOT/config.env}"
PREVIEW_POOL_SIZE="${PREVIEW_POOL_SIZE:-3}"

if [ -f "$PREVIEW_CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PREVIEW_CONFIG"
  set +a
fi

case "$PREVIEW_POOL_SIZE" in
  ''|*[!0-9]*) echo "PREVIEW_POOL_SIZE must be numeric" >&2; exit 1 ;;
esac
if [ "$PREVIEW_POOL_SIZE" -lt 1 ] || [ "$PREVIEW_POOL_SIZE" -gt 8 ]; then
  echo "PREVIEW_POOL_SIZE must be between 1 and 8" >&2
  exit 1
fi

preview_validate_pr() {
  case "${1:-}" in
    ''|*[!0-9]*) echo "PR number must be numeric" >&2; return 1 ;;
  esac
}

preview_slot_dir() {
  printf '%s/slots/slot-%s' "$PREVIEW_ROOT" "$1"
}

preview_slot_owner() {
  local owner_file
  owner_file="$(preview_slot_dir "$1")/owner"
  [ -f "$owner_file" ] && tr -d '[:space:]' < "$owner_file"
}

preview_api_port() {
  printf '%s' "$((4300 + ($1 - 1) * 2))"
}

preview_site_port() {
  printf '%s' "$((4301 + ($1 - 1) * 2))"
}

preview_acquire_lock() {
  local lock_dir attempts owner_pid
  lock_dir="$PREVIEW_ROOT/locks/pool.lock"
  mkdir -p "$PREVIEW_ROOT/locks"
  attempts=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    owner_pid=""
    [ -f "$lock_dir/pid" ] && owner_pid="$(tr -d '[:space:]' < "$lock_dir/pid")"
    if [ -n "$owner_pid" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo "Timed out waiting for preview pool lock" >&2
      return 1
    fi
    sleep 1
  done
  printf '%s\n' "$$" > "$lock_dir/pid"
}

preview_release_lock() {
  rm -rf "$PREVIEW_ROOT/locks/pool.lock"
}

preview_reload_caddy() {
  caddy reload --config "$PREVIEW_ROOT/Caddyfile" --adapter caddyfile
}
