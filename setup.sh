#!/usr/bin/env bash
# Preparation for ./install.sh: check Node.js >= 18, check the tools the
# commands need, and create the local config files (.env, server/hooks.json).
# Does not install the global `gift` command — run ./install.sh after this.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MIN_NODE_MAJOR=18

NODE=""
for cmd in "${NODE_BIN:-}" node; do
    [ -z "$cmd" ] && continue
    command -v "$cmd" >/dev/null 2>&1 || continue
    if "$cmd" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" 2>/dev/null; then
        NODE="$cmd"
        break
    fi
done

if [ -z "$NODE" ]; then
    echo "error: need Node.js >= $MIN_NODE_MAJOR for this project." >&2
    echo "  macOS:         brew install node" >&2
    echo "  nvm:           nvm install --lts" >&2
    echo "  or point at one explicitly: NODE_BIN=/opt/homebrew/bin/node ./setup.sh" >&2
    exit 1
fi

echo "==> Using $($NODE --version) ($(command -v "$NODE"))"
echo "==> No third-party packages to install (gift uses only the Node standard library)"

echo "==> Checking the tools the commands use"
for tool in git gh jq; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "    ok       $tool"
    else
        echo "    missing  $tool"
        case "$tool" in
            git) echo "             needed by: recursively-pull-repos  (xcode-select --install)" ;;
            gh)  echo "             needed by: list-weekly-prs  (brew install gh, then gh auth login)" ;;
            jq)  echo "             needed by: list-weekly-prs  (brew install jq)" ;;
        esac
    fi
done

if [ -f ".env.example" ]; then
    if [ ! -f ".env" ]; then
        cp ".env.example" ".env"
        echo "==> Created .env from .env.example"
    else
        echo "==> Keeping existing .env"
    fi
fi

if [ -f "server/hooks.example.json" ]; then
    if [ ! -f "server/hooks.json" ]; then
        cp "server/hooks.example.json" "server/hooks.json"
        echo "==> Created server/hooks.json from server/hooks.example.json"
    else
        echo "==> Keeping existing server/hooks.json"
    fi
fi

chmod +x ./*.sh bin/gift.js 2>/dev/null || true
find . -path ./.git -prune -o -name "*.sh" -print0 2>/dev/null | xargs -0 chmod +x 2>/dev/null || true

cat <<EOF

Setup complete — ready for ./install.sh

Next step (installs the global \`gift\` command and shell completion):
    ./install.sh

Before using \`gift serve\`, set GITHUB_WEBHOOK_SECRET in .env:
    openssl rand -hex 32
EOF
