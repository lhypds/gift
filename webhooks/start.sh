#!/bin/bash
# Start the webhooks server under PM2. Settings come from this folder's .env.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Starting..."

cd "$ROOT"
if [ ! -f .env ]; then
  echo ".env not found — run ../setup.sh first" >&2
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

pm2 start ecosystem.config.cjs --update-env

# Read the listener settings from .env for display
PORT=$(grep '^PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo 3001)
HOST=$(grep '^GIFT_SERVE_HOST=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo 127.0.0.1)
HOOK_PATH=$(grep '^GIFT_SERVE_PATH=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo /hooks/github)

BASE="http://${HOST:-127.0.0.1}:${PORT:-3001}"
echo "gift webhooks listening on ${BASE}${HOOK_PATH:-/hooks/github}"
echo "health check: ${BASE}/health"
