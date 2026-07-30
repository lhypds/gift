recursively-pull-repos
======================


Recursively find all git repositories under the current directory and run `git pull` in each one.


Files
-----

| File                        | Description                                                                |
|-----------------------------|-----------------------------------------------------------------------------|
| `recursively-pull-repos.sh` | Core logic script — run through `gift recur`, or directly from the terminal |
| `run.command`               | macOS double-clickable launcher                                            |

`run.command` is git-ignored; copy `../../run.command.example` and edit it.


Usage
-----

```bash
gift recur [options]
```

(`gift recur` is the short form of `gift recursively-pull-repos`.)

The command searches **your current directory** recursively for `.git` folders
and runs `git pull --recurse-submodules --autostash` in each repository root —
so `cd` to the folder holding your repos first. Copying the script around is no
longer necessary.


Parameters
----------

| Parameter         | Description                                                            |
|-------------------|------------------------------------------------------------------------|
| `-n`, `--dry-run` | Show the commands that would be executed without actually running them |
| `-h`, `--help`    | Show the help message and exit                                         |


Examples
--------

```bash
# Pull every repo under ~/code
cd ~/code && gift recur

# Preview what would be pulled without making any changes
gift recur --dry-run
```

The exit status is 2 if any repository failed to pull.


Requirements
------------

- `git` — must be installed and available in PATH
