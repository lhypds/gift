#!/bin/bash
# Start the webhooks server under PM2. Settings come from gift's configuration:
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

# The server exits when no secret is configured, which PM2 would turn into a
# restart loop. Fail here instead, where the reason is visible.
SECRET=$(setting GITHUB_WEBHOOK_SECRET)
if [ -z "$SECRET" ]; then
  echo "GITHUB_WEBHOOK_SECRET is not configured" >&2
  echo "  add github_webhook_secret to $ROOT/config.json — \`gift config\` opens it" >&2
  exit 1
fi

PM2_NAME=$(setting PM2_NAME gift-webhooks)
PM2_NAME="${PM2_NAME:-gift-webhooks}"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "Restarting..."
  # PM2 restart keeps the entrypoint it cached when the process was created.
  # Recreate the entry so changes in ecosystem.config.cjs (such as renaming
  # server.js to serve.js) and removed environment variables take effect.
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
echo "gift webhooks listening on ${BASE}${HOOK_PATH:-/hooks/github}"
echo "health check: ${BASE}/health"
echo "web: ${BASE}"
