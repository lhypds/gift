clone-repos
===========


Clone every repository a GitHub organization has into one folder.


Files
-----

| File                 | Description                                                                  |
|----------------------|------------------------------------------------------------------------------|
| `main.js`            | Core logic script — run through `gift clone-repos`, or with `node main.js`   |
| `config.schema.json` | The settings this function has, and their defaults — see `functions.clone-repos` in config.json |


Usage
-----

```bash
gift clone-repos [options] [organization]
```

(`gift clone` is enough of the name.)

Everything the token can reach is cloned: the public repositories, the private
ones you are a member of, the forks and the archived ones. Each arrives as a
folder of its own, named after the repository, side by side in the destination.

```bash
# Into the current directory, after asking which organization
gift clone-repos

# The name on the command line skips the question
gift clone-repos linktivity

# Somewhere of its own
gift clone-repos --out ~/code/linktivity linktivity
```

Without the name, it is asked for:

```
Organization: linktivity
```

The URL of the organization's page is an answer too — `https://github.com/linktivity`,
or the repositories tab, `https://github.com/orgs/linktivity/repositories` — so
it can be pasted straight out of the browser. `@linktivity` works as well.

A name that is nobody's organization is tried as a user account, so
`gift clone-repos octocat` clones a person's repositories. Your own login is
read from a different place than anyone else's, which is what makes
`gift clone-repos <your-login>` bring the private ones too.


What it prints
--------------

```
Organization:  linktivity
Found:         42 repositories · 31 private · 2 archived
Destination:   ~/code/linktivity
Protocol:      https

  [ 1/42] ars-neo-miniapp         cloned
  [ 2/42] wechat-mini-app         skipped — already here
  [ 3/42] tata-frontend           cloned
  ...

40 cloned · 2 skipped — ~/code/linktivity
```

A repository already in the destination is left exactly as it is — not fetched,
not touched — so running the command again a month later clones what is new and
nothing else. `--pull` makes those a `git pull --ff-only` instead, which turns
the same command into a way of catching a whole organization up.

Clones run several at a time, so git's own progress output would be four
conversations at once; it is kept instead, and only what a failure said is
printed. A clone that dies part-way leaves nothing behind: the half-written
folder is removed, so the next run tries it again rather than reading it as one
already cloned.


Parameters
----------

| Parameter          | Description                                                       | Default                    |
|--------------------|-------------------------------------------------------------------|----------------------------|
| `[organization]`   | The organization, user, or the URL of either                      | asks                       |
| `-o`, `--out DIR`  | Folder the clones land in (`--out=DIR` also works)                | the current directory      |
| `--ssh`            | Clone over SSH rather than HTTPS                                  | off                        |
| `--https`          | Clone over HTTPS                                                  | on                         |
| `--no-archived`    | Leave archived repositories out                                   | off — archived ones are cloned |
| `--no-forks`       | Leave forks out                                                   | off — forks are cloned     |
| `--depth N`        | Shallow clone, N commits deep                                     | the whole history          |
| `-j`, `--jobs N`   | How many clones at a time                                         | 4                          |
| `--pull`           | Update repositories already cloned rather than skipping them      | off                        |
| `-n`, `--dry-run`  | List what would be cloned, and where, without cloning it          | off                        |
| `-h`, `--help`     | Show the help message and exit                                    |                            |

`clone_dir`, `protocol` and `jobs` are settings as well as flags: set them under
`functions.clone-repos` in config.json (`gift config` opens it) and they reach
the script as `GIFT_CLONE_DIR`, `GIFT_CLONE_PROTOCOL` and `GIFT_CLONE_JOBS`. A
value already in the environment wins over the configuration, and a flag wins
over both.

`--depth` is git's own, so a shallow clone comes with git's own consequence: one
branch rather than all of them. `git fetch --unshallow` fills the history back
in later.


Private repositories, and the request limit
-------------------------------------------

Public repositories need no credentials, but GitHub allows an unauthenticated
machine 60 requests an hour and shows it only what is public — an organization
listed without a token is the public half of itself. A token lifts the limit to
5000 and is what the private repositories need. It is looked for in this order:

1. `token` under `functions.clone-repos` in config.json, which reaches the
   script as `GIFT_GITHUB_TOKEN`
2. `GITHUB_TOKEN`, then `GH_TOKEN`, in the environment
3. `gh auth token` — so a signed-in [`gh`](https://cli.github.com/) needs no
   setting at all

The token wants the `repo` scope, and on an organization with SAML single
sign-on it has to be authorized for that organization as well, which GitHub
offers on the token's own page.

Over HTTPS that same token is what git clones with: it is handed over through a
`GIT_ASKPASS` helper written for the run and deleted after it, never on the
command line where `ps` would show it, and the credential helpers are turned off
for these clones so that nothing writes it into a keychain. Nothing is left in
the clone either — the remote URL is the plain `https://github.com/...` one, and
a `git pull` in it later uses whatever credentials that machine normally uses.

Over SSH (`--ssh`) the token only lists the repositories; the key already on the
machine is what clones them.

Whichever way, git is told not to stop for a prompt (`GIT_TERMINAL_PROMPT=0`) —
with four clones running at once, a question would come from nowhere in
particular. A repository that cannot be read fails with what git said, and the
rest carry on.


Examples
--------

```bash
# Ask which organization, clone it here
gift clone-repos

# A whole organization into a folder of its own
gift clone-repos --out ~/code/linktivity linktivity

# The living half of it, over SSH
gift clone-repos --ssh --no-archived --no-forks linktivity

# See what there is first
gift clone-repos --dry-run linktivity

# The latest of everything, without the history
gift clone-repos --depth 1 --jobs 8 linktivity

# Catch up an organization cloned last month
gift clone-repos --pull --out ~/code/linktivity linktivity

# A person rather than an organization
gift clone-repos octocat
```

The exit status is 0 when everything asked for arrived, 2 for an organization or
an option that could not be read, 130 for a question answered with Ctrl-C, and 1
for anything else — no such organization, GitHub refusing to answer, or one or
more repositories that would not clone.


Requirements
------------

- `git`, which does the cloning
- Node 18 or newer, which gift itself requires
- [GitHub CLI (`gh`)](https://cli.github.com/) — optional, and only as a source
  of a token for private repositories
