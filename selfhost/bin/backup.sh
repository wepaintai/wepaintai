#!/bin/zsh
# Nightly backup of the self-hosted Convex deployment.
# Exports all tables + file storage to a dated zip and prunes old ones.
# Requires selfhost/.env.convex with:
#   CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
#   CONVEX_SELF_HOSTED_ADMIN_KEY=<from generate_admin_key.sh>
set -euo pipefail

REPO_DIR="${WEPAINTAI_DIR:-$HOME/Documents/GitHub/wepaintai}"
BACKUP_DIR="${WEPAINTAI_BACKUP_DIR:-$HOME/Backups/wepaintai/selfhosted}"
KEEP=14

mkdir -p "$BACKUP_DIR"
cd "$REPO_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  NVM_NODE=$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
fi

STAMP=$(date +%Y-%m-%d_%H%M)
corepack pnpm exec convex export \
  --env-file "$REPO_DIR/selfhost/.env.convex" \
  --include-file-storage \
  --path "$BACKUP_DIR/wepaintai-$STAMP.zip"

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

# Prune: keep the most recent $KEEP backups
ls -1t "$BACKUP_DIR"/wepaintai-*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | xargs rm -f --

echo "Backup complete: $BACKUP_DIR/wepaintai-$STAMP.zip"
