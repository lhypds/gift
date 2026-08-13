
gift
====

`gift` is a simple webhook server.  


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


Other functions
---------------

List functions with `gift help`.  
Run `gift run` and choose a function, or invoke one directly with
`gift <function-name>`.  


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
        "list-weekly-prs": { "repos": "owner/repo1,owner/repo2", "author": "octocat" }
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
list-weekly-prs` still overrides what is configured for one run.  


Setup
-----

Setup and install  
```
./setup.sh
./install.sh
```

Update  
`gift update` pulls the latest code into the folder gift is installed from.

Uninstall  
`./uninstall.sh`  
