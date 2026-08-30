#!/usr/bin/env bash
# One-line install of gift from its latest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/lhypds/gift/master/get.sh | bash
#
# Downloads the release zip, unpacks it into ~/.gift, and runs ./setup.sh and
# ./install.sh from there. Run it again to upgrade — config.json, hooks.json and
# the logs are carried across, so the webhook secret and the configured hooks
# survive the swap.
#
#   GIFT_INSTALL_DIR=/opt/gift       ./get.sh   # install somewhere other than ~/.gift
#   GIFT_INSTALL_VERSION=v0.0.1      ./get.sh   # pin a release instead of the latest
#   GIFT_INSTALL_REPO=owner/repo     ./get.sh   # take the release from a fork
#
# The names are GIFT_INSTALL_* rather than GIFT_*: `gift run` already exports
# GIFT_VERSION, GIFT_ROOT and GIFT_FUNCTION into every function's environment,
# so a get.sh run from inside a gift function would otherwise read gift's own
# version as a release to pin.
set -euo pipefail

REPO="${GIFT_INSTALL_REPO:-lhypds/gift}"
INSTALL_DIR="${GIFT_INSTALL_DIR:-$HOME/.gift}"
VERSION="${GIFT_INSTALL_VERSION:-}"

# Release tags are vX.Y.Z; accept a bare 0.0.1 as well.
if [ -n "$VERSION" ]; then
    case "$VERSION" in
        v*) ;;
        *) VERSION="v$VERSION" ;;
    esac
fi

die() {
    echo "error: $*" >&2
    exit 1
}

for tool in curl unzip; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required to install gift."
done

# This script deletes and replaces $INSTALL_DIR, so it refuses anything that is
# not either empty or a previous gift install. Piped into a shell from the
# network, it is the one place a wrong GIFT_INSTALL_DIR would be expensive.
case "$INSTALL_DIR" in
    ""|"/"|"$HOME"|"$HOME/") die "GIFT_INSTALL_DIR must be a directory of its own, not $INSTALL_DIR." ;;
    /*) ;;
    *) die "GIFT_INSTALL_DIR must be an absolute path (got: $INSTALL_DIR)." ;;
esac

UPGRADE=false
if [ -e "$INSTALL_DIR" ]; then
    [ -d "$INSTALL_DIR" ] || die "$INSTALL_DIR exists and is not a directory."
    if [ -f "$INSTALL_DIR/bin/gift.js" ]; then
        UPGRADE=true
    elif [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
        die "$INSTALL_DIR is not empty and does not look like a gift install. Move it aside first."
    fi
fi

# GitHub's API answers with the release JSON; the asset name carries the version
# (gift_v0.0.1.zip), so the download URL is read out of it rather than guessed.
if [ -n "$VERSION" ]; then
    API_URL="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
else
    API_URL="https://api.github.com/repos/$REPO/releases/latest"
fi

echo "==> Looking up the ${VERSION:-latest} gift release on $REPO"
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$API_URL" 2>/dev/null)" \
    || die "could not reach the GitHub API for $REPO${VERSION:+ at $VERSION}."

ZIP_URL="$(printf '%s' "$RELEASE_JSON" \
    | tr ',' '\n' \
    | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\.zip\)".*/\1/p' \
    | head -n 1)"
[ -n "$ZIP_URL" ] || die "the ${VERSION:-latest} release on $REPO has no .zip asset."

TAG="$(printf '%s' "$RELEASE_JSON" \
    | tr ',' '\n' \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"

# Unpack beside the install dir, not in $TMPDIR: the swap below is then a rename
# within one filesystem, and carrying node_modules across costs nothing.
NEW_DIR="$INSTALL_DIR.new.$$"
OLD_DIR="$INSTALL_DIR.old.$$"
TMP_DIR="$(mktemp -d)"

cleanup() {
    # node_modules is moved out of the live install into the new tree, so hand it
    # back before that tree is discarded — a failed upgrade then costs nothing.
    # On success there is no $NEW_DIR left to take it from and this does nothing.
    for dir in "$INSTALL_DIR" "$OLD_DIR"; do
        if [ -d "$NEW_DIR/node_modules" ] && [ -d "$dir" ] && [ ! -d "$dir/node_modules" ]; then
            mv "$NEW_DIR/node_modules" "$dir/node_modules"
        fi
    done
    rm -rf "$TMP_DIR" "$NEW_DIR"
    # A failure after the old tree was moved aside would otherwise leave nothing
    # installed at all, so put it back.
    if [ -d "$OLD_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
        mv "$OLD_DIR" "$INSTALL_DIR"
    fi
    rm -rf "$OLD_DIR"
}
trap cleanup EXIT

echo "==> Downloading ${TAG:-release} from $ZIP_URL"
curl -fsSL "$ZIP_URL" -o "$TMP_DIR/gift.zip" || die "download failed."
unzip -tqq "$TMP_DIR/gift.zip" >/dev/null 2>&1 || die "the downloaded file is not a readable zip."

rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
unzip -qo "$TMP_DIR/gift.zip" -d "$NEW_DIR"
[ -f "$NEW_DIR/bin/gift.js" ] || die "the release zip does not look like gift (no bin/gift.js)."

# Local state is deliberately not in the zip — config.json holds the webhook
# secret and hooks.json holds the user's hooks — so an upgrade has to bring it
# over by hand. node_modules comes too, to save a reinstall.
if [ "$UPGRADE" = true ]; then
    echo "==> Carrying settings, hooks and logs over from the current install"
    for file in config.json hooks.json; do
        [ -f "$INSTALL_DIR/$file" ] && cp -p "$INSTALL_DIR/$file" "$NEW_DIR/$file" || true
    done
    # An unmatched glob arrives as the pattern itself, which -f then rejects.
    for log in "$INSTALL_DIR"/*.log "$INSTALL_DIR"/*.log.[0-9]; do
        [ -f "$log" ] && cp -p "$log" "$NEW_DIR/" || true
    done
    [ -d "$INSTALL_DIR/logs" ] && cp -Rp "$INSTALL_DIR/logs" "$NEW_DIR/logs" || true
    [ -d "$INSTALL_DIR/node_modules" ] && mv "$INSTALL_DIR/node_modules" "$NEW_DIR/node_modules" || true
fi

if [ -d "$INSTALL_DIR" ]; then
    mv "$INSTALL_DIR" "$OLD_DIR"
fi
mkdir -p "$(dirname "$INSTALL_DIR")"
mv "$NEW_DIR" "$INSTALL_DIR"
rm -rf "$OLD_DIR"

chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR/bin/gift.js" 2>/dev/null || true

echo "==> Installed ${TAG:-release} in $INSTALL_DIR"
echo ""

# setup.sh asks for the public webhook URL when it has a terminal to ask on.
# Piped from curl, stdin is this script, so hand it the terminal directly.
if [ -e /dev/tty ] && [ -r /dev/tty ]; then
    "$INSTALL_DIR/setup.sh" </dev/tty
else
    "$INSTALL_DIR/setup.sh" </dev/null
fi

"$INSTALL_DIR/install.sh"

echo ""
echo "Installed from a release zip, so \`gift update\` has no checkout to pull."
echo "Upgrade with the same one-liner instead:"
echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/master/get.sh | bash"
