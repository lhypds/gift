#!/bin/bash
# Recursively find git repositories (directories containing a .git folder)
# and run `git pull` in each one. Supports a dry-run mode.
# Usage: ./recursively-pull-repos.sh [-n|--dry-run] [-h|--help]

set -euo pipefail
IFS=$'\n\t'

DRY_RUN=0

usage() {
	cat <<-USAGE
Usage: ${0##*/} [options]

Options:
	-n, --dry-run   Show the git commands that would be executed without running them
	-h, --help      Show this help message

This script searches the current directory recursively for directories named
.git (i.e. git repositories) and runs 'git pull --recurse-submodules --autostash'
in each repository's root.
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		-n|--dry-run) DRY_RUN=1; shift ;;
		-h|--help) usage; exit 0 ;;
		--) shift; break ;;
		-* ) echo "Unknown option: $1" >&2; usage; exit 2 ;;
		* ) break ;;
	esac
done

echo "Searching for git repositories under: $(pwd)"

found=0
failures=0

while IFS= read -r g; do
	[ -z "$g" ] && continue
	found=1
	repo_dir=$(dirname "$g")
	if repo_abs=$(cd "$repo_dir" 2>/dev/null && pwd -P); then
		repo_dir="$repo_abs"
	fi

	printf "\n----\nRepository: %s\n" "$repo_dir"

	cmd=(git -C "$repo_dir" pull --recurse-submodules --autostash)

	if [ "$DRY_RUN" -eq 1 ]; then
		echo "[dry-run] $(printf '%s ' "${cmd[@]}")"
		continue
	fi

	echo "Running: $(printf '%s ' "${cmd[@]}")"
	if "${cmd[@]}"; then
		echo "OK: $repo_dir"
	else
		echo "ERROR: git pull failed for $repo_dir" >&2
		failures=$((failures + 1))
	fi
done < <(find . -type d -name .git -prune 2>/dev/null)

if [ "$found" -eq 0 ]; then
	echo "No git repositories found."
	exit 0
fi

if [ $failures -gt 0 ]; then
    printf "\nFinished with %d failures.\n" "$failures" >&2
    exit 2
fi

printf "\nAll repositories updated successfully.\n"
