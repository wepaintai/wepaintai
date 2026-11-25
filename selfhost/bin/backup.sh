#!/bin/zsh
# Nightly backup of the self-hosted Convex deployment.
# Exports all tables + file storage to a dated zip and prunes old ones.
# Requires selfhost/.env.convex with:
#   CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
#   CONVEX_SELF_HOSTED_ADMIN_KEY=<from generate_admin_key.sh>
set -euo pipefail

REPO_DIR="${WEPAINTAI_DIR:-$HOME/apps/wepaintai}"
BACKUP_DIR="${WEPAINTAI_BACKUP_DIR:-$HOME/Backups/wepaintai/selfhosted}"
KEEP=14

die() {
  print -u2 -- "backup.sh: ERROR: $*"
  exit 1
}

[ -d "$REPO_DIR" ] || die "repo checkout not found at $REPO_DIR (set WEPAINTAI_DIR)."
[ -f "$REPO_DIR/selfhost/.env.convex" ] \
  || die "$REPO_DIR/selfhost/.env.convex is missing (CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY)."
[ -x "$REPO_DIR/node_modules/.bin/convex" ] \
  || die "Convex CLI not installed in $REPO_DIR (node_modules/.bin/convex missing). Run: cd $REPO_DIR && corepack pnpm install --frozen-lockfile"

mkdir -p "$BACKUP_DIR"
cd "$REPO_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  setopt local_options null_glob
  nvm_bins=("$HOME/.nvm/versions/node"/*/bin)
  if (( ${#nvm_bins[@]} > 0 )); then
    NVM_NODE=$(printf '%s\n' "${nvm_bins[@]}" | sort -V | tail -1)
    [ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
  fi
fi

command -v node >/dev/null 2>&1 || die "node not found on PATH (Homebrew or nvm)."
command -v corepack >/dev/null 2>&1 || die "corepack not found on PATH (ships with node)."

STAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="$BACKUP_DIR/wepaintai-$STAMP.zip"
corepack pnpm exec convex export \
  --env-file "$REPO_DIR/selfhost/.env.convex" \
  --include-file-storage \
  --path "$BACKUP_FILE"

# Verify archive integrity before recycling the backend or pruning older zips.
if ! unzip -tq "$BACKUP_FILE" >/dev/null; then
  echo "Backup archive failed integrity verification: $BACKUP_FILE" >&2
  exit 1
fi

# Current self-hosted Convex builds retain hundreds of MiB of anonymous memory
# after each file-storage export (get-convex/convex-backend#435). Recycle the
# backend only after the backup is safely downloaded. This causes a few seconds
# of API unavailability during the nightly maintenance window.
if [ "${RESTART_CONVEX_AFTER_BACKUP:-true}" = "true" ]; then
  cd "$REPO_DIR"
  docker compose -f selfhost/docker-compose.yml restart backend
  healthy=""
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3210/version >/dev/null \
      && curl -fsS http://127.0.0.1:3211/health >/dev/null; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ -z "$healthy" ]; then
    echo "Backup succeeded, but Convex did not recover after restart" >&2
    exit 1
  fi
fi

# Prune: keep the most recent $KEEP backups safely even if BACKUP_DIR has spaces
setopt local_options null_glob
backups=("$BACKUP_DIR"/wepaintai-*.zip(Om))
if (( ${#backups[@]} > KEEP )); then
  prune_count=$(( ${#backups[@]} - KEEP ))
  rm -f -- "${backups[@]:0:$prune_count}"
fi

echo "Backup complete: $BACKUP_FILE"
