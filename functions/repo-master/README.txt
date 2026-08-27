
repo-master
===========


Watch every git repository under one folder in a live table, and open the ones that moved.


A folder full of half-finished projects is hard to hold in your head. repo-master
finds every repository under it — nested checkouts and submodules included —
and keeps one table up to date: which branch each one is on, whether the working
tree has changes, how many lines that is, and how much is committed here and
nowhere else.
A row with something uncommitted in it wears an orange bar; one that has committed
and not pushed wears a dark grey one. Press enter for the menu of what may
be done to them — open one in an editor or an agent, read its diff, commit the
lot, fetch, pull, push, switch or make a branch, merge, rebase, branch a worktree
off it, stash what is uncommitted, put a stash back, discard the changes,
delete a folder outright — or
press the key the menu prints beside the command you wanted. `/` finds a
repository in a folder too full to read, and a `.gitignore` in the watched folder
keeps the folders that are nobody's work out of the table altogether.

```
repo master v0.0.1


watching ~/projects · 12 repos · 3 changed · 1 unpushed · 2 open PRs
---------------------------------------------------------------------------------------------------------

  repo                 path                 branch  status       last updated  diff
> lhypds/gift          ./gift               main    has changes  1min ago      +1203 -30
 +gcc3/gcc3-content    ./gcc3               master  2 unpushed   -             -


    +- gcc3/content-hub  ./gcc3/public/notes  main  has changes  just now      +3
---------------------------------------------------------------------------------------------------------

up/down move · space select · enter menu · / search · esc clear · R refresh · q quit
```

The foot is the table's own keys and nothing else. Every command's key is printed
beside its row in the menu, which is where the list of them belongs: repeating
them along the bottom filled the line up and then cut it short, saying less than
the menu says in full.

Under them, an orange line when there is something to say: what a command did, or
what it would not do. It is there for a second and then it is not — what is
said there is what has just happened, and a line about a push that finished a
minute ago has stopped being that, leaving something to read past on the way to
the table it sits under. A row that says `error` explains itself on the same line
while the cursor is on it, which is not news but a fact about the row, and stays
for as long as the cursor does.


Files
-----

| File                 | Description                                                                                                         |
|----------------------|---------------------------------------------------------------------------------------------------------------------|
| `main.js`            | Entry point — run through `gift repo-master`, or directly with `node`                                               |
| `lib/repos.js`       | Finding the repositories, working out which sits inside which, and which of them a search leaves showing            |
| `lib/ignore.js`      | The folders left out of the table, and the `.gitignore` they are written in                                         |
| `lib/git.js`         | Branch, working-tree changes, diff size, the last change, and the git behind every command that runs one            |
| `lib/watch.js`       | Hearing about edits, with a timer as the fallback                                                                   |
| `lib/table.js`       | The table itself, how each row is coloured, and what goes in each box                                               |
| `lib/modal.js`       | The box they are all drawn in, over the table                                                                       |
| `lib/screen.js`      | The alternate screen and the keys                                                                                   |
| `lib/actions.js`     | The one list of commands, and what each one does to the repositories picked                                         |
| `lib/setup.js`       | The first run's question — which folder to watch — and writing the answer down                                      |
| `config.schema.json` | The settings this function has, and their defaults — see `functions.repo-master` in config.json                     |


Usage
-----

```bash
gift repo-master [DIR] [options]
```

(`gift repo` is enough of the name.)

`DIR` is the configured `repo_root` unless the positional argument or
`--repo-root` names another one. The folder is set once and then forgotten, so
the first run with nothing configured asks for it in words, on the terminal,
before the table goes up:

```
repo-master watches every git repository under one folder, and does not know
which folder yet. Answer once and it is written down — `gift config` changes it
later, and a path given to the command wins over it for the one run.

Folder to watch [~/code]: ~/projects
Watching ~/projects — written down in /Users/me/gift/config.json.
```

Enter alone takes the directory you are standing in. A folder that is not there
is worth another question rather than an exit; Ctrl-C gives up and watches
nothing. The answer lands under `functions.repo-master` in config.json, which
`gift config` opens:

```json
{
    "functions": {
        "repo-master": { "repo_root": "/Users/me/projects" }
    }
}
```

```bash
gift repo-master        # from anywhere at all, from then on
```

Write `repo_root` as an absolute path, so it means the same folder whatever
directory you run from — which is what the question writes for you.

Where there is nobody to ask — down a pipe, in a cron job, with `--once` — an
unset `repo_root` still means your current directory, and nothing stops to ask a
script a question it cannot answer.


Keys
----

| Key              | Does                                                                                                          |
|------------------|---------------------------------------------------------------------------------------------------------------|
| up / down, k / j | Move the cursor                                                                                               |
| space            | Add the row to the selection and step down — the first one added is the main project, the rest are marked `+` |
| enter            | Open the command menu for the selection, or the row under the cursor                                          |
| e                | Open the main project in your editor, straight away                                                           |
| v                | Pick a file of the main project with fzf, and open it in vim, in this terminal                                |
| c                | Commit everything picked, after a box asking for the message — the report takes a `P`                         |
| d                | Read what the row under the cursor has that is only there                                                     |
| f                | Fetch everything picked, after a box asking whether to                                                        |
| p                | Pull everything picked, after a box asking whether to                                                         |
| P                | Push what everything picked has already committed — and in a commit's own report, what it just committed      |
| s                | Stash the changes of everything picked, after a box asking whether to                                         |
| u                | Discard the changes of everything picked, after a box asking in earnest                                       |
| b                | Switch everything picked to a branch, after a box asking which                                                |
| n                | Make a branch off what is checked out, in everything picked, after a box asking its name                      |
| m                | Merge a branch into what is checked out, in everything picked, after a box asking which                       |
| r                | Rebase what is checked out onto a branch, in everything picked, after a box asking which                      |
| t then a         | Add a worktree to everything picked, after a box asking for the branch                                        |
| D                | Delete the folders of everything picked, after a box asking in earnest                                        |
| /                | Search: narrow the table to the repositories matching what you type                                           |
| esc              | Clear the search, then the selection — or close whichever box is open                                         |
| R                | Rescan and refresh everything now                                                                             |
| q, Ctrl-C        | Quit                                                                                                          |
| mouse wheel      | Move the cursor through the table and the menu, and scroll the diff and the reports                           |
| click            | Enter — except in the delete and discard boxes, which the keyboard alone answers                              |

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
| open with vim         | `v`     | `fzf` in the main project, and then `vim` on the file it printed — see below         |
| open with claude code |         | `claude` in the main project, with `--add-dir` for each added repository             |
| open with codex       |         | `codex` in the main project, the same way                                            |
| diff                  | `d`     | the box below, holding what the main project has that is only there                  |
| fetch                 | `f`     | `git fetch --all` in every picked repository — see below                             |
| pull                  | `p`     | `git pull` in every picked repository — see below                                    |
| commit                | `c`     | `git add -A` and `git commit` in **every** picked repository — see below            |
| commit & push         |         | the same, and `git push` after it, without the second question — see below           |
| push                  | `P`     | `git push` alone, in every picked repository — see below                             |
| stash                 | `s`     | `git stash push -u` in every picked repository — see below                           |
| discard changes       | `u`     | throws the same changes away instead — see below                                     |
| restore stash         |         | `git stash pop` in every picked repository, the newest entry of each — see below     |
| switch branch         | `b`     | `git switch` in every picked repository — see below                                  |
| new branch            | `n`     | `git switch -c` in every picked repository — see below                               |
| merge                 | `m`     | `git merge --no-edit` in every picked repository — see below                         |
| rebase                | `r`     | `git rebase` in every picked repository — see below                                  |
| worktree add          | `t` `a` | `git worktree add` beside every picked repository — see below                        |
| delete repo folder    | `D`     | removes the folder of every picked repository — see below                            |

The menu orders itself by use: the command run most often is at the top, commands
run the same number of times are in alphabetical order, and the count is kept in
`~/.gift/repo-master-usage.json` between runs. The number keys reach the first nine
rows of whatever order that has come to be, which is why the commands with no key
of their own — `goto folder`, `open with claude code`, `open with codex`,
`commit & push`, `restore stash` — are the ones that gain the most from being
used: they walk up to a number.

Opening an agent is a thing you do between looks at the table rather than the work
the table is for, which is why `claude` and `codex` are both menu rows and `c` is
the commit.

A selection has a shape. The repository picked first is the **main project** and
wears no mark; the ones picked after it are marked `+`. The editor opens the main
project — a window is a window, and the marked repositories were not asked for.
`claude` and `codex` open the main project too, and are handed the marked ones as
directories they may also work in. `vim` opens one file of the main project and
nothing else, having no way of being told about the rest.

`vim`, `claude` and `codex` want a terminal of their own and borrow this one: the
table steps aside and comes back when the tool exits. `code` does not, having a
window of its own, which is why it is the one that costs nothing to press.

`vim` asks which file before it opens anything. Opening a repository in vim is
opening a file in it, and the fastest way of saying which is to type part of the
name in front of a list: fzf takes the borrowed terminal first, and what it prints
is what vim is started on. Picking nothing, with esc or Ctrl-C, opens nothing and
puts the table back — the file was the command. Where fzf is not installed, vim
opens the folder as it used to, and the table says so once vim closes.

The list is `fd`, which walks the repository reading `.gitignore` on the way down:
what you are offered is the repository's own files, with hidden ones among them and
`.git` and everything ignored left out — no node_modules to scroll past, because
the repository ignores it. Beside the list is the file the cursor is on, shown with
`bat`: the colours it would have in an editor, numbered lines, and the first 500 of
them, which is enough to know whether it is the file you meant. Neither is required.
Without `fd` the list is git's own — the same files, minus any nobody has added yet
— and without `bat` the preview is `cat`. `$FZF_DEFAULT_COMMAND` is your own answer
to what should be in the list, and where you have set one it is left alone.

`e` is the one command that asks nothing and takes no time: a window is only a
window, and nothing it opens cannot be closed again. `f`, `p`, `P`, `s`, `u` and
`D` all put a box between the keystroke and the work; `c`, `b`, `n`, `m` and `r`
put a box there to be typed in; and the rest of the menu is its own asking.

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

| Setting          | Default     | What it runs                                                                                                                                                                |
|------------------|-------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `shell_command`  | `$SHELL`    | `goto folder`; `sh` when there is no `$SHELL`                                                                                                                               |
| `code_command`   | `code`      | `open with code` and the `e` key; `cursor` and `windsurf` take a folder the same way                                                                                        |
| `vim_command`    | `vim`       | `open with vim` and the `v` key; `nvim` and `hx` take a file the same way                                                                                                   |
| `fzf_command`    | `fzf`       | The picker `open with vim` asks which file with — anything that prints what was picked will do. It lists with `fd` and previews with `bat`, and falls back to git and `cat` |
| `claude_command` | `claude`    | `open with claude code`                                                                                                                                                     |
| `codex_command`  | `codex`     | `open with codex`                                                                                                                                                           |
| `claude_add_dir` | `--add-dir` | How `claude` is told about the repositories added to the main one, once each. `false` opens the main project alone                                                          |
| `codex_add_dir`  | `--add-dir` | The same for `codex`, for a version that spells the option differently                                                                                                      |


Committing and pushing
----------------------

`c` is the commit, and it is the one command that treats every picked repository
as a project of its own: there is no main project to make of the others, because a
commit belongs to one repository and nothing else. It asks for a message first,
in a box listing what it is about to commit:

```
    +- Commit message -----------------------------------------------+
    | fix: 修复表格宽度_                                              |
    |                                                                |
    | lhypds/gift       +1203 lines -30 lines                        |
    | gcc3/content-hub  +3 lines                                     |
    +- 3 repos · enter commit · esc back ----------------------------+
```

Type the message and press enter; esc goes back to the menu, and an empty message
is refused. Backspace and the left/right arrows work as they do anywhere, and so
do Ctrl-U to clear the line, Ctrl-A and Ctrl-E to reach its ends. Every other key
is a character here — `q` types a q rather than quitting.

Each repository then has everything in its working tree staged, tracked changes
and untracked files alike — the same changes the row counts, and nothing
belonging to a repository nested inside it — and committed with your message. A
few are worked on at once, and one that fails takes none of the others down with
it. The box stays up and fills in as they finish:

```
    +- commit · "fix: 修复表格宽度" ----------------------------------+
    | lhypds/gift       committed 8ac1f2e                            |
    | gcc3/content-hub  committing…                                  |
    | lhypds/conf       waiting…                                     |
    +- 1 of 3 done · working… ---------------------------------------+
```

Green is a repository that committed, grey one that had nothing to commit, orange
one that could not. Nothing else in repo-master answers while it runs.

Nothing to commit is not a failure: a repository somebody pointed at along with
five others, and has not touched since its last commit, says so and is left alone.
A repository with a detached HEAD is not touched at all — it says so and stays as
it was.

And then the push, which is the second half and a second decision:

```
    +- commit · "fix: 修复表格宽度" ----------------------------------+
    | lhypds/gift       committed 8ac1f2e                            |
    | gcc3/content-hub  committed 41c9e02                            |
    | lhypds/conf       nothing to commit                            |
    +- 2 committed · P push them · up/down scroll · esc close -------+
```

`P` in that box pushes exactly the repositories that committed — the ones named in
front of you, and not the one that had nothing to do — and the report of the push
opens in its place. There is no box asking whether it was meant: the one you are
looking at is the list such a box would have drawn, and the message in its title is
the answer you already gave. `esc` leaves the commits where they are, which is a
whole answer too — the rows wear the grey bar in the table and say how many commits are
waiting, and a `P` on the table pushes them whenever you come back to it.

A box with a push still to decide on waits to be read. Every other report has been
read by the time it is drawn — the row says `fetched`, and that is the whole of it
— so it takes itself away after a second and leaves what it came to under the
table, where it is a line like any other and fades like one. A failure is the other
thing worth going back over, so a box with one in it stays until `esc`; so does one
being scrolled, because that is somebody reading rather than somebody waiting.
Either way the table refreshes itself afterwards.

`commit & push` is the same command with the second question already answered, for
whoever would rather not be asked twice: one message, and every picked repository
committed and pushed with it. Its rows read `committed 8ac1f2e · pushed`. Nothing
to commit is not a failure there either — a repository whose commits never left the
machine is pushed anyway — and one with neither is left alone rather than made to
reach across a network to be told it is up to date. It has no key of its own,
because `c` and then `P` is the same errand a key at a time.

A branch that has never been pushed is given `origin` as its upstream when there is
a commit to carry there, which is the `git push --set-upstream origin <branch>` git
itself suggests.


Fetching, pulling and pushing
----------------------------

`f` fetches, `p` pulls and `P` pushes, across everything picked with space — or
the row under the cursor when nothing is. All three reach a remote, a pull writes
into a working tree, and a push writes to somewhere other people read, so none of
them goes ahead on the keystroke alone. A box asks first, and it asks by listing:

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

`P` is the other half of the commit — the one the commit's own box offers, and the
one on the table for the commits that were made somewhere else, in an editor, in an
agent, at a shell, and never left the machine. It is the key a grey bar is about.
It commits nothing itself and touches no working tree;
it says how many commits it carried, and a branch level with its upstream is left
alone rather than made to reach across a network to be told so:

```
    +- push · 3 repositories ------------------------------------------+
    | lhypds/gift       pushed 2 commits                               |
    | gcc3/content-hub  pushed to origin/feature-x                     |
    | lhypds/conf       nothing to push                                |
    +- 2 pushed · 1 nothing to push ----------------------------------+
```

A branch that has never been pushed is given `origin` as its upstream, exactly as
it is after a commit, and the box says which branch it now follows. A detached
HEAD is not touched — there is no branch to push. A push git refuses is reported
in git's own words: the `[rejected] main -> main (fetch first)` line, which is the
one worth reading of everything it says.


Stashing and discarding
-----------------------

`s` puts the changes of everything picked out of the way; `u` throws the same
changes away instead. Both leave the working trees they touch clean, and both are
asked for first:

```
    +- Stash 2 repositories -------------------------------------------+
    | lhypds/gift       master  · +1203 lines -30 lines               |
    | gcc3/content-hub  main  · +3 lines                              |
    +- 2 with changes · git stash pop brings them back · enter stash · esc cancel -+
```

`s` is `git stash push -u`, so untracked files go with the tracked changes and the
row comes out reading `no changes`. Everything it took is one `git stash pop` away
in the repository it came from, and `restore stash` in the menu is that pop — see
below.

`u` is the same command with nothing to undo it, so its box is drawn the way the
delete box is: the rows orange, `nothing undoes this` in the footer, and the
keyboard alone answering it — a click will not, though it answers every other box
in repo-master. Tracked changes are put back as HEAD has them, staged and unstaged
alike, and untracked files are removed.

```
    +- Discard the changes of 2 repositories --------------------------+
    | lhypds/gift       master  · +1203 lines -30 lines               |
    | gcc3/content-hub  main  · +3 lines                              |
    +- 2 with changes · nothing undoes this · enter discard · esc cancel -+
```

Neither one touches an ignored file — build output and local settings are not what
anybody means by "my changes" — and neither touches a repository nested inside
another, which has a row of its own and an `s` and a `u` of its own with it. A
repository with nothing in it to clear is skipped and said to be; pressing either
key where nothing at all has changed says so on the message line and opens no box.
A repository with no commit yet cannot stash — git has no HEAD to stash against,
and says so — while a discard there has an answer: everything in it is a file
never committed, so the whole of it goes.

What came of each is reported in the same kind of box committing uses:

```
    +- stash · 2 repositories -----------------------------------------+
    | lhypds/gift       stashed 4 files                                |
    | gcc3/content-hub  stashing…                                      |
    +- 1 of 2 done · working… ----------------------------------------+
```


Restoring a stash
-----------------

`restore stash` is the other half of `s`: `git stash pop` in every picked
repository, the newest entry of each and no more. It has no key of its own — a
stash is put back a day after it was made, from the menu rather than from muscle
memory — and it is asked for in a box like everything else that writes into a
working tree:

```
    +- Restore 2 repositories -----------------------------------------+
    | lhypds/gift       master  · WIP on master: 9e73484 the table  · 1 more stashed |
    | gcc3/content-hub  main  · nothing stashed                       |
    +- 1 with something stashed · the newest of each · enter restore · esc cancel -+
```

The list is the point of it, as it is in the other boxes. What each repository has
stashed is read while the box is up — one `git stash list` each, once, rather than
on every refresh — and each row says the entry it would put back in git's own
words, how many entries it would be keeping after that one, and `nothing stashed`
where there is nothing to give back. Until a repository has answered, its row says
only which branch it is on: saying nothing beats saying something wrong.

A restore takes nothing away, so the box is drawn quietly and a click answers it.
A repository with nothing stashed is skipped rather than failed. A pop that
conflicts is left standing the way a merge is — git has put what it could into the
working tree and kept the entry it came from, so nothing is lost — and the row says
how many files are waiting:

```
    +- restore stash · 2 repositories ---------------------------------+
    | lhypds/gift       restored 4 files · 1 more stashed              |
    | gcc3/content-hub  nothing stashed                                |
    +- 1 restored · 1 nothing stashed --------------------------------+
```

The stashes underneath the newest are left where they are: a stash is a stack
filled one push at a time, and emptying the whole of it on one keystroke is not
what anybody pointing at a row meant. Run it again for the next one.


Branches
--------

Four keys take a branch name, and all four ask for it in the same box: `b`
switches to a branch, `n` makes one off whatever is checked out, `m` merges a
branch into what is checked out, and `r` rebases what is checked out onto another.

The box is the point of them. One name is typed once and run against every picked
repository, and every picked repository is a different answer to it — so the list
under the line says which branch each one is on, which way the work runs, and
whether that repository has heard of the name at all:

```
    +- Switch branch --------------------------------------------------+
    | feature-x_                                                       |
    |                                                                  |
    | lhypds/gift       main → feature-x  · here                       |
    | gcc3/content-hub  main → feature-x  · on origin                  |
    | lhypds/conf       master → feature-x  · no such branch           |
    +- 3 repos · enter switch · esc back ------------------------------+
```

`here` is a branch that repository has; `on origin` is one only origin has, which
`b` makes here and sets to follow — what anybody typing a colleague's branch name
meant. `no such branch` is orange, and it is the row worth seeing before enter
rather than in the report afterwards.

A name is typed a letter at a time, and every letter of `feature-x` before the
last is a name nothing has, so a name still on its way says how many branches it
could still become — `main → fea  · 2 start with it` — and only a name that has
left them all behind is marked as missing. With nothing typed at all, each row
says how many branches there are to name.

`m` and `r` mark the repositories with uncommitted changes as well, which is where
either goes wrong, and both refuse the branch already checked out rather than
merging or rebasing a branch onto itself.

Then the same report box the rest of the table uses:

```
    +- merge · feature-x ----------------------------------------------+
    | lhypds/gift       merged feature-x 3 commits                     |
    | gcc3/content-hub  already has feature-x                          |
    | lhypds/conf       conflicted · 2 files to resolve, or git merge --abort |
    +- 1 merged · 1 already had it · 1 failed ------------------------+
```

A merge or a rebase that hits a conflict is **not** undone. It stops where git
stopped it, with the tree half-merged and MERGE_HEAD or a rebase standing — which
is git's normal way of asking for a hand — and the row says how many files are
waiting and names the way back out. Unpicking that on your behalf would be the
wrong answer: a merge you asked for is worth resolving, and a table is not the
thing to decide otherwise. Resolve it in the repository, or `git merge --abort`
and `git rebase --abort` there.

Everything else is git's to refuse and passed on word for word: a branch name
already taken, a merge into a tree too dirty to merge into, a rebase of a branch
with uncommitted work under it. `n` in a repository with no commit yet makes the
branch all the same — there is an unborn one for git to rename — and `b` there has
nothing to switch to.

`r` is rebase rather than refresh, which is `R`. Refreshing is the one of the two
that can wait: the table sweeps itself every half minute and watches every working
tree besides, so `R` only ever asks for the sweep sooner.


The diff
--------

`d` opens a box over the table holding everything the row has that is only there:
the commits that never left the machine, then the patch against HEAD, and then the
untracked files, which no patch mentions because git has never seen them. Nested
repositories are left out of the last two, the way they are left out of the row —
they have a row of their own, and a `d` of their own.

```
    +- lhypds/gift · main · 2 unpushed · +1203 lines -30 lines ---------------+
    | unpushed (2):                                                           |
    | 8ac1f2e  2 days ago    Sticky pnpm version                              |
    | 1347394  3 weeks ago   Update release.sh                                |
    |                                                                         |
    | diff --git a/cli.js b/cli.js                                            |
    | @@ -1,4 +1,5 @@                                                         |
    |  'use strict';                                                          |
    | -const { run } = require('./functions.js');                             |
    | +const { run, list } = require('./functions.js');                       |
    +- 1-9 of 91 · up/down scroll · space page · r reload · esc close --------+
```

The commits come first because that is the order the work happened in, and because
the patch under them is the half that is not committed anywhere at all. They are
what `P` would carry — `@{upstream}..HEAD`, or everything no remote has heard of
where the branch follows nothing — newest first, with how long each has been
waiting. Fifty is as many as are named; the heading counts the rest. A repository
with everything pushed has no such heading, and is not asked about it.

| Key              | Does                           |
|------------------|--------------------------------|
| up / down, k / j | Scroll a line                  |
| space            | Turn the page                  |
| g, G             | Jump to the top, or to the end |
| r                | Read the changes again         |
| esc, q, d        | Close the box                  |

The title carries the repository, its branch, how much is waiting to be pushed and
the size of the diff, and keeps up with the table underneath. What is in the box
does not: it is what was read when the box opened, because a page of text moving
under somebody reading it is no kindness. A file saved while you read it moves the
title and leaves the text alone — `r` then fetches the rest.

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

Enter deletes; esc backs out. A click will not answer this box, as it will not
answer a discard: a folder is not to be deleted by a mouse that happened to be
near, and a question this final should be answered from the keyboard. Those two
are the only boxes in repo-master a click does not answer, and they are the two
with nothing to undo them. The watched root is never on offer, whatever the cursor
is on — it is
the folder the table is a table of, and deleting it is not something anybody
meant by pointing at a row in it.


Searching
---------

`/` narrows the table to the repositories whose name, path or branch holds what
you type, upper and lower case alike. It is not a box: the list narrowing under
you is the whole point, so the line is typed along the bottom where the keys
usually are, and the table stays whole above it.

```
watching ~/projects · 12 repos · 3 changed · “gcc” · 2 showing
-------------------------------------------------------------------------------
  repo                path                 branch  status       last updated  diff
> gcc3/gcc3-content   ./gcc3               master  no changes   -             -
    +- gcc3/content-hub  ./gcc3/public/notes  main  has changes  just now      +3
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


Leaving folders out
-------------------

A folder of everything anybody ever cloned holds a good deal that is nobody's
work: an archive of finished projects, somebody else's source read once, a
scratch folder tried out and left. A `.gitignore` in the watched folder is which
of them the table is to do without, written in the syntax already known:

```
# ~/code/.gitignore

archive/            the finished ones
vendor-*            anything cloned to be read
/tmp                only the one at the top
!archive/gift       except this one
```

One folder to a line, `#` for a comment, `!` to put one back, `*` for any part of
a name, `**` for any number of folders and `?` for one character. A name with no
slash in it — `archive` — is a folder of that name wherever it turns up; one with
a slash — `/tmp`, `public/notes` — is tied to the top of the watched folder, the
way git reads them both. A trailing slash is allowed and asks for nothing extra:
everything here is a folder.

A folder left out is not scanned either, so a hundred repositories nobody is
working on cost nothing to walk past, and it takes its repositories with it — one
living inside an ignored folder has no row of its own. The header says how many
went, so the table never quietly claims to be the whole folder:

```
watching ~/code · 12 repos · 3 changed · 2 ignored
```

The `!` line above is the one place this parts company with git, which will not
put anything back that is inside a folder it was told to leave out. repo-master
walks that one folder to find what was asked for and lists that alone, nothing
beside it: all of an archive gone bar the project still being worked on is the
reason anybody writes those two lines together.

The file is read again on every sweep, so an edit to it takes hold within the
refresh interval, and `R` asks for that sooner. It is called `.gitignore` because
the syntax is git's and because a folder full of repositories is not usually a
repository itself and has no other use for the name. `ignore_file` under
`functions.repo-master` names another file where that is the wrong assumption —
an absolute path is read where it lies — and `--ignore-file=PATH` does the same
for one run. Empty leaves nothing out.

`node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `vendor`, `venv`,
`__pycache__`, `Pods` and `DerivedData` are never walked into, file or no file: a
dependency tree holds no repository of your own, and a recursive scan through one
is where the scan goes to die. `!vendor` puts one of those back, for the checkout
that really does live in there.


Parameters
----------

| Parameter                 | Description                                             | Default                                                |
|---------------------------|---------------------------------------------------------|--------------------------------------------------------|
| `DIR`, `--repo-root=PATH` | Folder to watch (`--dir=PATH` is the older spelling)    | the configured `repo_root`, else asked for on the first run |
| `--depth=N`               | How many folders deep to look for repositories          | 4                                                      |
| `--refresh=SEC`           | Seconds between full sweeps — new repositories included | 30                                                     |
| `--ignore-file=PATH`      | The folders to leave out, read in the watched folder    | `.gitignore`                                           |
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
| status       | `has changes` for a working tree with something in it, `2 unpushed` for a clean one whose commits never left the machine            |
| last updated | When the newest of those changes was written — not when it was noticed                                                             |
| diff         | Lines added and removed against HEAD as `+1203 -30`, untracked files counted as added                                              |

A repository nested inside another has its own row, and its changes are left off
its parent's row rather than counted twice.

A working tree is not the only place work sits. A repository whose commits are on
this machine and nowhere else — standing ahead of its upstream, or on a branch that
has never been pushed at all — wears a bar of its own, a dark grey one with pale
text: a repository committed and left, by you or by an agent, is worth seeing, and
nothing about its working tree says so. The status column says how many commits
that is where git can count them, and `unpushed` on its own where there is no
upstream to count against.

Grey rather than orange, because what is committed is safe where it is — it is
still here, not in trouble. The orange stays for the working tree, which is the one
kind of work no repository anywhere has a copy of. A row with both in it wears the
orange, the uncommitted half being the more urgent fact: `c` is the key for that
one, and the report it leaves takes the `P` afterwards.

Two rows wear neither: one whose branch has no remote to push to, since there is
nowhere for that work to go and a row marked for ever says nothing, and one that is
only behind — what is waiting there is somebody else's, and `p` is the key for it.

The cursor's own bar comes off after a minute with nothing pressed, and any key —
or a turn of the wheel — puts it back. A table left up on a second screen while
the work happens elsewhere is being read rather than used, and the pale bar over
one row is then the one thing on the table that is not about a repository: it
covers the orange or the grey that row would otherwise be showing you. Nothing
moves while it is off. The `>` in the gutter still says which row the cursor is
on, whatever was picked with space stays picked and goes on wearing its own grey,
and the next key acts on exactly the row it would have acted on a minute before.

The columns are as wide as the window makes them and no wider — what is in them
has no say in it. A branch you switch, a status that turns, a diff that grows a
digit: none of them moves a column, so the table you are reading stays where it
is while it refreshes. A wide window opens the repo, path and branch columns out
towards their maximums; a narrow one squeezes them back. Anything too long for
the width it is given is cut with an ellipsis and can be read in full from the
preview. The diff column is written `+1203 -30` rather than in words: it is a
column of numbers to be compared down the page, and the boxes are where the
counts are spelled out in full.


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
