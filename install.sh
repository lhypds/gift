#!/usr/bin/env bash
# Run ./setup.sh first. Adds ~/.local/bin/gift, a wrapper around bin/gift.js in
# this checkout.
#
#   ./install.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MIN_NODE_MAJOR=18
LAUNCHER_DIR="$HOME/.local/bin"
LAUNCHER="$LAUNCHER_DIR/gift"
MARKER="# gift-launcher:REPO=$ROOT_DIR"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"

for arg in "$@"; do
    case "$arg" in
        -h|--help)
            sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

NODE=""
for cmd in "${NODE_BIN:-}" node; do
    [ -z "$cmd" ] && continue
    command -v "$cmd" >/dev/null 2>&1 || continue
    if "$cmd" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" 2>/dev/null; then
        NODE="$(command -v "$cmd")"
        break
    fi
done

if [ -z "$NODE" ]; then
    echo "error: need Node.js >= $MIN_NODE_MAJOR. Run ./setup.sh first." >&2
    exit 1
fi

mkdir -p "$LAUNCHER_DIR"

if [ -f "$LAUNCHER" ] && ! grep -qF "$MARKER" "$LAUNCHER"; then
    if grep -q "gift-launcher:REPO=" "$LAUNCHER"; then
        echo "==> Replacing a gift launcher that pointed at another checkout"
    else
        echo "error: $LAUNCHER already exists and was not created by gift." >&2
        echo "  Remove it yourself first if you want gift to take that name." >&2
        exit 1
    fi
fi

echo "==> Writing $LAUNCHER"
# $ROOT_DIR and $NODE are baked in now; "\$@" stays literal for runtime.
cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
$MARKER
set -euo pipefail

# Prefer whatever node is on PATH (nvm users switch versions); fall back to the
# interpreter found at install time.
if command -v node >/dev/null 2>&1; then
    NODE_BIN="node"
else
    NODE_BIN="$NODE"
fi

exec "\$NODE_BIN" "$ROOT_DIR/bin/gift.js" "\$@"
EOF
chmod +x "$LAUNCHER"
chmod +x "$ROOT_DIR/bin/gift.js"

echo ""
echo "Install complete. \`gift\` runs from:"
echo "  $LAUNCHER"
echo ""

case ":$PATH:" in
    *":$LAUNCHER_DIR:"*) ;;
    *)
        echo "Add this to $ZSHRC, then open a new terminal:"
        echo ""
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
        ;;
esac

echo "Try it:"
echo "  gift help"
echo "  gift run"
