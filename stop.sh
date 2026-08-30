#!/bin/bash
# Stop the hooks server. The process name comes from PM2_NAME in gift's
# configuration — config.json in this folder.

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping..."

PM2_NAME=$(node "$ROOT/utils/config.js" get PM2_NAME gift 2>/dev/null || echo gift)
PM2_NAME="${PM2_NAME:-gift}"

STOPPED=""
pm2 stop "$PM2_NAME" >/dev/null 2>&1 && STOPPED="$PM2_NAME"

# The process was called gift-webhooks before GitHub became one trigger among
# four. `gift stop` should still stop one left running under that name.
if [ "$PM2_NAME" != "gift-webhooks" ] && pm2 stop "gift-webhooks" >/dev/null 2>&1; then
  STOPPED="${STOPPED:+$STOPPED and }gift-webhooks"
fi

if [ -z "$STOPPED" ]; then
  echo "$PM2_NAME was not running"
else
  echo "Stopped $STOPPED."
fi
