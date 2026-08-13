#!/bin/bash
# Stop the webhooks server. The process name comes from PM2_NAME in gift's
# configuration — config.json in this folder.

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping..."

PM2_NAME=$(node "$ROOT/utils/config.js" get PM2_NAME gift-webhooks 2>/dev/null || echo gift-webhooks)

pm2 stop "${PM2_NAME:-gift-webhooks}" 2>/dev/null || echo "${PM2_NAME:-gift-webhooks} was not running"

echo "Stopped."
