#!/usr/bin/env bash
# Preparation for ./install.sh: check Node.js >= 18, check the tools the
# functions need, and create the local config files (.env, hooks.json).
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

env_value() {
    "$NODE" -e '
        const fs = require("node:fs");
        const [file, key] = process.argv.slice(1);
        const line = fs.readFileSync(file, "utf8")
            .split(/\r?\n/)
            .find((item) => item.startsWith(`${key}=`));
        process.stdout.write(line ? line.slice(key.length + 1).trim() : "");
    ' "$ROOT_DIR/.env" "$1"
}

set_env_value() {
    GIFT_SETUP_VALUE="$2" "$NODE" -e '
        const fs = require("node:fs");
        const [file, key] = process.argv.slice(1);
        const value = process.env.GIFT_SETUP_VALUE || "";
        const mode = fs.statSync(file).mode & 0o777;
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        if (lines[lines.length - 1] === "") lines.pop();
        const index = lines.findIndex((line) => line.startsWith(`${key}=`));
        if (index >= 0) lines[index] = `${key}=${value}`;
        else lines.push(`${key}=${value}`);
        const temp = `${file}.setup.tmp`;
        fs.writeFileSync(temp, `${lines.join("\n")}\n`, { mode });
        fs.renameSync(temp, file);
    ' "$ROOT_DIR/.env" "$1"
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
echo "==> No third-party packages to install (gift uses only the Node standard library)"

echo "==> Checking the tools the functions use"
for tool in git gh jq; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "    ok       $tool"
    else
        echo "    missing  $tool"
        case "$tool" in
            git) echo "             needed by: recursively-pull-repos  (xcode-select --install)" ;;
            gh)  echo "             needed by: gift create, list-weekly-prs  (brew install gh, then gh auth login)" ;;
            jq)  echo "             needed by: list-weekly-prs  (brew install jq)" ;;
        esac
    fi
done

# The shared .env, plus one per function folder that ships an example — settings
# only a single function reads live next to that function.
for example in .env.example functions/*/.env.example; do
    [ -f "$example" ] || continue
    target="${example%.example}"
    if [ ! -f "$target" ]; then
        cp "$example" "$target"
        echo "==> Created $target from $example"
    else
        echo "==> Keeping existing $target"
    fi
done

SECRET="$(env_value GITHUB_WEBHOOK_SECRET)"
if [ -z "$SECRET" ] || [ "$SECRET" = '""' ] || [ "$SECRET" = "''" ]; then
    SECRET="$("$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    set_env_value GITHUB_WEBHOOK_SECRET "$SECRET"
    echo "==> Generated GITHUB_WEBHOOK_SECRET in .env"
else
    echo "==> Keeping existing GITHUB_WEBHOOK_SECRET in .env"
fi
unset SECRET

WEBHOOK_URL="$(env_value GIFT_WEBHOOK_URL)"
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
    set_env_value GIFT_WEBHOOK_URL "$WEBHOOK_URL"
    if [ -n "$WEBHOOK_URL" ]; then
        echo "==> Saved GIFT_WEBHOOK_URL in .env"
    else
        echo "==> GIFT_WEBHOOK_URL left empty"
    fi
elif [ -z "$WEBHOOK_URL" ]; then
    echo "==> GIFT_WEBHOOK_URL left empty (run ./setup.sh in a terminal to enter it)"
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
