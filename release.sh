#!/usr/bin/env bash
# Build a source-tree release zip and hand off to release_gh.sh to publish it on
# GitHub. The archive contains everything ./setup.sh and ./install.sh need in a
# fresh checkout: bin/, lib/, functions/, webhooks/, and the top-level scripts.
# Local config (.env, webhooks/hooks.json) is never shipped.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RELEASE_DIR="$ROOT_DIR/release"
STAGING_DIR="$RELEASE_DIR/staging"

VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"
if [ -z "$VERSION" ]; then
    echo "Error: VERSION file is empty."
    exit 1
fi

# package.json carries the same number; a mismatch means one of them was missed.
PKG_VERSION="$(node -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || echo "")"
if [ -n "$PKG_VERSION" ] && [ "$PKG_VERSION" != "$VERSION" ]; then
    echo "Error: VERSION ($VERSION) and package.json ($PKG_VERSION) disagree."
    exit 1
fi

rm -rf "$RELEASE_DIR"
mkdir -p "$STAGING_DIR"
echo "Cleared previous release artifacts."

echo "==> Staging release files in $STAGING_DIR"

# The CLI itself, every function folder, the webhook server, and the tests
cp -R "$ROOT_DIR/bin"       "$STAGING_DIR/bin"
cp -R "$ROOT_DIR/lib"       "$STAGING_DIR/lib"
cp -R "$ROOT_DIR/functions" "$STAGING_DIR/functions"
cp -R "$ROOT_DIR/webhooks"  "$STAGING_DIR/webhooks"
cp -R "$ROOT_DIR/test"      "$STAGING_DIR/test"

# Top-level scripts and project files
cp "$ROOT_DIR/setup.sh"     "$STAGING_DIR/"
cp "$ROOT_DIR/install.sh"   "$STAGING_DIR/"
cp "$ROOT_DIR/uninstall.sh" "$STAGING_DIR/"
cp "$ROOT_DIR/clear.sh"     "$STAGING_DIR/"
cp "$ROOT_DIR/restart.sh"   "$STAGING_DIR/"
cp "$ROOT_DIR/release.sh"   "$STAGING_DIR/"
cp "$ROOT_DIR/release_gh.sh" "$STAGING_DIR/"
cp "$ROOT_DIR/package.json" "$STAGING_DIR/"
cp "$ROOT_DIR/README.md"    "$STAGING_DIR/"
cp "$ROOT_DIR/LICENSE"      "$STAGING_DIR/"
cp "$ROOT_DIR/VERSION"      "$STAGING_DIR/"
cp "$ROOT_DIR/run.command.example" "$STAGING_DIR/"

# Optional dotfiles worth shipping (never .env — that holds the webhook secret).
[ -f "$ROOT_DIR/.env.example" ] && cp "$ROOT_DIR/.env.example" "$STAGING_DIR/"
[ -f "$ROOT_DIR/.gitignore"   ] && cp "$ROOT_DIR/.gitignore"   "$STAGING_DIR/"

# Strip anything machine-specific that a function folder may contain.
find "$STAGING_DIR" \
    \( -name ".env" -o -name "hooks.json" -o -name "*.command" -o -name ".DS_Store" -o -name "*.log" \) \
    -delete 2>/dev/null || true

chmod +x "$STAGING_DIR"/*.sh
chmod +x "$STAGING_DIR"/bin/gift.js

ZIP_NAME="gift_v${VERSION}.zip"
ZIP_PATH="$RELEASE_DIR/$ZIP_NAME"

[ -f "$ZIP_PATH" ] && rm -f "$ZIP_PATH"

echo "==> Creating $ZIP_NAME"
(cd "$STAGING_DIR" && zip -r -9 "$ZIP_PATH" .) >/dev/null
echo "Created archive: $ZIP_PATH"

echo ""
echo "Release artifacts ready in $RELEASE_DIR"
echo ""

"$ROOT_DIR/release_gh.sh" "v${VERSION}" "$ZIP_PATH"
