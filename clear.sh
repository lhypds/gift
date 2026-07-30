#!/usr/bin/env bash
# Remove build and release outputs. The checkout's own config (.env,
# server/hooks.json) and .git are left intact.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "==> Removing release/, dist/, node_modules/"
rm -rf release dist node_modules

echo "==> Removing *.log and .DS_Store"
find . -path ./.git -prune -o \( -name "*.log" -o -name ".DS_Store" \) -print0 2>/dev/null |
    xargs -0 rm -f 2>/dev/null || true

echo "Clear complete."
