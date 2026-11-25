#!/usr/bin/env bash

set -euo pipefail

PREVIEW_ROOT="${PREVIEW_ROOT:-$HOME/apps/wepaintai-previews}"
PREVIEW_CONFIG="${PREVIEW_CONFIG:-$PREVIEW_ROOT/config.env}"
PREVIEW_POOL_SIZE="${PREVIEW_POOL_SIZE:-3}"
PREVIEW_LOCK_TIMEOUT_SECONDS="${PREVIEW_LOCK_TIMEOUT_SECONDS:-45}"
# Helper files that setup-pool.sh installs under $PREVIEW_ROOT/bin for manual
# operations. Deploy/cleanup always run the copies from a trusted main checkout
# and only use this list to verify (and repair) the installed copies.
PREVIEW_BIN_FILES="pool-common.sh slot-compose.yml remove-preview.sh"

if [ -f "$PREVIEW_CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PREVIEW_CONFIG"
  set +a
fi

case "$PREVIEW_LOCK_TIMEOUT_SECONDS" in
  ''|*[!0-9]*) echo "PREVIEW_LOCK_TIMEOUT_SECONDS must be numeric" >&2; exit 1 ;;
esac

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
  local lock_dir attempts owner_pid stale_dir dir_mtime now
  lock_dir="$PREVIEW_ROOT/locks/pool.lock"
  mkdir -p "$PREVIEW_ROOT/locks"
  attempts=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    owner_pid=""
    [ -f "$lock_dir/pid" ] && owner_pid="$(tr -d '[:space:]' < "$lock_dir/pid" 2>/dev/null || true)"
    if [ -n "$owner_pid" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
      # Atomically claim the dead lock directory before removing it so two
      # concurrent waiters cannot delete a third waiter's newly acquired lock.
      stale_dir="$PREVIEW_ROOT/locks/pool.stale.$$.$RANDOM"
      if mv "$lock_dir" "$stale_dir" 2>/dev/null; then
        rm -rf "$stale_dir"
      fi
      continue
    fi
    if [ -z "$owner_pid" ]; then
      # Recover from a crash between `mkdir` and writing `pid` once > 5s old.
      # BSD stat first (the mini), then GNU stat (Linux CI). GNU `stat -f`
      # prints filesystem info before failing, so overwrite rather than append.
      dir_mtime="$(stat -f '%m' "$lock_dir" 2>/dev/null)" \
        || dir_mtime="$(stat -c '%Y' "$lock_dir" 2>/dev/null)" \
        || dir_mtime=0
      case "$dir_mtime" in ''|*[!0-9]*) dir_mtime=0 ;; esac
      now="$(date +%s)"
      if [ "$dir_mtime" -gt 0 ] && [ $((now - dir_mtime)) -gt 5 ]; then
        stale_dir="$PREVIEW_ROOT/locks/pool.stale.$$.$RANDOM"
        if mv "$lock_dir" "$stale_dir" 2>/dev/null; then
          rm -rf "$stale_dir"
        fi
        continue
      fi
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$PREVIEW_LOCK_TIMEOUT_SECONDS" ]; then
      echo "Timed out waiting for preview pool lock" >&2
      return 1
    fi
    sleep 1
  done
  printf '%s\n' "$$" > "$lock_dir/pid.tmp"
  mv "$lock_dir/pid.tmp" "$lock_dir/pid"
}

# Release the pool lock only if this process owns it. Never delete a lock with
# an empty or missing pid file: that is another process between its `mkdir`
# and its pid write (stale empty locks are recovered by preview_acquire_lock).
# Callers must install `trap preview_release_lock EXIT` only *after*
# preview_acquire_lock succeeds.
preview_release_lock() {
  local lock_dir owner_pid
  lock_dir="$PREVIEW_ROOT/locks/pool.lock"
  [ -d "$lock_dir" ] || return 0
  owner_pid="$(tr -d '[:space:]' < "$lock_dir/pid" 2>/dev/null || true)"
  if [ -n "$owner_pid" ] && [ "$owner_pid" = "$$" ]; then
    rm -rf "$lock_dir"
  fi
  return 0
}

preview_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    sha256sum "$1" | awk '{ print $1 }'
  fi
}

# Verify $PREVIEW_ROOT/bin/* against the trusted copies in <trusted-dir> (the
# main checkout the workflow runs from). Any missing or mismatched helper is
# reported loudly and atomically reinstalled from the trusted copy. Callers
# must never source or execute $PREVIEW_ROOT/bin/* themselves.
preview_sync_host_bin() {
  local trusted_dir bin_dir name trusted_sum installed_sum tmp mismatched
  trusted_dir="${1:?usage: preview_sync_host_bin <trusted-dir>}"
  bin_dir="$PREVIEW_ROOT/bin"
  mismatched=""
  mkdir -p "$bin_dir"
  if [ "$(cd "$trusted_dir" && pwd -P)" = "$(cd "$bin_dir" && pwd -P)" ]; then
    echo "preview_sync_host_bin: trusted dir must not be $bin_dir" >&2
    return 1
  fi
  for name in $PREVIEW_BIN_FILES; do
    trusted_sum="$(preview_sha256 "$trusted_dir/$name")"
    installed_sum=""
    if [ -f "$bin_dir/$name" ] && [ ! -L "$bin_dir/$name" ]; then
      installed_sum="$(preview_sha256 "$bin_dir/$name")"
    fi
    if [ "$installed_sum" = "$trusted_sum" ]; then
      continue
    fi
    mismatched="$mismatched $name"
    echo "::warning title=Preview host helper mismatch::$bin_dir/$name sha256=${installed_sum:-missing} does not match trusted main sha256=$trusted_sum; reinstalling from trusted checkout. Audit the mini if this was not an intentional upgrade." >&2
    tmp="$bin_dir/.$name.tmp.$$"
    rm -f "$tmp"
    cp "$trusted_dir/$name" "$tmp"
    case "$name" in *.sh) chmod 755 "$tmp" ;; *) chmod 644 "$tmp" ;; esac
    # mv would move *into* a planted directory or directory symlink, so drop
    # those first; otherwise rename(2) atomically replaces the regular file.
    if [ -L "$bin_dir/$name" ] || [ -d "$bin_dir/$name" ]; then
      rm -rf "${bin_dir:?}/$name"
    fi
    mv -f "$tmp" "$bin_dir/$name"
    if [ "$(preview_sha256 "$bin_dir/$name")" != "$trusted_sum" ]; then
      echo "Failed to reinstall $bin_dir/$name from trusted checkout" >&2
      return 1
    fi
  done
  if [ -n "$mismatched" ]; then
    echo "PREVIEW_BIN_REINSTALLED files=${mismatched# }" >&2
  fi
  return 0
}

preview_reload_caddy() {
  caddy reload --config "$PREVIEW_ROOT/Caddyfile" --adapter caddyfile
}
