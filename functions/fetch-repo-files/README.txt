fetch-repo-files
================


Copy a folder or a single file out of a GitHub repository into the current directory.


Files
-----

| File                 | Description                                                                    |
|----------------------|--------------------------------------------------------------------------------|
| `main.js`            | Core logic script — run through `gift fetch-repo-files`, or with `node main.js` |
| `config.schema.json` | The settings this function has, and their defaults — see `functions.fetch-repo-files` in config.json |


Usage
-----

```bash
gift fetch-repo-files [options] <url>
```

(`gift fetch` is enough of the name.)

Nothing is cloned and no `.git` folder is left behind. A folder arrives as a
plain folder in **your current directory**, named after the last part of the
path; a file arrives as a plain file, named after itself. Without `--branch` it
is the repository's default branch that is read.

```bash
# The whole repository, into ./ai
gift fetch-repo-files "https://github.com/lhypds/ai"

# One file, into ./a.txt
gift fetch-repo-files --file "https://github.com/lhypds/ai/a.txt"

# From a branch other than the default
gift fetch-repo-files --branch abs "https://github.com/lhypds/ai"
```


URLs it takes
-------------

Whatever the browser is showing, and the short forms people actually type:

| URL                                                        | What is fetched                       |
|------------------------------------------------------------|---------------------------------------|
| `https://github.com/owner/repo`                            | the whole repository, into `./repo`   |
| `https://github.com/owner/repo/tree/main/src/utils`        | that folder, into `./utils`           |
| `https://github.com/owner/repo/blob/main/docs/a.txt`       | that file, into `./a.txt`             |
| `https://raw.githubusercontent.com/owner/repo/main/a.txt`  | that file, into `./a.txt`             |
| `https://github.com/owner/repo/src/utils`                  | the short form — a path written straight after the repository |
| `github.com/owner/repo`, `owner/repo`, `git@github.com:owner/repo.git` | the whole repository      |

A `?tab=…` or `#L20` on the end is ignored, as is a trailing `.git`.

`/blob/` and raw links say for themselves that they name a file, so `--file` is
not needed with them — it is for the short form, where nothing in the URL says
whether `a.txt` is a file or a folder. Left off, the short form is read as a
folder, and a path that turns out to name a file is fetched as one anyway; the
flag is what saves downloading the repository to find that out.

A `/tree/` or `/blob/` URL runs the branch and the path together, and a branch
may hold slashes, so `tree/feature/api` is either the branch `feature/api` or
the folder `api` on the branch `feature`. GitHub is asked which, shortest first,
and the first one that names a real commit is used.


Parameters
----------

| Parameter          | Description                                                     | Default                    |
|--------------------|-------------------------------------------------------------------|----------------------------|
| `<url>`            | The repository, folder or file to fetch                         | required                   |
| `-f`, `--file`     | Fetch one file rather than a folder                             | off                        |
| `-b`, `--branch N` | Branch, tag or commit to read (`--branch=N` also works)         | the repository's default branch |
| `-o`, `--out DIR`  | Folder to put it in (`--out=DIR` also works)                    | the current directory      |
| `--force`          | Overwrite what is already there                                 | off                        |
| `-n`, `--dry-run`  | Say what would be fetched, and where, without fetching it       | off                        |
| `-h`, `--help`     | Show the help message and exit                                  |                            |

Without `--force`, a destination that already exists stops the run rather than
being written over. With it, a fetched folder is laid over the one that is
there: same-named files are replaced and anything else in the folder is left
where it is.

`--branch` wins over a branch named in the URL — the path is kept and the branch
swapped, so `--branch dev …/tree/main/src` reads `src` on `dev`.

`out` is a setting as well as a flag: set it under `functions.fetch-repo-files`
in config.json (`gift config` opens it) and it reaches the script as
`GIFT_FETCH_OUT`. A value already in the environment wins over the
configuration, and a flag wins over both.


Private repositories, and the request limit
-------------------------------------------

Public repositories need no credentials, but GitHub allows an unauthenticated
machine 60 requests an hour — enough for a handful of fetches, not for a loop.
A token lifts that to 5000 and is what a private repository needs. It is looked
for in this order:

1. `token` under `functions.fetch-repo-files` in config.json, which reaches the
   script as `GIFT_GITHUB_TOKEN`
2. `GITHUB_TOKEN`, then `GH_TOKEN`, in the environment
3. `gh auth token` — so a signed-in [`gh`](https://cli.github.com/) needs no
   setting at all

The token wants the `repo` scope for private repositories; nothing at all is
needed for public ones.


Examples
--------

```bash
# The whole repository, into the current directory
gift fetch-repo-files "https://github.com/lhypds/ai"

# One file
gift fetch-repo-files --file "https://github.com/lhypds/ai/a.txt"
gift fetch-repo-files "https://github.com/lhypds/ai/blob/master/a.txt"

# One folder out of a repository
gift fetch-repo-files "https://github.com/lhypds/ai/tree/master/prompts"

# From another branch, or a tag, or a commit
gift fetch-repo-files --branch abs "https://github.com/lhypds/ai"
gift fetch-repo-files --branch v1.2.0 "https://github.com/lhypds/ai"

# Somewhere other than here, over whatever is already there
gift fetch-repo-files --out ~/tmp --force "https://github.com/lhypds/ai"

# Say what would happen and stop
gift fetch-repo-files --dry-run "https://github.com/lhypds/ai/tree/master/prompts"
```

The exit status is 0 when what was asked for arrived, 2 for a URL or an option
that could not be read, and 1 for anything else — no such repository, branch or
path, a destination already there without `--force`, or GitHub refusing to
answer.


Requirements
------------

- `tar` — used to unpack the folder download; installed as standard on macOS and Linux
- Node 18 or newer, which gift itself requires
- [GitHub CLI (`gh`)](https://cli.github.com/) — optional, and only as a source
  of a token for private repositories
