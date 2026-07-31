#!/bin/bash
# Stop the webhooks server. The process name comes from PM2_NAME in .env.

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping..."

# Read PM2_NAME from .env
PM2_NAME=$(grep '^PM2_NAME=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo gift-webhooks)

pm2 stop "${PM2_NAME:-gift-webhooks}" 2>/dev/null || echo "${PM2_NAME:-gift-webhooks} was not running"

echo "Stopped."
