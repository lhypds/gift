#!/usr/bin/env bash
# Publish a gift release zip to GitHub (lhypds/gift) using the `gh` CLI.
# Usage:
#   ./release_gh.sh                            # derive tag + zip path from VERSION
#   ./release_gh.sh v0.0.2                     # explicit tag, derive zip path
#   ./release_gh.sh v0.0.2 path/to/gift.zip    # explicit tag and zip path
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$ROOT_DIR/release"
REPO="${GIFT_RELEASE_REPO:-lhypds/gift}"

if [ $# -ge 2 ]; then
    VERSION="$1"
    ZIP_PATH="$2"
elif [ $# -ge 1 ]; then
    VERSION="$1"
    BARE="${VERSION#v}"
    ZIP_PATH="$RELEASE_DIR/gift_v${BARE}.zip"
else
    VERSION_FILE="$ROOT_DIR/VERSION"
    if [ ! -f "$VERSION_FILE" ]; then
        echo "Error: VERSION file not found."
        exit 1
    fi
    BARE="$(tr -d '[:space:]' < "$VERSION_FILE")"
    VERSION="v${BARE}"
    ZIP_PATH="$RELEASE_DIR/gift_v${BARE}.zip"
fi

if [ ! -f "$ZIP_PATH" ]; then
    echo "Error: $ZIP_PATH not found. Run release.sh first."
    exit 1
fi

if ! command -v gh &>/dev/null; then
    echo "Error: GitHub CLI (gh) is not installed. Install it from https://cli.github.com"
    exit 1
fi

# Refuse to overwrite an existing release with the same tag.
if gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    echo "Error: release $VERSION already exists on $REPO."
    echo "  Bump VERSION or delete the existing release with:"
    echo "    gh release delete $VERSION --repo $REPO"
    exit 1
fi

echo "Ready to publish release:"
echo "  Repo:   $REPO"
echo "  Tag:    $VERSION"
echo "  Asset:  $ZIP_PATH"
echo ""
read -r -p "Release notes (leave blank for default): " RELEASE_NOTES
if [ -z "$RELEASE_NOTES" ]; then
    RELEASE_NOTES="Release $VERSION"
fi
echo ""
read -r -p "Publish to GitHub? [Y/n]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && [ -n "$CONFIRM" ]; then
    echo "Aborted."
    exit 0
fi

gh release create "$VERSION" "$ZIP_PATH" \
    --repo "$REPO" \
    --title "$VERSION" \
    --notes "$RELEASE_NOTES"

echo ""
echo "Published $VERSION to $REPO with asset $(basename "$ZIP_PATH")."
