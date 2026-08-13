
repo-master
===========


Watch every git repository under one folder in a live table, and open the ones that moved.


A folder full of half-finished projects is hard to hold in your head. repo-master
finds every repository under it — nested checkouts and submodules included —
and keeps one table up to date: which branch each one is on, whether the working
tree has changes, and how many lines that is.
Rows that want attention wear an orange bar. Press enter for the menu of what may
be done to them — open one in an editor or an agent, read its diff, fetch, pull,
branch a worktree off it, commit and push the lot, delete a folder outright — or
press the key the menu prints beside the command you wanted. `/` finds a
repository in a folder too full to read.

```
Repo Master v0.0.1


Watching ~/projects · 12 repos · 3 changed · 2 open PRs
---------------------------------------------------------------------------------------------------------

  repo                 path                 branch  status       last updated  diff
> lhypds/gift          ./gift               main    has changes  1min ago      +1203 lines -30 lines
 +gcc3/gcc3-content    ./gcc3               master  no changes   -             -


    +- gcc3/content-hub  ./gcc3/public/notes  main  has changes  just now      +3 lines
---------------------------------------------------------------------------------------------------------

up/down move · space select · enter menu · / search · e code · v vim · c claude · d diff · f fetch · p pull · …
```


Files
-----

| File                 | Description                                                                                                               |
|----------------------|---------------------------------------------------------------------------------------------------------------------------|
| `main.js`            | Entry point — run through `gift repo-master`, or directly with `node`                                                     |
| `lib/repos.js`       | Finding the repositories, working out which sits inside which, and which of them a search leaves showing                  |
| `lib/git.js`         | Branch, working-tree changes, diff size, the time of the last change, committing and pushing, and adding a worktree       |
| `lib/watch.js`       | Hearing about edits, with a timer as the fallback                                                                         |
| `lib/table.js`       | The table itself, which rows are orange, and what goes in each box                                                        |
| `lib/modal.js`       | The box they are all drawn in, over the table                                                                             |
| `lib/screen.js`      | The alternate screen and the keys                                                                                         |
| `lib/actions.js`     | The one list of commands, and what each one does to the repositories picked                                               |
| `config.schema.json` | The settings this function has, and their defaults — see `functions.repo-master` in config.json                           |


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

| Key              | Does                                                                                                          |
|------------------|---------------------------------------------------------------------------------------------------------------|
| up / down, k / j | Move the cursor                                                                                               |
| space            | Add the row to the selection and step down — the first one added is the main project, the rest are marked `+` |
| enter            | Open the command menu for the selection, or the row under the cursor                                          |
| e                | Open the main project in your editor, straight away                                                           |
| v                | Open the main project in vim, in this terminal                                                                |
| c                | Open the main project in Claude Code, in this terminal                                                        |
| d                | Read the diff of the row under the cursor                                                                     |
| f                | Fetch everything picked, after a box asking whether to                                                        |
| p                | Pull everything picked, after a box asking whether to                                                         |
| t then a         | Add a worktree to everything picked, after a box asking for the branch                                        |
| D                | Delete the folders of everything picked, after a box asking in earnest                                        |
| /                | Search: narrow the table to the repositories matching what you type                                           |
| esc              | Clear the search, then the selection — or close whichever box is open                                         |
| r                | Rescan and refresh everything now                                                                             |
| q, Ctrl-C        | Quit                                                                                                          |
| mouse wheel      | Move the cursor through the table and the menu, and scroll the diff and the reports                           |
| click            | Enter — except in the delete box, which the keyboard alone answers                                            |

Every one of those keys runs a command the menu also holds a row for, on the same
repositories: the ones picked with space, or the row under the cursor when none
are. Nothing is a key and nothing else, and nothing is a menu row and nothing
else — the menu prints each command's key beside it, so the slow way of finding a
command teaches the quick one.

The mouse does the whole of a run on its own: wheel down to the repository, click
to open the menu, wheel down to the command, click to run it. The wheel is what
picks and the click is only ever the enter key — where the pointer is lying makes
no difference to either. That is deliberate. A click that also picked whatever it
landed on would act on the row under the pointer rather than the row you had
moved to, and the pointer is not where you were looking; it also puts every
command a mis-aimed pixel away from the one you wanted.

The wheel moves the cursor rather than the window under it, because the cursor is
what enter and d act on and a table that scrolled away from it would leave the
two pointing at different rows; the window follows along, which is the scrolling
you were after. Unlike the keys it does not wrap round the ends. Having the wheel
means the table asks the terminal to report the mouse, and while it does,
selecting text with a drag needs a modifier held — option in iTerm2, shift most
other places. The reporting is turned off again whenever the table steps aside,
so a program it hands the terminal to never inherits it.

The menu is a box over the table, as the diff is, and as everything else that
interrupts the table is. In it the number keys 1-9 run a command straight away;
up/down or j/k and then enter do the same thing more slowly, and reach the tenth
row as well. The commands are:

| Command               | Key     | Runs                                                                                 |
|-----------------------|---------|--------------------------------------------------------------------------------------|
| goto folder           |         | your shell, standing in the main project's folder                                    |
| open with code        | `e`     | `code <main project>`                                                                |
| open with vim         | `v`     | `vim .` in the main project                                                          |
| open with claude code | `c`     | `claude` in the main project, with `--add-dir` for each added repository             |
| open with codex       |         | `codex` in the main project, the same way                                            |
| diff                  | `d`     | the box below, holding what changed in the main project                              |
| fetch                 | `f`     | `git fetch --all` in every picked repository — see below                             |
| pull                  | `p`     | `git pull` in every picked repository — see below                                    |
| commit & push         |         | `git add -A`, `git commit` and `git push` in **every** picked repository — see below |
| worktree add          | `t` `a` | `git worktree add` beside every picked repository — see below                        |
| delete repo folder    | `D`     | removes the folder of every picked repository — see below                            |

The number keys reach the first nine rows. The last two are past them on purpose:
both carry a key of their own, while `commit & push` has no other way in.

A selection has a shape. The repository picked first is the **main project** and
wears no mark; the ones picked after it are marked `+`. The editor opens the main
project — a window is a window, and the marked repositories were not asked for.
`claude` and `codex` open the main project too, and are handed the marked ones as
directories they may also work in. `vim` opens the main project and nothing else,
having no way of being told about the rest.

`vim`, `claude` and `codex` want a terminal of their own and borrow this one: the
table steps aside and comes back when the tool exits. `code` does not, having a
window of its own, which is why it is the one that costs nothing to press.

`e` is the one command that asks nothing and takes no time: a window is only a
window, and nothing it opens cannot be closed again. `f`, `p` and `D` all put a
box between the keystroke and the work, and the rest of the menu is its own
asking.

`goto folder` is the same borrowing with a shell as the tool. No program can move
the shell that started it, so the folder is reached by a shell of its own
standing in it — your `$SHELL`, with your prompt and your aliases. Work there as
usual; `exit`, or Ctrl-D, ends it. That one ends repo-master with it, rather than
putting the table back: somewhere else is what the command was for, and a table
in front of somebody on their way out is one screen too many. The tools above
keep the table, because opening one is something you do between looks at it.

The commands, and the editor behind `e`, can be pointed somewhere else, for
anyone whose tools are named differently. These are not written into config.json — their defaults suit nearly
everybody — so add the line yourself under `functions.repo-master` when you want
one:

```json
"code_command": "cursor"
```

| Setting          | Default     | What it runs                                                                                                       |
|------------------|-------------|--------------------------------------------------------------------------------------------------------------------|
| `shell_command`  | `$SHELL`    | `goto folder`; `sh` when there is no `$SHELL`                                                                      |
| `code_command`   | `code`      | `open with code` and the `e` key; `cursor` and `windsurf` take a folder the same way                               |
| `vim_command`    | `vim`       | `open with vim` and the `v` key; `nvim` and `hx` take a folder the same way                                        |
| `claude_command` | `claude`    | `open with claude code`                                                                                            |
| `codex_command`  | `codex`     | `open with codex`                                                                                                  |
| `claude_add_dir` | `--add-dir` | How `claude` is told about the repositories added to the main one, once each. `false` opens the main project alone |
| `codex_add_dir`  | `--add-dir` | The same for `codex`, for a version that spells the option differently                                             |


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


Fetching and pulling
--------------------

`f` fetches and `p` pulls, across everything picked with space — or the row under
the cursor when nothing is. Both reach a remote, and a pull writes into a working
tree, so neither goes ahead on the keystroke alone. A box asks first, and it asks
by listing:

```
    +- Pull 3 repositories -------------------------------------------+
    | lhypds/gift       master                                        |
    | gcc3/content-hub  main   · +12 lines -3 lines uncommitted       |
    | lhypds/conf       master                                        |
    +- 1 with uncommitted changes · enter pull · esc cancel ----------+
```

`p` on a folder of thirty repositories is not a keystroke anybody should be able
to make without seeing which thirty. Enter runs it, esc backs out and nothing has
happened. A pull merges into a working tree, so the repositories with something
uncommitted in them are marked orange and counted again in the footer; a fetch
touches no working tree and marks nothing.

What came of each is reported in the same kind of box committing uses. A fetch
says how far the branch now stands from what it was fetched against, which is the
whole of what a fetch is worth:

```
    +- fetch · 3 repositories ----------------------------------------+
    | lhypds/gift       fetched · 2 behind                            |
    | gcc3/content-hub  fetched · 2 behind · 1 ahead                  |
    | lhypds/conf       fetched · up to date                          |
    +- 2 with new commits · 1 up to date -----------------------------+
```

A pull says how many commits it took, or that there were none to take. Neither
one argues with git: a pull into a tree too dirty to merge into, or onto a branch
that has diverged with no rule set for reconciling it, is git's to refuse, and
its refusal is passed on word for word and the repository left exactly as it was.
A repository with no remote is told so without a network being waited on.


The diff
--------

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

| Key              | Does                           |
|------------------|--------------------------------|
| up / down, k / j | Scroll a line                  |
| space            | Turn the page                  |
| g, G             | Jump to the top, or to the end |
| r                | Read the changes again         |
| esc, q, d        | Close the box                  |

The title carries the repository, its branch and the size of the diff, and keeps
up with the table underneath. The patch does not: it is the one read when the box
opened, because a page of text moving under somebody reading it is no kindness. A
file saved while you read it moves the title and leaves the text alone — `r` then
fetches the rest.

A patch longer than 5000 lines is cut, with a note saying how much was left off.
Binary files are named rather than printed, as git names them.


Worktrees
---------

`t` then `a` — or `worktree add` in the menu — puts a branch in a folder of its
own beside the repository it came from. `t` opens a box naming the repositories
and saying which letter does what; `a` asks for the branch, and writes the folder
out under the line as you type it:

```
    +- Worktree add --------------------------------------------------+
    | feature-x_                                                      |
    |                                                                 |
    | lhypds/gift       ./gift-feature-x                              |
    | lhypds/conf       ./conf-feature-x                              |
    +- 2 repos · enter add · esc back --------------------------------+
```

The folder is the repository's own name and the branch, next to the repository:
`feature-x` in `~/projects/gift` becomes `~/projects/gift-feature-x`. That is a
folder under the watched root, which means it is a row of its own the moment it
exists — the table rescans rather than waiting for the next sweep. Slashes in a
branch name become dashes in the folder, so `fix/login` is `gift-fix-login`.

Which branch is meant is worked out rather than asked for twice. A branch that
exists here is checked out; one that exists only on `origin` is created to follow
it, which is what typing a colleague's branch name meant; a name git has never
heard of is a new branch off HEAD. Everything after that is git's to refuse — a
branch already checked out in another worktree, a folder already there — and its
refusal is passed on word for word.

Every picked repository gets one, each on its own: a branch belongs to a
repository, and one repository's `feature-x` is nothing to another's. What came
of each is reported in the usual box.


Deleting a folder
-----------------

`D` — or `delete repo folder` in the menu — removes the folders of everything
picked, and everything in them. There is no trash and no undo, which is why it is
the one command the table argues with you about:

```
    +- Delete 2 folders ----------------------------------------------+
    | lhypds/gift        ./gift  · +1203 lines -30 lines uncommitted  |
    | gcc3/gcc3-content  ./gcc3                                       |
    | gcc3/content-hub   ./gcc3/public/notes  · inside one of them    |
    +- 1 with uncommitted changes · 1 more inside them · nothing undoes this · enter delete · esc cancel -+
```

Every folder is named with its path and drawn orange, what is uncommitted in each
is said plainly, and the repositories that are not being deleted but will be gone
all the same — the ones living inside a folder that is — are named underneath in
grey. What it removes is a folder, not a repository, and a folder takes what is
inside it.

Enter deletes; esc backs out. A click will not answer this box, though it answers
every other one in repo-master: a folder is not to be deleted by a mouse that
happened to be near, and a question this final should be answered from the
keyboard. The watched root is never on offer, whatever the cursor is on — it is
the folder the table is a table of, and deleting it is not something anybody
meant by pointing at a row in it.


Searching
---------

`/` narrows the table to the repositories whose name, path or branch holds what
you type, upper and lower case alike. It is not a box: the list narrowing under
you is the whole point, so the line is typed along the bottom where the keys
usually are, and the table stays whole above it.

```
Watching ~/projects · 12 repos · 3 changed · “gcc” · 2 showing
-------------------------------------------------------------------------------
  repo                path                 branch  status       last updated  diff
> gcc3/gcc3-content   ./gcc3               master  no changes   -             -
    +- gcc3/content-hub  ./gcc3/public/notes  main  has changes  just now      +3 lines
-------------------------------------------------------------------------------
/gcc_   enter keep · esc clear
```

Enter keeps what is showing and hands the keys back to the table; esc undoes the
search altogether. Backspace and the arrows work as they do in the commit box,
and `j` and `k` are letters here rather than the cursor — the arrows and the
wheel still move it, so a repository can be typed for and then stepped to without
the keys changing hands.

While a search is up, everything the keys act on is what is showing: the cursor
walks the narrowed list, and space picks from it. Nothing else changes — every
repository is still watched, still refreshed, and still counted in the header,
which says how many of them this is. A search hides rows; it does not unpick
them, so something picked and then searched past is still picked and still worked
on. The box every command opens names every repository it is about, which is
where that is noticed.

In the table, `esc` clears the search first and the selection second: the search
is the newer of the two, and the one hiding things.


Parameters
----------

| Parameter                 | Description                                             | Default                                                |
|---------------------------|---------------------------------------------------------|--------------------------------------------------------|
| `DIR`, `--repo-root=PATH` | Folder to watch (`--dir=PATH` is the older spelling)    | the configured `repo_root`, else the current directory |
| `--depth=N`               | How many folders deep to look for repositories          | 4                                                      |
| `--refresh=SEC`           | Seconds between full sweeps — new repositories included | 30                                                     |
| `--once`                  | Print the table once and exit, instead of watching      | off                                                    |
| `-h`, `--help`            | Show the help message and exit                          |                                                        |

Every default above is a setting of its own under `functions.repo-master` in
config.json — `gift config` opens it — including which commands the enter menu
runs. A value
already in the environment wins over the configuration, and a flag wins over
both.

Without a terminal to draw on — a pipe, a cron job — `--once` is assumed.


What the columns mean
---------------------

| Column       | Meaning                                                                                                                            |
|--------------|------------------------------------------------------------------------------------------------------------------------------------|
| repo         | `owner/repo` from the origin remote, or the folder name when there is none. `+-` marks a repository living inside the one above it |
| path         | Where it is, relative to the watched folder                                                                                        |
| branch       | The checked-out branch, or `(abc1234)` when HEAD is detached                                                                       |
| status       | Whether the working tree has anything uncommitted                                                                                  |
| last updated | When the newest of those changes was written — not when it was noticed                                                             |
| diff         | Lines added and removed against HEAD, untracked files counted as added                                                             |

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
