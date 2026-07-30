#!/usr/bin/env bash
# Remove the global gift launcher and the completion scripts installed by
# ./install.sh. Nothing inside this checkout is touched.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LAUNCHER="$HOME/.local/bin/gift"
MARKER="# gift-launcher:REPO=$ROOT_DIR"
ZSH_COMPLETION="$HOME/.local/share/zsh/site-functions/_gift"
BASH_COMPLETION="$HOME/.local/share/bash-completion/completions/gift"
ZSHRC="${ZDOTDIR:-$HOME}/.zshrc"
RC_BEGIN="# >>> gift completion >>>"
RC_END="# <<< gift completion <<<"

if [ -f "$LAUNCHER" ] && grep -qF "$MARKER" "$LAUNCHER"; then
    echo "==> Removing $LAUNCHER"
    rm "$LAUNCHER"
elif [ -f "$LAUNCHER" ]; then
    echo "warning: $LAUNCHER exists but is not this repo's launcher; left unchanged." >&2
else
    echo "(no launcher at $LAUNCHER)"
fi

for completion in "$ZSH_COMPLETION" "$BASH_COMPLETION"; do
    if [ -f "$completion" ] && grep -qF "gift-completion" "$completion"; then
        echo "==> Removing $completion"
        rm "$completion"
    elif [ -f "$completion" ]; then
        echo "warning: $completion was not installed by gift; left unchanged." >&2
    fi
done

# The block install.sh appended to ~/.zshrc, delimited by its own markers.
if [ -f "$ZSHRC" ] && grep -qF "$RC_BEGIN" "$ZSHRC"; then
    echo "==> Removing the gift completion block from $ZSHRC"
    TMP_RC="$(mktemp)"
    # Delete the block, then drop the blank lines it leaves at the end of the
    # file, so install/uninstall cycles keep ~/.zshrc byte-identical.
    sed "/^${RC_BEGIN}\$/,/^${RC_END}\$/d" "$ZSHRC" |
        awk '{ lines[NR] = $0; if (NF) last = NR } END { for (i = 1; i <= last; i++) print lines[i] }' \
            >"$TMP_RC"
    cat "$TMP_RC" >"$ZSHRC"
    rm -f "$TMP_RC"
fi

cat <<EOF

Uninstall complete.

Local files kept in the checkout (delete them by hand if you want them gone):
    $ROOT_DIR/.env
    $ROOT_DIR/webhooks/hooks.json

Shells that are already open keep the old completion until they restart:
    exec zsh
EOF
