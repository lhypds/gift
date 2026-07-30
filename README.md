
gift
====

`gift` is short for **git toolkit**.

A small collection of git and GitHub helpers behind one command. Every tool
lives in its own folder under `commands/`, and the folder name *is* the command
name.

```bash
gift list      # commands/list-weekly-prs        — PRs of a chosen week, by date
gift recur     # commands/recursively-pull-repos — git pull every repo under the cwd
```

Alongside them, `gift serve` starts the webhook server in `server/` — a
long-running service rather than a tool you run and wait for, so it lives
outside `commands/`.

```
gift/
├── bin/  lib/  completions/   the CLI itself
├── commands/                  one folder per command
│   ├── list-weekly-prs/
│   └── recursively-pull-repos/
├── server/                    the webhook server, started by `gift serve`
└── test/
```


Setup
-----

```bash
./setup.sh     # check Node.js >= 18 and the tools the commands use, create .env
./install.sh   # install the global `gift` command and shell completion
```

Uninstall

```bash
./uninstall.sh
```

`gift` uses only the Node.js standard library — there is nothing to `npm install`.


Commands
--------

| Command                       | Description                                                           |
|-------------------------------|-----------------------------------------------------------------------|
| `gift list-weekly-prs`        | List GitHub pull requests for a chosen week, grouped by date          |
| `gift recursively-pull-repos` | Run `git pull` in every git repository under the current directory    |
| `gift serve`                  | Start the webhook server: receive deliveries and run local scripts    |
| `gift help [command]`         | Show the command list, or one command's full documentation            |
| `gift commands`               | Print every command name (what shell completion reads)                |
| `gift completion zsh`         | Print the completion script for zsh or bash                           |
| `gift version`                | Show the installed version (`gift -v` works too)                      |

Arguments after the command name are passed straight through, so
`gift list --repos=owner/repo -v` reaches `list_weekly_prs.sh` unchanged.


Command names
-------------

A command is any folder in `commands/` holding an entry script — `main.sh`,
`<folder>.sh`, `<folder>.js`, or the same names with underscores. The folder
name is the command, and **any unique prefix works**:

```bash
gift list            # -> list-weekly-prs
gift recursively     # -> recursively-pull-repos
gift s               # -> serve
```

Command folders, `serve`, and the built-ins share one namespace, so prefixes
resolve across all of them. An ambiguous prefix lists the candidates instead of
guessing. Commands run in *your* current directory, which is what
`recursively-pull-repos` needs.


Tab completion
--------------

`./install.sh` installs completion for zsh (`~/.local/share/zsh/site-functions/_gift`)
and bash (`~/.local/share/bash-completion/completions/gift`), then prints the
one or two lines to add to `~/.zshrc` if they are missing:

```bash
export PATH="$HOME/.local/bin:$PATH"
fpath=(~/.local/share/zsh/site-functions $fpath)
autoload -Uz compinit && compinit
```

Then `gift <Tab>` lists the commands with their descriptions, and
`gift help <Tab>` completes command names. New command folders show up on their
own — the completion scripts read `gift commands`.


Webhook server
--------------

```bash
gift serve                 # start the receiver
gift serve --dry-run       # verify and log deliveries, run nothing
gift serve --port=4000
gift help serve            # full documentation
```

It verifies every delivery's `X-Hub-Signature-256` against
`GITHUB_WEBHOOK_SECRET`, answers GitHub within its 10-second window, and then
runs the scripts configured in `server/hooks.json` — matched by
repository, event, and branch. Payload data reaches those scripts as environment
variables only; nothing from the internet is ever placed on a command line.

See [server/README.txt](server/README.txt) for the configuration format, an
example deploy script, and systemd/Nginx setup.


Configuration
-------------

`./setup.sh` creates `.env` from `.env.example` (git-ignored). The CLI loads it
before running any command, so its values are available to every script:

| Variable                    | Used by      | Meaning                               |
|-----------------------------|--------------|---------------------------------------|
| `GITHUB_WEBHOOK_SECRET`     | `gift serve` | Webhook secret; required to start     |
| `GIFT_SERVE_HOST/PORT/PATH` | `gift serve` | Defaults for the listener             |
| `GIFT_REPOS`                | `gift list`  | Default repositories, comma separated |
| `GIFT_AUTHOR`               | `gift list`  | Default pull request author           |

Real environment variables always win over `.env`.


Adding a command
----------------

1. Create a folder under `commands/`, e.g. `commands/tag-release/`.
2. Put the entry script inside it: `tag-release.sh` (or `main.sh`, or a `.js`).
3. Add a `README.txt` — its first line of prose becomes the description in
   `gift help`, and the whole file is what `gift help tag-release` prints.

That is all; `gift`, its help, and tab completion pick it up immediately.

Scripts run with `GIFT_ROOT`, `GIFT_COMMAND`, `GIFT_COMMAND_DIR` and
`GIFT_NO_PAUSE=1` in their environment — the last one lets a script skip the
"Press Enter to exit" pause it needs when double-clicked from Finder.


Scripts
-------

Clear
`./clear.sh` - Remove `release/`, `dist/`, `node_modules/` and stray logs.

Test
`node test/run-tests.js` - Check command resolution and webhook handling.

Release
`./release.sh` - Build `release/gift_v<VERSION>.zip` and publish it on GitHub.
