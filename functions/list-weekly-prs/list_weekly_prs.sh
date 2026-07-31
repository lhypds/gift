#!/bin/bash

# Script to list PRs by an author for a chosen week, grouped by date
# Usage: ./list_weekly_prs.sh [--repos=owner/repo1,owner/repo2] [--author=login] [--weeks=N] [-v]
#   --repos=owner/repo1,owner/repo2 : comma-separated list of repositories to query
#                                     (default: $GIFT_REPOS)
#   --author=login                  : GitHub login to list PRs for (default: $GIFT_AUTHOR)
#   --weeks=N                       : how many weeks back, skips the prompt
#   -v                              : verbose mode (show PR number, state, and URL)

REPOS=()
AUTHOR="${GIFT_AUTHOR:-}"
WEEKS_AGO=""
VERBOSE=false

usage() {
    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
}

# Parse flags
for arg in "$@"; do
    case "$arg" in
        --repos=*)
            IFS=',' read -ra REPOS <<< "${arg#--repos=}"
            ;;
        --author=*)
            AUTHOR="${arg#--author=}"
            ;;
        --weeks=*)
            WEEKS_AGO="${arg#--weeks=}"
            ;;
        -v)
            VERBOSE=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            usage
            exit 2
            ;;
    esac
done

# Fall back to the repositories configured in this function's .env
if [ ${#REPOS[@]} -eq 0 ] && [ -n "${GIFT_REPOS:-}" ]; then
    IFS=',' read -ra REPOS <<< "$GIFT_REPOS"
fi

# Validate repos
if [ ${#REPOS[@]} -eq 0 ]; then
    echo "Error: No repositories specified."
    echo "  Pass --repos=owner/repo1,owner/repo2, or set GIFT_REPOS in this function's .env"
    exit 1
fi

# Validate author
if [ -z "$AUTHOR" ]; then
    echo "Error: No author specified."
    echo "  Pass --author=login, or set GIFT_AUTHOR in this function's .env"
    exit 1
fi

# Ask user how many weeks ago
echo "=== PRs by $AUTHOR ==="
echo "Repositories: ${REPOS[*]}"
echo ""

if [ -z "$WEEKS_AGO" ]; then
    read -p "How many weeks ago? (default: 1, 0 = current week, 1 = last week, 2 = week before last, ...): " WEEKS_AGO
fi

if [ -z "$WEEKS_AGO" ]; then
    WEEKS_AGO=1
fi

# Validate input
if ! [[ "$WEEKS_AGO" =~ ^[0-9]+$ ]]; then
    echo "Error: Please enter a non-negative integer."
    exit 1
fi

# Calculate week range
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    offset_start=$(( WEEKS_AGO * 7 ))
    offset_end=$(( offset_start - 6 ))
    week_start=$(date -v-Mon -v-${offset_start}d +%Y-%m-%d)
    if [ "$WEEKS_AGO" -eq 0 ]; then
        week_end=$(date +%Y-%m-%d)
    else
        week_end=$(date -v-Mon -v-${offset_end}d +%Y-%m-%d)
    fi
else
    # Linux
    offset_start=$(( WEEKS_AGO * 7 ))
    offset_end=$(( (WEEKS_AGO - 1) * 7 ))
    week_start=$(date -d "last monday -${offset_start} days" +%Y-%m-%d)
    if [ "$WEEKS_AGO" -eq 0 ]; then
        week_end=$(date +%Y-%m-%d)
    else
        week_end=$(date -d "last monday -${offset_end} days" +%Y-%m-%d)
    fi
fi

if [ "$WEEKS_AGO" -eq 0 ]; then
    echo ""
    echo "=== PRs by $AUTHOR - Current Week ==="
else
    echo ""
    echo "=== PRs by $AUTHOR - $WEEKS_AGO week(s) ago ==="
fi
echo "Week: $week_start to $week_end"
echo ""

# Check if gh is installed
if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI (gh) is not installed."
    echo "Please install it from: https://cli.github.com/"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is not installed."
    echo "Please install it: brew install jq"
    pause
    exit 1
fi

# Get PRs from the author for the chosen week, for each repo
for REPO in "${REPOS[@]}"; do
    echo "--- $REPO ---"
    prs=$(gh pr list -R "$REPO" --state all --search "author:$AUTHOR created:$week_start..$week_end" --json number,title,createdAt,url,state --limit 100 2>&1)

    # Check if the command was successful
    if [ $? -ne 0 ]; then
        echo "Error fetching PRs for $REPO. Make sure you're authenticated with GitHub CLI."
        echo ""
        echo "Error details:"
        echo "$prs"
        echo ""
        continue
    fi

    # Parse and group by date
    if [ "$VERBOSE" = true ]; then
        result=$(echo "$prs" | jq -r '
          group_by(.createdAt | split("T")[0]) |
          .[] |
          "Date: \(.[0].createdAt | split("T")[0])\n" +
          (map("  • #\(.number) [\(.state)]: \(.title)\n    \(.url)") | join("\n")) + "\n"
        ')
    else
        result=$(echo "$prs" | jq -r '
          group_by(.createdAt | split("T")[0]) |
          .[] |
          "Date: \(.[0].createdAt | split("T")[0])\n" +
          (map("  • \(.title)") | join("\n")) + "\n"
        ')
    fi

    if [ -z "$result" ]; then
        echo "No PRs found for author $AUTHOR during the selected week."
    else
        echo "$result"
    fi
    echo ""
done
