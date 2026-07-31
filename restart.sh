#!/bin/bash
# Pull the latest code, then restart the webhooks server under PM2.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Restarting..."

cd "$ROOT"
echo "Pulling latest code..."
git pull --ff-only

# Nothing to install or build — gift uses only the Node standard library.

"$ROOT/start.sh"
