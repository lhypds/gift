
list-weekly-prs
===============


List GitHub Pull Requests by a chosen week, grouped by date.


Files
-----

| File                 | Description                                                                     |
|----------------------|---------------------------------------------------------------------------------|
| `list_weekly_prs.sh` | Core logic script — run through `gift list`, or directly from the terminal      |
| `run.command`        | macOS double-clickable launcher — calls the script with preconfigured repos     |

`run.command` is git-ignored; copy `../../run.command.example` and edit it.


Usage
-----

```bash
gift list [--repos=owner/repo1,owner/repo2] [--author=login] [--weeks=N] [-v]
```

(`gift list` is the short form of `gift list-weekly-prs`. The script also runs
on its own: `./list_weekly_prs.sh`.)

Unless `--weeks` is given, the script asks:

```
How many weeks ago? (default: 1, 0 = current week, 1 = last week, 2 = week before last, ...):
```

Weeks run Monday to Sunday.


Parameters
----------

| Parameter                       | Description                                                | Default        |
|---------------------------------|------------------------------------------------------------|----------------|
| `--repos=owner/repo1,owner/repo2` | Comma-separated repositories to query                    | `$GIFT_REPOS`  |
| `--author=login`                | GitHub login whose pull requests are listed                | `$GIFT_AUTHOR` |
| `--weeks=N`                     | How many weeks back (0 = current week); skips the prompt   | asks           |
| `-v`                            | Verbose mode — shows PR number, state, and URL for each PR | off            |
| `-h`, `--help`                  | Show the help message and exit                             |                |

`GIFT_REPOS` and `GIFT_AUTHOR` come from the repo's `.env`, so the common case
needs no flags at all.


Examples
--------

```bash
# Last week, repositories from .env
gift list

# Current week, custom repositories
gift list --repos=myorg/myrepo --weeks=0

# Two weeks ago, someone else's PRs, verbose output
gift list --repos=myorg/myrepo --author=octocat --weeks=2 -v
```


Requirements
------------

- [GitHub CLI (`gh`)](https://cli.github.com/) — must be installed and authenticated
- [`jq`](https://stedolan.github.io/jq/) — used for JSON parsing and output formatting
