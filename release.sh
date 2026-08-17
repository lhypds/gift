#!/usr/bin/env bash
# Build a source-tree release zip and hand off to release_gh.sh to publish it on
# GitHub. The archive contains everything ./setup.sh and ./install.sh need in a
# fresh checkout: the root webhook server plus bin/, commands/, functions/, and
# utils/ for the additional CLI functions.
# Local settings and state (config.json, hooks.json, logs) are never shipped —
# config.json holds the webhook secret.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

normalize_version() {
    local v="$1"
    v="${v#v}"
    v="$(printf '%s' "$v" | tr -d '[:space:]')"
    printf '%s' "$v"
}

version_compare() {
    local lhs="$1"
    local rhs="$2"
    local IFS='.'
    local -a a_parts b_parts
    local max_len i a_seg b_seg

    read -r -a a_parts <<< "$lhs"
    read -r -a b_parts <<< "$rhs"

    max_len="${#a_parts[@]}"
    if [ "${#b_parts[@]}" -gt "$max_len" ]; then
        max_len="${#b_parts[@]}"
    fi

    for ((i = 0; i < max_len; i++)); do
        a_seg="${a_parts[i]:-0}"
        b_seg="${b_parts[i]:-0}"
        if ! [[ "$a_seg" =~ ^[0-9]+$ ]] || ! [[ "$b_seg" =~ ^[0-9]+$ ]]; then
            echo "Error: VERSION contains non-numeric segments ($lhs vs $rhs)."
            exit 1
        fi

        if ((10#$a_seg > 10#$b_seg)); then
            echo 1
            return
        fi
        if ((10#$a_seg < 10#$b_seg)); then
            echo -1
            return
        fi
    done

    echo 0
}

bump_version_interactive() {
    local current="$1"
    local IFS='.'
    local -a parts
    local count choice idx i

    read -r -a parts <<< "$current"
    count="${#parts[@]}"
    if [ "$count" -eq 0 ]; then
        echo "Error: invalid VERSION '$current'."
        exit 1
    fi

    for i in "${parts[@]}"; do
        if ! [[ "$i" =~ ^[0-9]+$ ]]; then
            echo "Error: VERSION contains non-numeric segments ($current)."
            exit 1
        fi
    done

    read -r -p "VERSION $current equals latest release. Which segment to bump from right? [1=last, 2=second last, ...] (default: 1): " choice
    choice="${choice:-1}"
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
        echo "Error: invalid segment selection '$choice'."
        exit 1
    fi

    idx=$((count - choice))
    parts[idx]=$((10#${parts[idx]} + 1))
    for ((i = idx + 1; i < count; i++)); do
        parts[i]=0
    done

    local result="${parts[0]}"
    for ((i = 1; i < count; i++)); do
        result+=".${parts[i]}"
    done
    printf '%s' "$result"
}

prepare_version_for_release() {
    if [ ! -f "$ROOT_DIR/VERSION" ]; then
        echo "Error: VERSION file not found."
        exit 1
    fi

    if ! command -v gh &>/dev/null; then
        echo "Error: GitHub CLI (gh) is required."
        exit 1
    fi
    if ! gh auth status &>/dev/null; then
        echo "Error: gh is not authenticated. Run: gh auth login"
        exit 1
    fi

    local current latest_tag latest cmp new_version branch
    current="$(normalize_version "$(cat "$ROOT_DIR/VERSION")")"
    if [ -z "$current" ]; then
        echo "Error: VERSION file is empty."
        exit 1
    fi

    latest_tag="$(gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
    if [ "$latest_tag" = "null" ]; then
        latest_tag=""
    fi

    if [ -z "$latest_tag" ]; then
        echo "No existing GitHub release found. Releasing VERSION $current."
        return
    fi

    latest="$(normalize_version "$latest_tag")"
    cmp="$(version_compare "$current" "$latest")"

    if [ "$cmp" -gt 0 ]; then
        echo "VERSION $current is greater than latest release $latest. Continue releasing."
        return
    fi

    if [ "$cmp" -lt 0 ]; then
        echo "Error: VERSION $current is lower than latest release $latest."
        exit 1
    fi

    new_version="$(bump_version_interactive "$current")"
    printf '%s\n' "$new_version" > "$ROOT_DIR/VERSION"

    git add "$ROOT_DIR/VERSION"
    git commit -m "$new_version"

    branch="$(git branch --show-current 2>/dev/null || true)"
    if [ -n "$branch" ]; then
        git push origin "$branch"
    else
        git push
    fi

    echo "VERSION bumped to $new_version, committed, and pushed."
}

prepare_version_for_release

RELEASE_DIR="$ROOT_DIR/release"
STAGING_DIR="$RELEASE_DIR/staging"

VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"
if [ -z "$VERSION" ]; then
    echo "Error: VERSION file is empty."
    exit 1
fi

# The dashboard is React, built by Vite; the release ships the built web/dist
# alongside its web/src source, so the zip runs standalone without forcing a
# build on the target machine.
echo "==> Installing dependencies and building the dashboard"
(cd "$ROOT_DIR" && pnpm install --frozen-lockfile && pnpm run build)

rm -rf "$RELEASE_DIR"
mkdir -p "$STAGING_DIR"
echo "Cleared previous release artifacts."

echo "==> Staging release files in $STAGING_DIR"

# The CLI, command modules, shared utilities, and additional functions.
cp -R "$ROOT_DIR/bin"       "$STAGING_DIR/bin"
cp -R "$ROOT_DIR/commands"  "$STAGING_DIR/commands"
cp -R "$ROOT_DIR/functions" "$STAGING_DIR/functions"
cp -R "$ROOT_DIR/utils"     "$STAGING_DIR/utils"
cp -R "$ROOT_DIR/web"       "$STAGING_DIR/web"

# Root webhook server, scripts, and project files.
cp "$ROOT_DIR/serve.js"     "$STAGING_DIR/"
cp "$ROOT_DIR/ecosystem.config.cjs" "$STAGING_DIR/"
cp "$ROOT_DIR/hooks.example.json" "$STAGING_DIR/"
cp "$ROOT_DIR/start.sh"     "$STAGING_DIR/"
cp "$ROOT_DIR/stop.sh"      "$STAGING_DIR/"
cp "$ROOT_DIR/cli.js"       "$STAGING_DIR/"
cp "$ROOT_DIR/functions.js" "$STAGING_DIR/"
cp "$ROOT_DIR/config.schema.json" "$STAGING_DIR/"
cp "$ROOT_DIR/setup.sh"     "$STAGING_DIR/"
cp "$ROOT_DIR/get.sh"       "$STAGING_DIR/"
cp "$ROOT_DIR/install.sh"   "$STAGING_DIR/"
cp "$ROOT_DIR/uninstall.sh" "$STAGING_DIR/"
cp "$ROOT_DIR/restart.sh"   "$STAGING_DIR/"
cp "$ROOT_DIR/release.sh"   "$STAGING_DIR/"
cp "$ROOT_DIR/release_gh.sh" "$STAGING_DIR/"
cp "$ROOT_DIR/package.json" "$STAGING_DIR/"
cp "$ROOT_DIR/README.md"    "$STAGING_DIR/"
cp "$ROOT_DIR/LICENSE"      "$STAGING_DIR/"
cp "$ROOT_DIR/VERSION"      "$STAGING_DIR/"

# setup.sh runs `pnpm i && pnpm run build` in the unpacked release, so the
# lockfile and the workspace file (its allowBuilds entry lets esbuild build)
# both have to ship or that build fails on the target machine.
# Trailing `|| true` so a missing optional file leaves a zero status here, and
# these stay safe to move around — a bare `[ -f x ] && cp x y` as the last
# command of the script would fail the whole release.
[ -f "$ROOT_DIR/pnpm-lock.yaml" ]      && cp "$ROOT_DIR/pnpm-lock.yaml"      "$STAGING_DIR/" || true
[ -f "$ROOT_DIR/pnpm-workspace.yaml" ] && cp "$ROOT_DIR/pnpm-workspace.yaml" "$STAGING_DIR/" || true

# Optional dotfiles worth shipping (never config.json — that holds the secret).
[ -f "$ROOT_DIR/.gitignore" ] && cp "$ROOT_DIR/.gitignore" "$STAGING_DIR/" || true

# Strip anything machine-specific that a function folder may contain.
find "$STAGING_DIR" \
    \( -name "config.json" -o -name "config.json.tmp" -o -name ".env" -o -name "hooks.json" \
       -o -name "*.command" -o -name ".DS_Store" -o -name "*.log" -o -name "*.log.[0-9]" \) \
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
