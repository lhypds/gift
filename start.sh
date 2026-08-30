#!/bin/bash
# Start the hooks server under PM2. Settings come from gift's configuration:
# config.json in this folder.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found — run ./setup.sh first" >&2
  exit 1
fi

# One reader for both files, so the shell and the server never disagree about
# what is configured.
setting() { node "$ROOT/utils/config.js" get "$1" "${2:-}"; }

PM2_NAME=$(setting PM2_NAME gift)
PM2_NAME="${PM2_NAME:-gift}"

# gift's PM2 process used to be called gift-webhooks, back when GitHub was the
# only thing it listened to. One left running under the old name would still
# hold the port, and the new one would fail to bind with nothing saying why.
LEGACY_NAME="gift-webhooks"
if [ "$PM2_NAME" != "$LEGACY_NAME" ] && pm2 describe "$LEGACY_NAME" >/dev/null 2>&1; then
  echo "Removing the old '$LEGACY_NAME' process — it is now '$PM2_NAME'."
  pm2 delete "$LEGACY_NAME" >/dev/null
fi

# The GitHub trigger rejects every delivery without a secret, and the other
# three triggers do not need one at all — so this is a warning rather than the
# refusal to start it used to be.
if [ -z "$(setting GITHUB_WEBHOOK_SECRET)" ]; then
  echo "warning: GITHUB_WEBHOOK_SECRET is not configured — GitHub deliveries will all be rejected." >&2
  echo "         Add github_webhook_secret under triggers.github in $ROOT/config.json (\`gift config\`)." >&2
fi

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "Restarting..."
  # PM2 restart keeps the entrypoint it cached when the process was created.
  # Recreate the entry so changes in ecosystem.config.cjs and removed
  # environment variables take effect.
  pm2 delete "$PM2_NAME" >/dev/null
else
  echo "Starting..."
fi
pm2 start ecosystem.config.cjs --only "$PM2_NAME" --update-env

# Read the listener settings for display
PORT=$(setting PORT 3999)
HOST=$(setting GIFT_SERVE_HOST 127.0.0.1)
HOOK_PATH=$(setting GIFT_SERVE_PATH /hooks/github)

BASE="http://${HOST:-127.0.0.1}:${PORT:-3999}"
echo "gift hooks listening on ${BASE}"
echo "health check: ${BASE}/health"
echo "GitHub endpoint: ${BASE}${HOOK_PATH:-/hooks/github}"
