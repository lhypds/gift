repo-master
===========


Watch every git repository under one folder in a live table, and open the ones that moved.


A folder full of half-finished projects is hard to hold in your head. repo-master
finds every repository under it — nested checkouts and submodules included —
and keeps one table up to date: which branch each one is on, whether the working
tree has changes, how many lines that is, and how many pull requests are open.
Rows that want attention turn orange. Pick them and press enter to open them in
VS Code, Claude Code or Codex.

```
Repo Master v0.0.1
Watching ~/projects · 12 repos · 3 changed · 2 open PRs
---------------------------------------------------------------------------------------------------------
  repo                 path                 branch  pr  status       last updated  diff
> lhypds/gift          ./gift               main    0   has changes  1min ago      +1203 lines -30 lines
  gcc3/gcc3-content    ./gcc3               master  0   no changes   -             -
    +- gcc3/content-hub  ./gcc3/public/notes  main  0   has changes  just now      +3 lines
---------------------------------------------------------------------------------------------------------
up/down move · space select · enter run · esc clear · r refresh · q quit
```


Files
-----

| File            | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `main.js`       | Entry point — run through `gift repo-master`, or directly with `node`        |
| `lib/repos.js`  | Finding the repositories and working out which sits inside which             |
| `lib/git.js`    | Branch, working-tree changes, diff size and the time of the last change      |
| `lib/gh.js`     | Open pull requests, counted with `gh` and paced to stay inside GitHub's limits |
| `lib/watch.js`  | Hearing about edits, with a timer as the fallback                            |
| `lib/table.js`  | The table itself, and which rows are orange                                  |
| `lib/screen.js` | The alternate screen and the keys                                            |
| `lib/actions.js`| Opening the chosen repositories in VS Code, Claude Code or Codex             |
| `config.schema.json` | The settings this function has, and their defaults — see `functions.repo-master` in config.json |


Usage
-----

```bash
gift repo-master [DIR] [options]
```

(`gift repo` is enough of the name.)

`DIR` is **your current directory** unless the positional argument,
`--repo-root` or the configured `repo_root` names another one. The usual way is
to set the folder once and forget it — `gift config` opens the file:

```json
{
    "functions": {
        "repo-master": { "repo_root": "/Users/me/projects" }
    }
}
```

```bash
gift repo-master        # from anywhere at all
```

Write `repo_root` as an absolute path, so it means the same folder whatever
directory you run from.


Keys
----

| Key             | Does                                                        |
|-----------------|-------------------------------------------------------------|
| up / down, k / j| Move the cursor                                             |
| space           | Add the row to the selection and step down                  |
| enter           | Open the command menu for the selection, or the row under the cursor |
| esc             | Clear the selection, or close the menu                      |
| r               | Rescan and refresh everything now                           |
| q, Ctrl-C       | Quit                                                        |

In the menu, `1`, `2` and `3` run a command straight away; up/down and enter do
the same thing more slowly. The commands are:

| Command               | Runs                                                          |
|-----------------------|----------------------------------------------------------------|
| open with vscode      | `code <repo>` for each chosen repository                       |
| open with claude code  | `claude` in each chosen repository                            |
| open with codex       | `codex` in each chosen repository                              |

`claude` and `codex` want a terminal of their own. With one repository chosen
they borrow this one — the table steps aside and comes back when the tool exits.
With several, each gets a new terminal window (Terminal or iTerm on macOS, the
usual suspects on Linux, or whatever the `terminal_command` setting names).

All three commands can be pointed somewhere else, for anyone whose tools are
named differently. These four are not written into config.json — their defaults
suit nearly everybody — so add the line yourself under `functions.repo-master`
when you want one:

```json
"vscode_command": "cursor"
```

| Setting            | Default  | What it runs                                  |
|--------------------|----------|------------------------------------------------|
| `vscode_command`   | `code`   | `open with vscode`; `cursor` and `windsurf` take the same argument |
| `claude_command`   | `claude` | `open with claude code`                        |
| `codex_command`    | `codex`  | `open with codex`                              |
| `terminal_command` | guessed  | How a new terminal window is opened, for terminals the guesses miss |


Parameters
----------

| Parameter               | Description                                           | Default |
|-------------------------|--------------------------------------------------------|---------|
| `DIR`, `--repo-root=PATH` | Folder to watch (`--dir=PATH` is the older spelling) | the configured `repo_root`, else the current directory |
| `--depth=N`             | How many folders deep to look for repositories         | 4       |
| `--pr-interval=SEC`     | Seconds between rounds of pull request checks          | 10      |
| `--pr-rate=N`           | Most `gh` calls a minute, whatever the interval asks for | 60    |
| `--refresh=SEC`         | Seconds between full sweeps — new repositories included | 30     |
| `--no-pr`               | Do not ask GitHub about pull requests at all           | off     |
| `--once`                | Print the table once and exit, instead of watching     | off     |
| `-h`, `--help`          | Show the help message and exit                         |         |

Every default above is a setting of its own under `functions.repo-master` in
config.json — `gift config` opens it — including which commands the enter menu
runs. A value
already in the environment wins over the configuration, and a flag wins over
both.

Without a terminal to draw on — a pipe, a cron job — `--once` is assumed.


What the columns mean
---------------------

| Column       | Meaning                                                                 |
|--------------|--------------------------------------------------------------------------|
| repo         | `owner/repo` from the origin remote, or the folder name when there is none. `+-` marks a repository living inside the one above it |
| path         | Where it is, relative to the watched folder                             |
| branch       | The checked-out branch, or `(abc1234)` when HEAD is detached            |
| pr           | Open pull requests. `2 new` means two of them appeared after repo-master started. `-` means nobody could say |
| status       | Whether the working tree has anything uncommitted                       |
| last updated | When the newest of those changes was written — not when it was noticed  |
| diff         | Lines added and removed against HEAD, untracked files counted as added  |

A repository nested inside another has its own row, and its changes are left off
its parent's row rather than counted twice.


How fresh it is
---------------

Code changes are picked up as they happen: every repository is watched with a
recursive `fs.watch`, and a burst of edits is answered with a single `git status`
a moment later. Where recursive watching is unavailable, those repositories fall
back to a timer and the header says how many.

Pull requests cannot be watched, only asked about, so they are polled — one
repository per slot, spread evenly rather than all at once. GitHub allows an
authenticated account 5000 API points an hour; `--pr-rate` keeps repo-master to
60 calls a minute at the very most, which is 3600 an hour with plenty of room for
your own `gh` use. When there are more repositories than `--pr-interval` can get
through at that rate, the interval stretches instead of the limit breaking, and
the header says so: `pr every 24s`.

Every `--refresh` seconds the whole folder is scanned again, so a repository you
cloned a minute ago shows up on its own, and one you deleted goes away.


Examples
--------

```bash
# Watch the folder you are standing in
cd ~/projects && gift repo-master

# Watch somewhere else, deeper than the default
gift repo-master ~/work --depth=6

# Skip GitHub entirely — offline, or just quiet
gift repo-master --no-pr

# One snapshot, no watching; useful in a pipe
gift repo-master --once
```


Requirements
------------

- `git` — must be installed and available in PATH
- [GitHub CLI (`gh`)](https://cli.github.com/) — optional, and only for the pull
  request column; without it the column reads `-` and the header says why
- A terminal. `code`, `claude` and `codex` are only needed if you use them
