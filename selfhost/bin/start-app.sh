#!/bin/zsh
# Starts the built wepaintai node server. Used by the launchd agent.
# Build first with: corepack pnpm build
set -euo pipefail

REPO_DIR="${WEPAINTAI_DIR:-$HOME/apps/wepaintai}"
cd "$REPO_DIR"

# launchd has a minimal PATH; add Homebrew and nvm locations safely (no NOMATCH abort)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  setopt local_options null_glob
  nvm_bins=("$HOME/.nvm/versions/node"/*/bin)
  if (( ${#nvm_bins[@]} > 0 )); then
    NVM_NODE=$(printf '%s\n' "${nvm_bins[@]}" | sort -V | tail -1)
    [ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
  fi
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
exec node .output/server/index.mjs
