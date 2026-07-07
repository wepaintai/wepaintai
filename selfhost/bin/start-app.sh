#!/bin/zsh
# Starts the built wepaintai node server. Used by the launchd agent.
# Build first with: pnpm build:selfhost
set -euo pipefail

REPO_DIR="${WEPAINTAI_DIR:-$HOME/Documents/GitHub/wepaintai}"
cd "$REPO_DIR"

# Resolve node from nvm if not on PATH (launchd has a minimal PATH)
if ! command -v node >/dev/null 2>&1; then
  NVM_NODE=$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
fi

export PORT="${PORT:-3000}"
exec node .output/server/index.mjs
