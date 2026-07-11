#!/usr/bin/env bash
# Install the machine-local preview pool scaffolding. This does not start a
# slot or modify production. Fill config.env and register Google callbacks
# before enabling the GitHub workflow.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PREVIEW_ROOT:-$HOME/apps/wepaintai-previews}"

mkdir -p "$ROOT/bin" "$ROOT/caddy" "$ROOT/logs" "$ROOT/prs" \
  "$ROOT/queue" "$ROOT/slots" "$ROOT/locks"
cp "$SCRIPT_DIR/pool-common.sh" "$SCRIPT_DIR/slot-compose.yml" \
  "$SCRIPT_DIR/remove-preview.sh" "$ROOT/bin/"
chmod +x "$ROOT/bin/pool-common.sh" "$ROOT/bin/remove-preview.sh"

if [ ! -f "$ROOT/config.env" ]; then
  cp "$SCRIPT_DIR/config.example.env" "$ROOT/config.env"
  chmod 600 "$ROOT/config.env"
  echo "Created $ROOT/config.env; fill preview credentials before deploying."
else
  chmod 600 "$ROOT/config.env"
  echo "Preserved existing $ROOT/config.env."
fi

if [ ! -f "$ROOT/Caddyfile" ]; then
  cat > "$ROOT/Caddyfile" <<EOF
{
	auto_https off
	admin localhost:2019
}

http://:3299 {
	import $ROOT/caddy/*.caddy
	respond "No such preview" 404
}
EOF
  echo "Created $ROOT/Caddyfile."
fi

echo "Preview pool scaffolding installed at $ROOT."
