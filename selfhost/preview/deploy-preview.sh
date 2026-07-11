#!/usr/bin/env bash
# Allocate a bounded full-stack preview slot, deploy this PR's Convex backend,
# seed a small isolated dataset, then build and serve the matching frontend.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pool-common.sh
source "$SCRIPT_DIR/pool-common.sh"

PR="${1:?usage: deploy-preview.sh <pr-number>}"
preview_validate_pr "$PR"

ROOT="$PREVIEW_ROOT"
DEST="$ROOT/prs/pr-$PR"
FRONTEND_PORT=$((3300 + PR % 700))
FRONTEND_HOST="preview-pr-$PR.wepaint.ai"

mkdir -p "$ROOT/prs" "$ROOT/slots" "$ROOT/caddy" "$ROOT/logs" \
  "$ROOT/bin" "$ROOT/queue"
cp "$SCRIPT_DIR/pool-common.sh" "$SCRIPT_DIR/slot-compose.yml" \
  "$SCRIPT_DIR/remove-preview.sh" "$ROOT/bin/"
chmod +x "$ROOT/bin/pool-common.sh" "$ROOT/bin/remove-preview.sh"

if [ -z "${PREVIEW_GOOGLE_CLIENT_ID:-}" ] || [ -z "${PREVIEW_GOOGLE_CLIENT_SECRET:-}" ]; then
  echo "Preview Google OAuth credentials are missing from $PREVIEW_CONFIG" >&2
  exit 1
fi

available_kb="$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 }')"
if [ -z "$available_kb" ] || [ "$available_kb" -lt 4194304 ]; then
  echo "Preview deployment refused: less than 4 GiB of host disk is free" >&2
  exit 1
fi

slot=""
new_slot="false"
blocking_pr=""
preview_acquire_lock
for candidate in $(seq 1 "$PREVIEW_POOL_SIZE"); do
  owner="$(preview_slot_owner "$candidate" || true)"
  if [ "$owner" = "$PR" ]; then
    slot="$candidate"
    break
  fi
done
if [ -z "$slot" ]; then
  for candidate in $(seq 1 "$PREVIEW_POOL_SIZE"); do
    owner="$(preview_slot_owner "$candidate" || true)"
    if [ -z "$owner" ]; then
      slot="$candidate"
      new_slot="true"
      slot_dir="$(preview_slot_dir "$slot")"
      mkdir -p "$slot_dir/data"
      printf '%s\n' "$PR" > "$slot_dir/owner"
      break
    fi
    [ -z "$blocking_pr" ] && blocking_pr="$owner"
  done
fi

if [ -z "$slot" ]; then
  [ -f "$ROOT/queue/pr-$PR" ] || date +%s > "$ROOT/queue/pr-$PR"
  preview_release_lock
  echo "POOL_WAITING owner_pr=$blocking_pr"
  exit 75
fi
rm -f "$ROOT/queue/pr-$PR"
preview_release_lock

slot_dir="$(preview_slot_dir "$slot")"
compose_env="$slot_dir/compose.env"
backend_env="$slot_dir/backend.env"
deploy_env="$slot_dir/deploy.env"
api_port="$(preview_api_port "$slot")"
site_port="$(preview_site_port "$slot")"
api_host="preview-api-$slot.wepaint.ai"
site_host="preview-site-$slot.wepaint.ai"
auth_host="preview-auth-$slot.wepaint.ai"
project="wepaintai-preview-slot-$slot"

cleanup_failed_new_slot() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$new_slot" = "true" ]; then
    echo "New preview slot failed to deploy; releasing slot $slot" >&2
    "$ROOT/bin/remove-preview.sh" "$PR" || true
  fi
  exit "$status"
}
trap cleanup_failed_new_slot EXIT

if [ "$new_slot" = "true" ]; then
  umask 077
  instance_secret="$(openssl rand -hex 32)"
  auth_secret="$(openssl rand -hex 32)"
  convex_image="${PREVIEW_CONVEX_IMAGE:-}"
  if [ -z "$convex_image" ]; then
    convex_image="$(docker inspect selfhost-backend-1 --format '{{.Image}}')"
  fi

  cat > "$compose_env" <<EOF
PREVIEW_SLOT=$slot
PREVIEW_API_PORT=$api_port
PREVIEW_SITE_PORT=$site_port
PREVIEW_DATA_DIR=$slot_dir/data
PREVIEW_INSTANCE_SECRET=$instance_secret
PREVIEW_CONVEX_IMAGE=$convex_image
PREVIEW_MEMORY_LIMIT=${PREVIEW_MEMORY_LIMIT:-768m}
PREVIEW_CPU_LIMIT=${PREVIEW_CPU_LIMIT:-1.5}
PREVIEW_RUST_LOG=${PREVIEW_RUST_LOG:-warn}
EOF

  cat > "$backend_env" <<EOF
PREVIEW_DEPLOYMENT=true
PREVIEW_URL=https://$FRONTEND_HOST
SITE_URL=https://$auth_host
APP_URL=https://$FRONTEND_HOST
BETTER_AUTH_SECRET=$auth_secret
GOOGLE_CLIENT_ID=$PREVIEW_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$PREVIEW_GOOGLE_CLIENT_SECRET
EOF

  append_preview_env() {
    local target_name source_name value
    target_name="$1"
    source_name="$2"
    value="${!source_name:-}"
    if [ -n "$value" ]; then
      printf '%s=%s\n' "$target_name" "$value" >> "$backend_env"
    fi
    return 0
  }
  append_preview_env REPLICATE_API_TOKEN PREVIEW_REPLICATE_API_TOKEN
  append_preview_env REPLICATE_MODEL_VERSION PREVIEW_REPLICATE_MODEL_VERSION
  append_preview_env REPLICATE_TIMEOUT_SECONDS PREVIEW_REPLICATE_TIMEOUT_SECONDS
  append_preview_env GEMINI_API_KEY PREVIEW_GEMINI_API_KEY
  append_preview_env POLAR_API_KEY PREVIEW_POLAR_API_KEY
  append_preview_env POLAR_WEBHOOK_SECRET PREVIEW_POLAR_WEBHOOK_SECRET
  append_preview_env POLAR_PRODUCT_ID_50 PREVIEW_POLAR_PRODUCT_ID_50
  append_preview_env POLAR_PRODUCT_ID_125 PREVIEW_POLAR_PRODUCT_ID_125
  append_preview_env POLAR_API_BASE_URL PREVIEW_POLAR_API_BASE_URL
fi

if [ ! -f "$compose_env" ] || [ ! -f "$backend_env" ]; then
  echo "Preview slot $slot is missing its runtime configuration" >&2
  exit 1
fi

corepack pnpm install

docker compose --env-file "$compose_env" \
  -f "$ROOT/bin/slot-compose.yml" -p "$project" up -d backend

cat > "$ROOT/caddy/slot-$slot.caddy.tmp" <<EOF
@slot${slot}api host $api_host
handle @slot${slot}api {
	reverse_proxy 127.0.0.1:$api_port
}
@slot${slot}site host $site_host $auth_host
handle @slot${slot}site {
	reverse_proxy 127.0.0.1:$site_port
}
EOF
mv "$ROOT/caddy/slot-$slot.caddy.tmp" "$ROOT/caddy/slot-$slot.caddy"
preview_reload_caddy

ready=""
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$api_port/version"; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "Preview Convex slot $slot failed to start" >&2
  docker logs --tail 50 "wepaintai-preview-slot-$slot" >&2
  exit 1
fi

if [ "$new_slot" = "true" ]; then
  admin_key="$(docker exec "wepaintai-preview-slot-$slot" ./generate_admin_key.sh)"
  cat > "$deploy_env" <<EOF
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:$api_port
CONVEX_SELF_HOSTED_ADMIN_KEY=$admin_key
EOF
fi

corepack pnpm exec convex env --env-file "$deploy_env" \
  set --from-file "$backend_env" --force
corepack pnpm exec convex deploy --env-file "$deploy_env"
if [ "$new_slot" = "true" ]; then
  corepack pnpm exec convex run previewSeed:seed --env-file "$deploy_env"
fi

cat > .env.production <<EOF
VITE_CONVEX_URL=https://$api_host
VITE_CONVEX_SITE_URL=https://$site_host
VITE_APP_URL=https://$FRONTEND_HOST
VITE_PASSWORD_PROTECTION_ENABLED=false
VITE_AUTH_DISABLED=false
VITE_INTERNAL_HIDE_ADMIN_PANEL=false
EOF
corepack pnpm build

LABEL="com.wepaintai.preview.pr-$PR"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
mkdir -p "$DEST"
rsync -a --delete .output/ "$DEST/output/"

NODE_BIN="$(command -v node)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$DEST/output/server/index.mjs</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key><string>$FRONTEND_PORT</string>
		<key>HOST</key><string>127.0.0.1</string>
	</dict>
	<key>WorkingDirectory</key><string>$DEST</string>
	<key>StandardOutPath</key><string>$ROOT/logs/pr-$PR.log</string>
	<key>StandardErrorPath</key><string>$ROOT/logs/pr-$PR.log</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat > "$ROOT/caddy/pr-$PR.caddy.tmp" <<EOF
@pr$PR host $FRONTEND_HOST
handle @pr$PR {
	reverse_proxy 127.0.0.1:$FRONTEND_PORT
}
EOF
mv "$ROOT/caddy/pr-$PR.caddy.tmp" "$ROOT/caddy/pr-$PR.caddy"
preview_reload_caddy

frontend_ready=""
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$FRONTEND_PORT/"; then
    frontend_ready=1
    break
  fi
  sleep 1
done
if [ -z "$frontend_ready" ]; then
  echo "Preview frontend failed to start; log tail:" >&2
  tail -30 "$ROOT/logs/pr-$PR.log" >&2
  exit 1
fi

curl -fsS "https://$site_host/health" >/dev/null
curl -fsS "https://$api_host/version" >/dev/null
curl -fsS "https://$FRONTEND_HOST/" >/dev/null

cat > "$DEST/preview.env" <<EOF
PR=$PR
SLOT=$slot
FRONTEND_URL=https://$FRONTEND_HOST/
CONVEX_URL=https://$api_host
CONVEX_SITE_URL=https://$site_host
AUTH_URL=https://$auth_host
EOF

trap - EXIT
echo "POOL_READY slot=$slot url=https://$FRONTEND_HOST/"
