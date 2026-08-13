repo-master
===========


Watch every git repository under one folder in a live table, and open the ones that moved.


A folder full of half-finished projects is hard to hold in your head. repo-master
finds every repository under it — nested checkouts and submodules included —
and keeps one table up to date: which branch each one is on, whether the working
tree has changes, and how many lines that is.
Rows that want attention wear an orange bar. Press d to read what changed, and
enter to go to one's folder, to open them in VS Code, Claude Code or Codex — the
first one picked is the main project, and the rest come along with it — or to
commit and push every repository you picked with one message.

```
Repo Master v0.0.1
Watching ~/projects · 12 repos · 3 changed · 2 open PRs
---------------------------------------------------------------------------------------------------------
  repo                 path                 branch  status       last updated  diff
> lhypds/gift          ./gift               main    has changes  1min ago      +1203 lines -30 lines
 +gcc3/gcc3-content    ./gcc3               master  no changes   -             -
    +- gcc3/content-hub  ./gcc3/public/notes  main  has changes  just now      +3 lines
---------------------------------------------------------------------------------------------------------
up/down move · space select · enter run · d preview · esc clear · r refresh · q quit
```


Files
-----

| File            | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `main.js`       | Entry point — run through `gift repo-master`, or directly with `node`        |
| `lib/repos.js`  | Finding the repositories and working out which sits inside which             |
| `lib/git.js`    | Branch, working-tree changes, diff size, the time of the last change, and committing and pushing |
| `lib/watch.js`  | Hearing about edits, with a timer as the fallback                            |
| `lib/table.js`  | The table itself, which rows are orange, and what goes in each box           |
| `lib/modal.js`  | The box they are all drawn in, over the table                                |
| `lib/screen.js` | The alternate screen and the keys                                            |
| `lib/actions.js`| Opening the chosen repositories in VS Code, Claude Code or Codex, and committing them |
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
| space           | Add the row to the selection and step down — the first one added is the main project, the rest are marked `+` |
| enter           | Open the command menu for the selection, or the row under the cursor |
| d               | Preview what changed in the row under the cursor            |
| esc             | Clear the selection, or close whichever box is open          |
| r               | Rescan and refresh everything now                           |
| q, Ctrl-C       | Quit                                                        |

The menu is a box over the table, as the preview is, and as everything else that
interrupts the table is. In it the number keys run a command straight away;
up/down or j/k and then enter do the same thing more slowly. The commands are:

| Command               | Runs                                                          |
|-----------------------|----------------------------------------------------------------|
| goto folder           | your shell, standing in the main project's folder              |
| open with vscode      | `code <main project>`                                          |
| open with claude code | `claude` in the main project, with `--add-dir` for each added repository |
| open with codex       | `codex` in the main project, the same way                      |
| commit & push         | `git add -A`, `git commit` and `git push` in **every** picked repository — see below |

A selection has a shape. The repository picked first is the **main project** and
wears no mark; the ones picked after it are marked `+`. VS Code opens the main
project — a window is a window, and the marked repositories were not asked for.
`claude` and `codex` open the main project too, and are handed the marked ones as
directories they may also work in. Both want a terminal of their own and borrow
this one: the table steps aside and comes back when the tool exits.

`goto folder` is the same borrowing with a shell as the tool. No program can move
the shell that started it, so the folder is reached by a shell of its own
standing in it — your `$SHELL`, with your prompt and your aliases. Work there as
usual; `exit`, or Ctrl-D, ends it. That one ends repo-master with it, rather than
putting the table back: somewhere else is what the command was for, and a table
in front of somebody on their way out is one screen too many. The tools above
keep the table, because opening one is something you do between looks at it.

The commands can be pointed somewhere else, for anyone whose tools are named
differently. These are not written into config.json — their defaults suit nearly
everybody — so add the line yourself under `functions.repo-master` when you want
one:

```json
"vscode_command": "cursor"
```

| Setting            | Default  | What it runs                                  |
|--------------------|----------|------------------------------------------------|
| `shell_command`    | `$SHELL` | `goto folder`; `sh` when there is no `$SHELL`   |
| `vscode_command`   | `code`   | `open with vscode`; `cursor` and `windsurf` take the same argument |
| `claude_command`   | `claude` | `open with claude code`                        |
| `codex_command`    | `codex`  | `open with codex`                              |
| `claude_add_dir`   | `--add-dir` | How `claude` is told about the repositories added to the main one, once each. `false` opens the main project alone |
| `codex_add_dir`    | `--add-dir` | The same for `codex`, for a version that spells the option differently |


Committing and pushing
----------------------

`commit & push` is the one command that treats every picked repository as a
project of its own: there is no main project to make of the others, because a
commit belongs to one repository and nothing else. It asks for a message first,
in a box listing what it is about to commit:

```
    +- Commit message -----------------------------------------------+
    | fix: 修复表格宽度_                                              |
    |                                                                |
    | lhypds/gift       +1203 lines -30 lines                        |
    | gcc3/content-hub  +3 lines                                     |
    +- 3 repos · enter commit & push · esc back ---------------------+
```

Type the message and press enter; esc goes back to the menu, and an empty message
is refused. Backspace and the left/right arrows work as they do anywhere, and so
do Ctrl-U to clear the line, Ctrl-A and Ctrl-E to reach its ends. Every other key
is a character here — `q` types a q rather than quitting.

Each repository then has everything in its working tree staged, tracked changes
and untracked files alike — the same changes the row counts, and nothing
belonging to a repository nested inside it — committed with your message, and
pushed. A few are worked on at once, and one that fails takes none of the others
down with it. The box stays up and fills in as they finish:

```
    +- commit & push · "fix: 修复表格宽度" ---------------------------+
    | lhypds/gift       committed 8ac1f2e · pushed                   |
    | gcc3/content-hub  pushing…                                     |
    | lhypds/conf       waiting…                                     |
    +- 1 of 3 done · working… ---------------------------------------+
```

Green is a repository that committed and pushed, grey one that had nothing to do,
orange one that could not. Nothing else in repo-master answers while it runs;
`esc` closes the box afterwards, and the table refreshes itself.

Nothing to commit is not a failure — a repository whose commits never left the
machine is pushed anyway. One with neither is left alone rather than made to
reach across a network to be told it is up to date. A branch that has never been
pushed is given `origin` as its upstream when there is a commit to carry there,
which is the `git push --set-upstream origin <branch>` git itself suggests. A
repository with a detached HEAD is not touched at all: it says so and stays as it
was.


The preview
-----------

`d` opens a box over the table holding the row's changes: the patch against HEAD,
and then the untracked files, which no patch mentions because git has never seen
them. Nested repositories are left out of both, the way they are left out of the
row — they have a row of their own, and a `d` of their own.

```
    +- lhypds/gift · main · +1203 lines -30 lines ----------------------------+
    | diff --git a/cli.js b/cli.js                                            |
    | @@ -1,4 +1,5 @@                                                         |
    |  'use strict';                                                          |
    | -const { run } = require('./functions.js');                             |
    | +const { run, list } = require('./functions.js');                       |
    +- 1-5 of 87 · up/down scroll · space page · r reload · esc close --------+
```

| Key             | Does                                                        |
|-----------------|-------------------------------------------------------------|
| up / down, k / j| Scroll a line                                               |
| space           | Turn the page                                               |
| g, G            | Jump to the top, or to the end                              |
| r               | Read the changes again                                      |
| esc, q, d       | Close the box                                               |

The title carries the repository, its branch and the size of the diff, and keeps
up with the table underneath. The patch does not: it is the one read when the box
opened, because a page of text moving under somebody reading it is no kindness. A
file saved while you read it moves the title and leaves the text alone — `r` then
fetches the rest.

A patch longer than 5000 lines is cut, with a note saying how much was left off.
Binary files are named rather than printed, as git names them.


Parameters
----------

| Parameter               | Description                                           | Default |
|-------------------------|--------------------------------------------------------|---------|
| `DIR`, `--repo-root=PATH` | Folder to watch (`--dir=PATH` is the older spelling) | the configured `repo_root`, else the current directory |
| `--depth=N`             | How many folders deep to look for repositories         | 4       |
| `--refresh=SEC`         | Seconds between full sweeps — new repositories included | 30     |
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

Every `--refresh` seconds the whole folder is scanned again, so a repository you
cloned a minute ago shows up on its own, and one you deleted goes away.


Examples
--------

```bash
# Watch the folder you are standing in
cd ~/projects && gift repo-master

# Watch somewhere else, deeper than the default
gift repo-master ~/work --depth=6

# One snapshot, no watching; useful in a pipe
gift repo-master --once
```


Requirements
------------

- `git` — must be installed and available in PATH
- A terminal. `code`, `claude` and `codex` are only needed if you use them
