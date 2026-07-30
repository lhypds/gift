#!/usr/bin/env bash
# Example hook script for `gift serve`. Copy it next to the project you deploy,
# point a hook's "run" at the copy, and edit PROJECT_DIR / the build commands.
#
# The server passes the delivery as environment variables (GIFT_EVENT,
# GIFT_REPO, GIFT_BRANCH, GIFT_AFTER, GIFT_PAYLOAD_FILE, ...). They come from
# the internet: log them, but never eval them or build shell commands from them.
set -Eeuo pipefail

PROJECT_DIR="/opt/myapp/repository"
BRANCH="${GIFT_BRANCH:-main}"
LOG_FILE="${LOG_FILE:-/tmp/gift-deploy.log}"
LOCK_FILE="/tmp/gift-deploy.lock"

exec >>"$LOG_FILE" 2>&1

echo "========================================"
echo "Deploy started: $(date +%Y-%m-%dT%H:%M:%S%z)"
echo "  hook=${GIFT_HOOK:-?} event=${GIFT_EVENT:-?} repo=${GIFT_REPO:-?}"
echo "  branch=${BRANCH} commit=${GIFT_AFTER:-?} delivery=${GIFT_DELIVERY:-?}"

# Two pushes in quick succession should not deploy on top of each other.
# (`gift serve` also coalesces overlapping runs; this guards manual runs too.)
exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
    if ! flock -n 9; then
        echo "Another deployment is already running — exiting."
        exit 0
    fi
fi

cd "$PROJECT_DIR"

# Deploy servers should mirror the remote exactly rather than merge, so the
# checkout must not hold hand-edited files worth keeping.
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# --- project specific ---------------------------------------------------------
# npm ci
# npm run build
# pm2 reload myapp --update-env
# sudo systemctl restart myapp
# -----------------------------------------------------------------------------

echo "Deploy completed: $(date +%Y-%m-%dT%H:%M:%S%z)"
