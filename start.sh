#!/bin/bash
# Start the webhooks server under PM2. Settings come from this folder's .env.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Starting..."

cd "$ROOT"
if [ ! -f .env ]; then
  echo ".env not found — run ./setup.sh first" >&2
  exit 1
fi

# The server exits when no secret is configured, which PM2 would turn into a
# restart loop. Fail here instead, where the reason is visible.
SECRET=$(grep '^GITHUB_WEBHOOK_SECRET=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || echo '')
if [ -z "$SECRET" ]; then
  echo "GITHUB_WEBHOOK_SECRET is empty in $ROOT/.env" >&2
  echo "  generate one with: openssl rand -hex 32" >&2
  exit 1
fi

# PM2 keeps the environment an app was first started with. `--update-env` does
# not drop a variable that has since left the shell, and the daemon hands its own
# environment to everything it spawns — so a GITHUB_WEBHOOK_SECRET that was
# exported once outlives every later edit to .env, because the server takes the
# real environment over the file. That reads as a webhook which will not verify
# whatever the file says. Recreating the entry is what rebuilds the environment;
# stopping and starting it is not.
PM2_NAME=$(grep '^PM2_NAME=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo gift-webhooks)
PM2_NAME="${PM2_NAME:-gift-webhooks}"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 delete "$PM2_NAME" >/dev/null
fi

pm2 start ecosystem.config.cjs --update-env

# Read the listener settings from .env for display
PORT=$(grep '^PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo 3999)
HOST=$(grep '^GIFT_SERVE_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo 127.0.0.1)
HOOK_PATH=$(grep '^GIFT_SERVE_PATH=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo /hooks/github)

BASE="http://${HOST:-127.0.0.1}:${PORT:-3999}"
echo "gift webhooks listening on ${BASE}${HOOK_PATH:-/hooks/github}"
echo "health check: ${BASE}/health"
