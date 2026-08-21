
gift
====

`gift` is a set of Git and GitHub tools.


Getting started
---------------

Install  
```
curl -fsSL https://raw.githubusercontent.com/lhypds/gift/master/get.sh | bash
```

That takes the latest release, unpacks it into `~/.gift`, and runs the setup and
install steps from there — so it asks for the public webhook URL and puts the
`gift` command on your PATH. Set `GIFT_INSTALL_DIR` to install somewhere else,
or `GIFT_INSTALL_VERSION=v0.0.1` to pin a release rather than take the newest.

From a checkout instead  
```
./setup.sh
./install.sh
```

Update  
Run the same one-liner again. `config.json`, `hooks.json` and the logs are
carried across, so the webhook secret and the hooks survive the upgrade.

`gift update` is the checkout equivalent — it is a `git pull --ff-only` in the
folder gift is installed from, so it has nothing to pull in a release install.

Uninstall  
`~/.gift/uninstall.sh` removes the `gift` command; delete `~/.gift` to remove
the rest. From a checkout it is `./uninstall.sh`.  


Webhooks Server
---------------

Start  
`gift serve` starts a webhooks server that listens for GitHub events. It pulls
the latest code and rebuilds the dashboard first.

Restart  
`gift restart` puts the server back on the code already on disk — no pull, no
rebuild, so it needs no network and returns straight away.

Stop  
`gift stop`  

Status  
`gift status` says whether the server is running.  

Hooks  
`gift list` shows the configured hooks.  
`gift create` adds one.  
Hook names are labels and may be reused; delete same-named hooks by their list position.

`gift create` asks five things: the repository, the branches to watch (comma
separated, `*` for any, `main, master` by default), the hook name, the script to
run and the working directory it runs in. A push to a branch outside the list is
answered with `No match` and runs nothing.

For a specific repository, `gift create` asks whether to create the GitHub
webhook with `gh` — right after the repository, before anything else is asked or
written. Set `webhook_url` in `config.json` to the complete public delivery URL,
including `/hooks/github`; otherwise it asks for the URL too. Once the hook is
saved, gift asks GitHub to confirm the webhook is really there, so a hook in
`hooks.json` that GitHub never calls is reported rather than assumed to work.

Answering yes needs `gh` installed and signed in on the machine gift runs on
(`gh auth login`, with an account that may write the repository's webhooks) and
`GITHUB_WEBHOOK_SECRET` set. If either is missing, `gift create` says which and
stops without writing anything. Answer `n` to add the local hook on its own and
create the webhook under the repository's Settings > Webhooks, using the same
secret.

The server restarts automatically after `gift create` or `gift delete`.

Log  
`gift log` prints the last 10 lines of the server log — `gift log 20` more —
and then keeps watching, printing each line as the server writes it. Ctrl-C
stops. `gift log --no-follow` prints the lines and exits.  


Functions
---------

List functions with `gift help`.  
Run `gift run` and choose a function — `>` marks the one the keys are on,
up/down or j/k move it, enter runs it, and a number key runs its row straight
away — or invoke one directly with `gift <function-name>`.

`gift run 3` and `gift run repo` skip the menu: the first word after `run` is the
answer to it, a number or a name or enough of one. Anything after that word, and
any flag, is passed on to the function itself — `gift run 3 --once`.  

A function is a folder under `functions/` holding an entry script, so the ones
below are what is there rather than a fixed list — drop a folder in and it is on
the menu. Each has its own README with the full parameters and examples, and its
settings live under `functions.<name>` in `config.json`.

repo-master — `gift repo-master [DIR]`  
Watches every git repository under one folder in a live table: the branch each
one is on, whether the working tree has changes, and how many lines that is.
Nested checkouts and submodules are found too. A row with something uncommitted in
it wears an orange bar, and one that has committed and not pushed is written in
grey; enter opens the menu of what may be done to the ones picked — open
in an editor or an agent, read the diff, commit the lot and push it, fetch, pull,
push, switch or make a branch, merge, rebase, branch a worktree, stash, restore
a stash or discard, delete a folder outright — and `/` finds a repository in a folder too
full to read. A `.gitignore` in the watched folder keeps the folders that are
nobody's work — an archive, a scratch folder — out of the table altogether. The
folder is asked for on the first run and remembered as
`repo_root`. See [functions/repo-master/README.txt](functions/repo-master/README.txt).

clone-repos — `gift clone-repos [--out=DIR] [organization]`  
Clones every repository an organization has into one folder: the public ones,
the private ones the token can see, the forks and the archived ones, each in a
folder of its own. Without the name it asks for one, and takes the URL of the
organization's page as an answer. A repository already there is left alone, so
running it again clones what is new — `--pull` updates those instead. `--ssh`
clones over SSH rather than with the token, `--no-archived` and `--no-forks`
narrow what is taken, `--depth` clones shallow, `-j` says how many at a time,
and `-n` lists what would be cloned without cloning it. A name that is nobody's
organization is tried as a user account. See [functions/clone-repos/README.txt](functions/clone-repos/README.txt).

fetch-repo-files — `gift fetch-repo-files [--file] [--branch=NAME] <url>`  
Copies a folder, or a single file, out of a GitHub repository into the current
directory — nothing is cloned, and no `.git` is left behind. The URL is the one
the browser shows: the repository, a `/tree/` folder, a `/blob/` file, a raw
link, or the path written straight after the repository name. `--file` (`-f`)
says the URL names one file rather than a folder, `--branch` (`-b`) reads a
branch, tag or commit other than the default one, `--out` puts it somewhere
other than here, and `--force` writes over what is already there. A private
repository wants a token — configured, in the environment, or a signed-in `gh`.
See [functions/fetch-repo-files/README.txt](functions/fetch-repo-files/README.txt).

pull-repos — `gift pull-repos [--dir=PATH]`  
Finds every git repository under one directory and runs
`git pull --recurse-submodules --autostash` in each. The directory is the current one
unless `--dir` or the configured `repo_root` names another, and `-n` shows the
commands without running them. See [functions/pull-repos/README.txt](functions/pull-repos/README.txt).

weekly-prs — `gift weekly-prs [--repos=owner/repo1,owner/repo2] [--author=login]`  
Lists GitHub pull requests for a chosen week, grouped by date. Weeks run Monday
to Sunday; `--weeks=N` counts back from this one and skips the prompt, and `-v`
adds each PR's number, state and URL. Configure `repos` and `author` once and
the common case needs no flags. See [functions/weekly-prs/README.txt](functions/weekly-prs/README.txt).


Configuration
-------------

Everything is in one file, `config.json` in this folder. `gift config` opens it
in `$EDITOR`; `gift config --path` prints where it is.

gift's own settings are at the top level, and each function's are under
`functions.<name>`:

```json
{
    "github_webhook_secret": "…",
    "port": 3999,
    "functions": {
        "repo-master": { "repo_root": "/Users/me/projects" },
        "weekly-prs": { "repos": "owner/repo1,owner/repo2", "author": "octocat" }
    }
}
```

The file is created on first use with the settings worth looking at, at their
defaults, so opening it shows what there is to set rather than a blank page. A
few are left out of it — the command behind each of repo-master's menu entries,
say, where the default suits nearly everybody; they still work when written in
by hand, and each function's README lists them. It is git-ignored and written
0600, because it holds the webhook secret.

Each setting is declared in a `config.schema.json` next to the code that reads
it — the project root for gift, the function's own folder for a function —
which is where its default, its description and the environment variable it is
handed to scripts as all come from.

A value already in the environment always wins, so `GIFT_REPOS=... gift
weekly-prs` still overrides what is configured for one run.  

