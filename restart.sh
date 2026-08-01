#!/bin/bash
# Pull the latest code, then restart the webhooks server under PM2.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Restarting..."

cd "$ROOT"

# A release tarball has no history to pull from — degrade to just restarting
# on whatever is already on disk, rather than failing on `git pull`.
if [ -d .git ]; then
  echo "Pulling latest code..."
  git pull --ff-only

  # web/dist (the built dashboard) is git-ignored, so it has to be rebuilt here
  # after every pull, not just when a dependency changes.
  echo "Installing dependencies and rebuilding the dashboard..."
  pnpm install
  pnpm run build
else
  echo "Not a git checkout — skipping pull and rebuild."
fi

"$ROOT/start.sh"
