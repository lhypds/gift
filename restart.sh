#!/bin/bash
# Pull the latest code, then restart the webhooks server under PM2.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Restarting..."

cd "$ROOT"
echo "Pulling latest code..."
git pull --ff-only

# web/dist (the built dashboard) is git-ignored, so it has to be rebuilt here
# after every pull, not just when a dependency changes.
echo "Installing dependencies and rebuilding the dashboard..."
pnpm install
pnpm run build

"$ROOT/start.sh"
