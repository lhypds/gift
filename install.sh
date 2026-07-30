#!/usr/bin/env bash
# Run ./setup.sh first. Adds ~/.local/bin/gift (a wrapper around bin/gift.js in
# this checkout) and installs the zsh/bash completion scripts.
#
#   ./install.sh                   install command + completions
#   ./install.sh --no-completions  install the command only
#   ./install.sh --no-rc           install completions, but do not touch ~/.zshrc
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MIN_NODE_MAJOR=18
LAUNCHER_DIR="$HOME/.local/bin"
LAUNCHER="$LAUNCHER_DIR/gift"
MARKER="# gift-launcher:REPO=$ROOT_DIR"
ZSH_COMPLETION_DIR="$HOME/.local/share/zsh/site-functions"
BASH_COMPLETION_DIR="$HOME/.local/share/bash-completion/completions"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"
RC_BEGIN="# >>> gift completion >>>"
RC_END="# <<< gift completion <<<"

WITH_COMPLETIONS=1
WITH_RC=1
for arg in "$@"; do
    case "$arg" in
        --no-completions) WITH_COMPLETIONS=0 ;;
        --no-rc) WITH_RC=0 ;;
        -h|--help)
            sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
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

RC_ADDED=0
if [ "$WITH_COMPLETIONS" -eq 1 ]; then
    echo "==> Installing zsh completion to $ZSH_COMPLETION_DIR/_gift"
    mkdir -p "$ZSH_COMPLETION_DIR"
    cp "$ROOT_DIR/completions/_gift" "$ZSH_COMPLETION_DIR/_gift"

    echo "==> Installing bash completion to $BASH_COMPLETION_DIR/gift"
    mkdir -p "$BASH_COMPLETION_DIR"
    cp "$ROOT_DIR/completions/gift.bash" "$BASH_COMPLETION_DIR/gift"

    # Dropping the file into a directory is not enough on its own: it only gets
    # picked up if that directory is on zsh's fpath *before* compinit runs, and
    # `compinit -C` (a common speed-up) skips the scan for new files entirely.
    # Sourcing the file after compinit avoids depending on either.
    if [ "$WITH_RC" -eq 1 ]; then
        if [ ! -e "$ZSHRC" ] || ! grep -qF "$RC_BEGIN" "$ZSHRC"; then
            echo "==> Enabling zsh completion in $ZSHRC"
            {
                # Separate the block from what precedes it, without stacking
                # blank lines when install/uninstall is run repeatedly.
                [ -n "$(tail -n 1 "$ZSHRC" 2>/dev/null || true)" ] && echo ""
                echo "$RC_BEGIN"
                echo "# Added by gift's install.sh. Remove this block with ./uninstall.sh"
                echo "if (( ! \$+functions[compdef] )); then"
                echo "    autoload -Uz compinit && compinit -C"
                echo "fi"
                echo "[ -f \"$ZSH_COMPLETION_DIR/_gift\" ] && source \"$ZSH_COMPLETION_DIR/_gift\""
                echo "$RC_END"
            } >>"$ZSHRC"
            RC_ADDED=1
        else
            echo "==> zsh completion already enabled in $ZSHRC"
        fi
    fi
fi

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

if [ "$WITH_COMPLETIONS" -eq 1 ]; then
    if [ "$WITH_RC" -eq 0 ]; then
        echo "Completion files are installed but not enabled (--no-rc). Add to $ZSHRC:"
        echo "  source \"$ZSH_COMPLETION_DIR/_gift\""
        echo ""
    elif [ "$RC_ADDED" -eq 1 ]; then
        echo "Tab completion is enabled for new shells. To use it in this one:"
        echo "  exec zsh"
        echo ""
    else
        echo "Tab completion: type \`gift \` and press Tab."
        echo ""
    fi
fi

echo "Try it:"
echo "  gift help"
