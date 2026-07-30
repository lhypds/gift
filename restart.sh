#!/usr/bin/env bash
# Pull the latest code and restart the webhooks server under PM2.
# The work itself lives in webhooks/restart.sh, next to the rest of the server's
# configuration; this is the shortcut for running it from the repo root.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "$ROOT_DIR/webhooks/restart.sh" "$@"
