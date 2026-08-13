#!/usr/bin/env bash
# Preparation for ./install.sh: check Node.js >= 18, check the tools the
# functions need, and create config.json and hooks.json.
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

# Settings live in config.json; utils/config.js is the one reader and writer, so
# this script and the CLI never disagree about what is configured.
config_get() {
    "$NODE" "$ROOT_DIR/utils/config.js" get "$1"
}

config_set() {
    "$NODE" "$ROOT_DIR/utils/config.js" set gift "$1" "$2"
}

valid_webhook_url() {
    "$NODE" -e '
        try {
            const url = new URL(process.argv[1]);
            const valid = ["http:", "https:"].includes(url.protocol)
                && url.hostname && !url.username && !url.password && !url.hash;
            process.exit(valid ? 0 : 1);
        } catch {
            process.exit(1);
        }
    ' "$1"
}

echo "==> Using $($NODE --version) ($(command -v "$NODE"))"

if ! command -v pnpm >/dev/null 2>&1; then
    echo "error: pnpm is required. Install it with: npm install -g pnpm  (or corepack enable pnpm)" >&2
    exit 1
fi
# The full dependency set, not just production ones: the dashboard is a React
# app built by Vite, and building it locally is how `gift update` (a plain
# `git pull`, since web/dist is git-ignored) ends up with a working one.
echo "==> Installing dependencies and building the dashboard (pnpm i && pnpm run build)"
(cd "$ROOT_DIR" && pnpm i && pnpm run build)

echo "==> Checking the tools the functions use"
for tool in git gh jq; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "    ok       $tool"
    else
        echo "    missing  $tool"
        case "$tool" in
            git) echo "             needed by: recursively-pull-repos, repo-master  (xcode-select --install)" ;;
            gh)  echo "             needed by: gift create, list-weekly-prs, repo-master  (brew install gh, then gh auth login)" ;;
            jq)  echo "             needed by: list-weekly-prs  (brew install jq)" ;;
        esac
    fi
done

# Installed is not enough for gh: `gift create` creates the repository webhook
# through `gh api`, so a signed-out gh means the hook is written to hooks.json
# while GitHub is never told about it — the one failure worth naming here.
if command -v gh >/dev/null 2>&1; then
    if GH_AUTH="$(gh auth status 2>&1)"; then
        GH_ACCOUNT="$(printf '%s\n' "$GH_AUTH" | sed -n 's/.*account \([^ ]*\).*/\1/p' | head -n 1)"
        echo "    ok       gh is signed in${GH_ACCOUNT:+ as $GH_ACCOUNT}"
    else
        echo "    warning  gh is installed but not signed in — run: gh auth login"
        echo "             until then \`gift create\` adds the local hook only, and the GitHub"
        echo "             webhook has to be added under the repository's Settings > Webhooks"
    fi
    unset GH_AUTH GH_ACCOUNT
fi

# One file, created here with every setting the functions declare so that
# `gift config` opens a list to work from rather than a blank page.
CONFIG_FILE="$("$NODE" "$ROOT_DIR/utils/config.js" ensure)"
echo "==> Settings live in $CONFIG_FILE"

# gift used to read .env files, and does not any more. One left over from then
# is now inert, which is worth saying out loud rather than letting somebody
# wonder where their settings went.
STALE_ENV="$(find "$ROOT_DIR" -name ".env" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null)"
if [ -n "$STALE_ENV" ]; then
    echo "    warning  these .env files are no longer read — move what they hold into config.json:"
    printf '             %s\n' $STALE_ENV
fi
unset STALE_ENV

SECRET="$(config_get GITHUB_WEBHOOK_SECRET)"
if [ -z "$SECRET" ] || [ "$SECRET" = '""' ] || [ "$SECRET" = "''" ]; then
    SECRET="$("$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    config_set github_webhook_secret "$SECRET"
    echo "==> Generated github_webhook_secret in config.json"
else
    echo "==> Keeping existing github_webhook_secret"
fi
unset SECRET

WEBHOOK_URL="$(config_get GIFT_WEBHOOK_URL)"
if [ -t 0 ]; then
    echo ""
    while true; do
        if [ -n "$WEBHOOK_URL" ]; then
            read -r -p "Public webhook URL [$WEBHOOK_URL]: " ENTERED_URL
            CANDIDATE_URL="${ENTERED_URL:-$WEBHOOK_URL}"
        else
            read -r -p "Public webhook URL (include /hooks/github; leave blank to skip): " CANDIDATE_URL
        fi

        if [ -z "$CANDIDATE_URL" ] || valid_webhook_url "$CANDIDATE_URL"; then
            WEBHOOK_URL="$CANDIDATE_URL"
            break
        fi
        echo "Invalid URL — use a complete public http:// or https:// URL without credentials or a fragment." >&2
    done
    if [ -n "$WEBHOOK_URL" ]; then
        config_set webhook_url "$WEBHOOK_URL"
        echo "==> Saved webhook_url in config.json"
    else
        echo "==> webhook_url left empty"
    fi
elif [ -z "$WEBHOOK_URL" ]; then
    echo "==> webhook_url left empty (run ./setup.sh in a terminal to enter it)"
fi
unset WEBHOOK_URL ENTERED_URL CANDIDATE_URL

if [ ! -f "hooks.json" ]; then
    cat > hooks.json <<'EOF'
{
  "log": "hooks.log",
  "hooks": []
}
EOF
    echo "==> Created hooks.json with no hooks — see hooks.example.json for the format"
else
    echo "==> Keeping existing hooks.json"
fi

chmod +x ./*.sh bin/gift.js 2>/dev/null || true
find . -path ./.git -prune -o -name "*.sh" -print0 2>/dev/null | xargs -0 chmod +x 2>/dev/null || true

cat <<EOF

Setup complete — ready for ./install.sh

Next step (installs the global \`gift\` command):
    ./install.sh
EOF
