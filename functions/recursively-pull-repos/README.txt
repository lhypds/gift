recursively-pull-repos
======================


Recursively find all git repositories under the current directory and run `git pull` in each one.


Files
-----

| File                        | Description                                                                |
|-----------------------------|-----------------------------------------------------------------------------|
| `recursively-pull-repos.sh` | Core logic script — run through `gift recur`, or directly from the terminal |
| `.env.example`              | Template for this function's own settings — copied to `.env` by `./setup.sh` |


Usage
-----

```bash
gift recur [--dir=PATH] [options]
```

(`gift recur` is the short form of `gift recursively-pull-repos`.)

The function searches one directory recursively for `.git` folders and runs
`git pull --recurse-submodules --autostash` in each repository root. That
directory is **your current directory**, unless `--dir` or `GIFT_PULL_DIR`
names another one — so either `cd` to the folder holding your repos, or set it
once in `.env` and run the function from anywhere.


Parameters
----------

| Parameter         | Description                                                            | Default           |
|-------------------|------------------------------------------------------------------------|-------------------|
| `--dir=PATH`      | Folder to search for git repositories                                  | `$GIFT_PULL_DIR`, else the current directory |
| `-n`, `--dry-run` | Show the commands that would be executed without actually running them | off               |
| `-h`, `--help`    | Show the help message and exit                                         |                   |

`GIFT_PULL_DIR` comes from this folder's `.env` (git-ignored; copy
`.env.example`), so a fixed repos folder needs no flag at all. A value already
in the environment wins over that file, and the file wins over the repo's
`../../.env`. A leading `~` in the value is expanded, and a relative path is
resolved against the current directory.


Examples
--------

```bash
# Pull every repo under the current directory
cd ~/code && gift recur

# Pull every repo under a folder chosen on the spot
gift recur --dir=~/work

# Pull every repo under GIFT_PULL_DIR, from wherever you happen to be
gift recur

# Preview what would be pulled without making any changes
gift recur --dry-run
```

The exit status is 2 if any repository failed to pull.


Requirements
------------

- `git` — must be installed and available in PATH
