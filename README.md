
gift
====

`gift` is a hooks server and a set of Git and GitHub tools.

A hook is two halves: a **trigger** that says what has to happen, and a **bash
script** to run when it does. The trigger can be a GitHub webhook delivery, the
clipboard changing, a website coming back different, or a file being written.


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
carried across, so the webhook secret and the hooks survive the upgrade. Hooks
written before triggers existed are read as GitHub triggers and need no editing.

`gift update` is the checkout equivalent — it is a `git pull --ff-only` in the
folder gift is installed from, so it has nothing to pull in a release install.

Uninstall  
`~/.gift/uninstall.sh` removes the `gift` command; delete `~/.gift` to remove
the rest. From a checkout it is `./uninstall.sh`.  


Hooks server
------------

Start  
`gift serve` starts the hooks server. It pulls the latest code and rebuilds the
dashboard first.

Restart  
`gift restart` puts the server back on the code already on disk — no pull, no
rebuild, so it needs no network and returns straight away.

Stop  
`gift stop`  

Status  
`gift status` says whether the server is running, and what it is watching.  

Hooks  
`gift list` shows the configured hooks.  
`gift create` adds one.  
`gift triggers` lists the trigger types.  
Hook names are labels and may be reused; delete same-named hooks by their list position.
When an existing hook script is not executable, `gift create` warns and offers
to add execute permission before saving the hook.

One process watches everything. Whichever trigger notices something, the same
things follow: one run at a time per hook with a burst coalesced into a single
follow-up, arguments that come from `hooks.json` and never from what was
observed, a child spawned without a shell, and the output captured into
`hooks.log` and the dashboard.

The server restarts automatically after `gift create` or `gift delete`.

Log  
`gift log` prints the last 10 lines of the server log — `gift log 20` more —
and then keeps watching, printing each line as the server writes it. Ctrl-C
stops. `gift log --no-follow` prints the lines and exits.  

Dashboard  
`http://127.0.0.1:3999` lists what has happened in the last 24 hours, whichever
trigger noticed it, and what each hook printed.


Triggers
--------

`gift create` asks which of these the hook should be first; every question after
that follows from the answer. `gift help <trigger>` gives the full `hooks.json`
fields and the variables the script is handed.

**github** — an API endpoint that accepts webhook deliveries from GitHub.  
Asks for the repository (`owner/repo`, or `*` for any) and the branches to watch
(comma separated, `*` for any, `main, master` by default). Every delivery has its
signature checked against the shared secret before anything else happens; a push
to a branch outside the list is answered with `No match` and runs nothing.

For a specific repository it also asks whether to create the GitHub webhook with
`gh`, before anything is written. Set `webhook_url` in `config.json` to the
complete public delivery URL, including `/hooks/github`; otherwise it asks for
the URL too. Once the hook is saved, gift asks GitHub to confirm the webhook is
really there, so a hook that GitHub never calls is reported rather than assumed
to work. Answering yes needs `gh` installed and signed in (`gh auth login`, with
an account that may write the repository's webhooks) and the secret set; if
either is missing `gift create` says which and stops without writing anything.
Answer `n` to add the local hook alone and create the webhook under the
repository's Settings > Webhooks with the same secret.

**clipboard** — run a script when what is on the clipboard changes.  
Asks whether every change fires, or only one matching some text (`contains`,
`exact` or `regex`), and how often to read. What was copied reaches the script as
`GIFT_CLIPBOARD`, and whole in the file `GIFT_CLIPBOARD_FILE`; a regex's capture
groups arrive as `GIFT_MATCH_1`, `GIFT_MATCH_2`. Needs `pbpaste`, `wl-paste`,
`xclip` or `xsel` — a machine with none says so at startup.

**website** — poll a URL and run a script when the page changes or matches.  
Asks for the URL, whether to fire on `change` (the page came back different),
`match` (it says something in particular) or `always`, and how often to poll. A
poll that fails is logged and fires nothing: a hook cannot tell "the site is
down" from "this machine's network is down". It also asks whether the request
uses credentials. Answering yes to "Use credentials?" adds a `hooks.json`
template for localStorage, sessionStorage, cookies and headers; fill it manually
and restart gift. A credential that expires — an access token pasted out of a
browser usually lives ten minutes — takes a `credentials.refresh` block saying
which statuses mean "expired", what request asks for a new one, and where in the
answer the new values are; gift then renews it, retries the poll, and writes the
rotated token back to `hooks.json`, so the hook keeps working without anyone
pasting another. See `triggers/website/README.txt`. Every website hook keeps its
latest response body under `logs/hooks/<hook name>/` by default; set
`saveLastResponse` to false to opt out.

**file** — run a script when a file or folder changes.  
Asks for the path, a pattern (`*.yml`, `**/*.js`), whether to watch subfolders,
and which of `add`, `change`, `delete` count. One run per settled batch, not one
per file — a checkout that rewrote four hundred files is one thing that happened,
and the whole list is handed over in `GIFT_FILES_FILE`.

What was already there when the server started is never a change: not the
clipboard's contents, not the files on disk, and a website's first poll has
nothing to compare against. Restarting the server does not re-fire every hook.

Adding a fifth trigger is dropping a folder into `triggers/` with an `index.js`
that exports the contract documented at the top of
[triggers/index.js](triggers/index.js). It gains a `gift create` menu entry, a
section in `config.json` and a place in `gift list` with nothing else edited.


hooks.json
----------

```json
{
  "log": "hooks.log",
  "hooks": [
    {
      "name": "restart-on-push",
      "trigger": {
        "type": "github",
        "repo": "me/app",
        "events": ["push"],
        "branches": ["main"]
      },
      "run": "/opt/myapp/restart.sh",
      "args": [],
      "cwd": "/opt/myapp",
      "detach": false,
      "enabled": true
    },
    {
      "name": "reload-config",
      "trigger": {
        "type": "file",
        "path": "/opt/myapp/conf",
        "pattern": "*.yml",
        "events": ["add", "change"]
      },
      "run": "/opt/myapp/reload.sh",
      "cwd": "/opt/myapp"
    }
  ]
}
```

`run` is an absolute path to a `.sh` script and `cwd` an absolute directory —
neither is guessed, because a relative path would depend on where the server
happened to be started from. `cwd` defaults to the script's own folder. `enabled`
is on unless it says `false`. Everything inside `trigger` belongs to the trigger
type; see `gift help <type>`.

`hooks.json` is git-ignored and written with `0600` permissions because website
hooks may contain plaintext cookies, storage values and request headers. The
dashboard redacts each `credentials` object; edit the file itself to change one.

A hook written before triggers existed — with `repo`, `events` and `branches` at
the top level and no `trigger` — is read as a GitHub trigger, so an older
`hooks.json` keeps working as it is. See
[hooks.example.json](hooks.example.json) for one of each type.


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
it wears an orange bar, and one that has committed and not pushed wears a dark grey
one; enter opens the menu of what may be done to the ones picked — open
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

Three kinds of section, and which one a setting belongs in follows from who
reads it: the server's address and PM2 name are gift's own, the webhook secret is
the GitHub trigger's, a repository root is a function's.

```json
{
    "pm2_name": "gift",
    "port": 3999,
    "triggers": {
        "github": { "github_webhook_secret": "…", "webhook_url": "…" },
        "website": { "interval": 60000 }
    },
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
it — the project root for gift, the trigger's or function's own folder otherwise
— which is where its default, its description and the environment variable it is
handed to scripts as all come from.

A `config.json` written before triggers existed has `github_webhook_secret`,
`webhook_url` and `serve_path` at the top level. They are read from there as
though they had always been under `triggers.github`, and move there the next time
anything saves the file. Nothing has to be edited by hand.

A value already in the environment always wins, so `GIFT_REPOS=... gift
weekly-prs` still overrides what is configured for one run.  
