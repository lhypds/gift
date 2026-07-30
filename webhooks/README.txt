
webhooks
========


Receive GitHub webhooks and run local scripts when a delivery matches.


Files
-----

| File                   | Description                                                           |
|------------------------|-----------------------------------------------------------------------|
| `server.js`            | The webhook server — started by `gift serve`                          |
| `.env.example`         | Template for the secret and listener defaults; `./setup.sh` copies it |
| `.env`                 | Your local settings, the secret included (git-ignored)                |
| `hooks.example.json`   | Example configuration; `./setup.sh` copies it to `hooks.json`         |
| `hooks.json`           | Your local configuration (git-ignored — it points at machine paths)   |
| `hooks.log`            | What arrived and what ran, one line each (git-ignored)                |
| `test-hook.sh`         | A hook script that does nothing — for checking the wiring             |
| `ecosystem.config.cjs` | PM2 configuration; takes `PM2_NAME` and `PORT` from `.env`            |
| `start.sh`             | Start the server under PM2                                            |
| `stop.sh`              | Stop it                                                               |
| `restart.sh`           | Pull the latest code, then stop and start                             |

Everything `gift serve` needs lives in this folder; the rest of the repo holds
no server configuration.


Usage
-----

```bash
gift serve      # pull the latest code, then (re)start the server under PM2
gift stop       # stop it
gift hook       # list, create and delete hooks
gift log        # the last 100 lines of the log, then follow it live
```

`serve` and `stop` take no options — they run `restart.sh` and `stop.sh` from
this folder. `gift hook` is described under "Editing hooks from the command
line" below; it edits `hooks.json`, which the server reads at startup. `gift log`
is described under "The log". The
server's own flags belong to `server.js`, which PM2 starts and which you can also
run yourself:

```bash
node webhooks/server.js [options]
```

| Option          | Description                                  | Default               |
|-----------------|----------------------------------------------|-----------------------|
| `--config=FILE` | Hook configuration file                      | `webhooks/hooks.json` |
| `--host=HOST`   | Interface to bind                            | `127.0.0.1`           |
| `--port=PORT`   | Port to listen on                            | `3999`                |
| `--path=PATH`   | Webhook endpoint path                        | `/hooks/github`       |
| `--log=FILE`    | Log file to append to                        | `webhooks/hooks.log`  |
| `--no-log`      | Log to the console only, writing no file     | off                   |
| `--dry-run`     | Verify and match deliveries, but run no hook | off                   |
| `-h`, `--help`  | Show the help message and exit               |                       |

Defaults can also come from the environment (`GIFT_SERVE_HOST`, `PORT`,
`GIFT_SERVE_PATH`, `GIFT_SERVE_CONFIG`, `GIFT_SERVE_LOG`) or from `hooks.json`.
Flags win, then the environment, then the config file. `GIFT_SERVE_PORT` still
works and takes precedence over `PORT` if both are set.

Those variables are read from this folder's `.env` — whether the server is
started by PM2 or directly with `node webhooks/server.js` — and a value already
present in the real environment overrides the file.

The server also answers `GET /health` with `ok`, which is handy for uptime checks
and for confirming a reverse proxy is wired up correctly.


The secret
----------

Every delivery must carry a valid `X-Hub-Signature-256` header, so a secret is
required — the server refuses to start without one. Generate one with:

```bash
openssl rand -hex 32
```

Put the same value in GitHub's webhook "Secret" field and in this folder's
`.env` (copy `.env.example` if it is not there yet):

```
GITHUB_WEBHOOK_SECRET=8c29d74b...961a5da
```

`webhooks/.env` is git-ignored. Never commit a secret.


Configuration
-------------

`hooks.json`:

```json
{
  "log": "hooks.log",
  "hooks": [
    {
      "name": "test",
      "repo": "*",
      "events": ["*"],
      "branches": ["*"],
      "run": "/Users/you/code/gift/webhooks/test-hook.sh",
      "args": [],
      "cwd": "/Users/you/code/gift/webhooks",
      "detach": false,
      "secretEnv": "GITHUB_WEBHOOK_SECRET"
    },
    {
      "name": "deploy-example",
      "repo": "YOUR_NAME/YOUR_REPOSITORY",
      "events": ["push"],
      "branches": ["main"],
      "run": "/opt/myapp/deploy.sh",
      "args": [],
      "cwd": "/opt/myapp",
      "detach": false,
      "secretEnv": "GITHUB_WEBHOOK_SECRET"
    }
  ]
}
```

| Field       | Description                                                                       |
|-------------|-----------------------------------------------------------------------------------|
| `name`      | Label used in logs                                                                |
| `repo`      | `owner/repo` that may trigger this hook; `*` for any                              |
| `events`    | GitHub event names, e.g. `push`, `pull_request`, `release`; `*` for any           |
| `branches`  | Branch names for `push` events; empty or `*` for any                              |
| `run`       | Absolute path of the `.sh` script to run — required                               |
| `args`      | Fixed arguments for that script — never taken from the payload                    |
| `cwd`       | Absolute path of the directory the script runs in — required                      |
| `detach`    | `true` keeps the script running if the server stops, at the cost of no exit log   |
| `secretEnv` | Environment variable holding this hook's secret (default `GITHUB_WEBHOOK_SECRET`) |

Outside `hooks`, only `log` is set here. `host`, `port` and `path` belong in
`.env` — they are also accepted in this file, but the `.env` values win, so
keeping them in both places only makes one of them a lie. They are worth setting
here for a config used on its own (`--config=other.json` with no `.env` beside
it) and nowhere else.

`run` and `cwd` are both required, and both are absolute — `run` an absolute path
ending in `.sh`, `cwd` an absolute directory. Nothing is resolved against the
current directory or the checkout, so a hook runs the same script from the same
place no matter where the server was started; a relative path is a startup error
naming the hook, not a surprise at deploy time. That is why `hooks.example.json`
ships placeholder paths (`/opt/myapp/deploy.sh`) rather than something inside the
repository: an example cannot know where your checkout lives. `gift hook create`
fills both in for you from what you type.

A hook only fires when the delivery was signed with *its* secret, so several
repositories can share one server with separate secrets.

Without `hooks.json` the server still runs: deliveries are verified and logged,
but nothing is executed. `--dry-run` does the same with a config in place.

While one hook is running, a new matching delivery does not start a second copy;
it is coalesced into a single re-run after the current one finishes. (`detach`
hooks are not tracked, so they always start immediately.)


Editing hooks from the command line
-----------------------------------

`hooks.json` can be edited by hand; `gift hook` does the same three things
without opening it.

```bash
gift hook list              # what is configured right now
gift hook create            # add one, asking for each field
gift hook delete [name]     # remove one, from a menu or by name
```

`create` asks for the repository owner and name, the events and branches, the
script and its arguments, the working directory it runs in, whether to detach,
and which environment variable holds its secret. Enter takes the `[default]`
shown, Ctrl-C stops without writing anything, and nothing is saved until the
summary at the end is confirmed:

```
$ gift hook create
Adding a hook to webhooks/hooks.json.
Enter takes the [default]; Ctrl-C stops without writing anything.

Repository owner — GitHub user or organisation, * for any [*]: YOUR_NAME
Repository name — the part after YOUR_NAME/: YOUR_REPOSITORY
Hook name — the label it appears under in the log [deploy-your_repository]: deploy
Events — e.g. push, pull_request, release; * for any [push]:
Branches for push events — * for any [main]:
Script to run — an absolute path: /opt/myapp/deploy.sh
Arguments for the script — blank for none:
Working directory the script runs in [/opt/myapp]:
Let the script keep running if the server stops (detach)? [y/N]:
Environment variable holding this hook's webhook secret [GITHUB_WEBHOOK_SECRET]:

  deploy
    repo      YOUR_NAME/YOUR_REPOSITORY
    events    push
    branches  main
    run       /opt/myapp/deploy.sh
    cwd       /opt/myapp

Add this hook to webhooks/hooks.json? [Y/n]:
```

The repository can be pasted whole — `YOUR_NAME/YOUR_REPOSITORY`, an HTTPS URL
or an SSH remote all work, and answer `*` to the owner for any repository. Paths
are resolved from where you are standing, and a script that is missing or not
executable is pointed out rather than refused, since it may not be there yet.

`delete` shows the hooks numbered when no name is given. A name can be
shortened to any unique prefix, and `--yes` skips the confirmation. Both
commands leave everything else in the file untouched, formatting included.

The server reads `hooks.json` once, at startup, so run `gift serve` after
adding or deleting a hook.

| Option          | Description                                              |
|-----------------|----------------------------------------------------------|
| `--config=FILE` | Work on another configuration file (`GIFT_SERVE_CONFIG`) |
| `-y`, `--yes`   | Delete without asking for confirmation                   |

The log the server writes is read by `gift log`, described under "The log".


What a hook script receives
---------------------------

Nothing from the payload is ever placed on a command line. Fields arrive as
environment variables instead:

| Variable            | Example                                   |
|---------------------|-------------------------------------------|
| `GIFT_HOOK`         | `deploy-example`                          |
| `GIFT_EVENT`        | `push`                                    |
| `GIFT_DELIVERY`     | `72d3162e-cc78-11e3-81ab-4c9367dc0958`    |
| `GIFT_REPO`         | `YOUR_NAME/YOUR_REPOSITORY`               |
| `GIFT_REF`          | `refs/heads/main`                         |
| `GIFT_BRANCH`       | `main`                                    |
| `GIFT_BEFORE`       | commit SHA before the push                |
| `GIFT_AFTER`        | commit SHA after the push                 |
| `GIFT_SENDER`       | GitHub login that triggered the delivery  |
| `GIFT_PAYLOAD_FILE` | Path to the full JSON payload (mode 0600) |

Treat all of them as untrusted input: never `eval` them or paste them into a
shell command.


The log
-------

Everything the server prints is also appended to `webhooks/hooks.log`, so a
delivery can still be traced after a restart, when the console output has gone.
Each request leaves a trail: what arrived, whether it verified, which hooks
matched, exactly what was executed, whatever the script printed, and how it
ended.

```
... info   delivery received  event=push delivery=8f3c… from=140.82.115.34 bytes=8214 signed=yes agent=GitHub-Hookshot/abc123
... info   delivery accepted  event=push delivery=8f3c… repo=owner/repo ref=refs/heads/main branch=main commits=3 after=b2c1… sender=someone secret=GITHUB_WEBHOOK_SECRET bytes=8214
... info   hooks matched      status=202 delivery=8f3c… hooks=test|deploy-example
... info   running hook       hook=deploy-example delivery=8f3c… event=push repo=owner/repo branch=main run=/opt/myapp/deploy.sh cwd=/opt/myapp pid=48120 payload=/tmp/gift-webhook-8f3c….json
... info   [deploy-example] Already up to date.
... info   hook finished      hook=deploy-example delivery=8f3c… exit=0 ms=4210
```

Refused requests are recorded too, with the status that was sent back:

```
... warn   invalid signature           status=401 delivery=8f3c… event=push from=203.0.113.7
... warn   request to an unknown path  status=404 method=GET path=/wp-login.php from=203.0.113.7 agent=curl/8.7.1
```

| Where          | Detail                                                                        |
|----------------|-------------------------------------------------------------------------------|
| Default file   | `webhooks/hooks.log`, created `0600` (git-ignored)                            |
| Somewhere else | `--log=/var/log/gift-webhook.log`, `GIFT_SERVE_LOG`, or `log` in `hooks.json` |
| Console only   | `--no-log`, or `GIFT_SERVE_LOG=off`                                           |
| Rotation       | At 5 MB the file becomes `hooks.log.1`; one old file is kept                  |

`GET /health` is the one thing left out — uptime checks run every few seconds
and would bury the deliveries. A log that cannot be written is reported once and
then skipped; the server keeps running and keeps logging to the console.

`gift log` follows it without needing to know where it is — it reads the file the
server writes, wherever `--log`, `GIFT_SERVE_LOG` or `hooks.json` put it, prints
the last lines and then stays open, printing each new one as it arrives:

```bash
gift log                # the last 100 lines, then follow until Ctrl-C
gift log 20             # start with fewer
gift log --no-follow    # print them and stop
```

| Option          | Description                                                 |
|-----------------|-------------------------------------------------------------|
| `--no-follow`   | Print the lines and stop, for a pipe or a script            |
| `--log=FILE`    | Read another log file (default: the one `hooks.json` names) |
| `--lines=N`     | How many lines to start with (default: 100)                 |
| `--config=FILE` | Read the `log` setting from another configuration file      |

Following is `tail -F`, so the rotation at 5 MB is followed into the new
`hooks.log` rather than holding the old file open, and a log that does not exist
yet is waited for — `gift log` before `gift serve` works. Straight after a
rotation the opening window is filled from `hooks.log.1`.

Only the log goes to stdout — the one-line header goes to stderr, so
`gift log --no-follow > deliveries.txt` holds the log alone.

```bash
grep 'hook finished' webhooks/hooks.log     # every run and its exit code
grep -c 'status=401' webhooks/hooks.log     # deliveries that failed to verify
```

`pm2 logs gift-webhooks` shows the same lines live; the file is what remains
afterwards.


Checking the wiring
-------------------

`test-hook.sh` is a hook script that does nothing — it prints nothing, changes
nothing, and exits `0`. Point a hook at it with `repo`, `events` and `branches`
all set to `*`, and it fires on any delivery the secret verifies. Both paths are
absolute, so they are yours to fill in — `pwd` in this folder prints them:

```json
{ "name": "test", "repo": "*", "events": ["*"], "branches": ["*"],
  "run": "/Users/you/code/gift/webhooks/test-hook.sh",
  "cwd": "/Users/you/code/gift/webhooks" }
```

```bash
gift hook create     # asks for each field and writes the absolute paths for you
```

Use it to prove the path end to end — GitHub signed the delivery, the server
verified it, a hook matched, a script ran — without deploying anything. The
evidence is in the log:

```bash
gift serve
grep 'hook=test' webhooks/hooks.log
```

```
... info   running hook   hook=test delivery=8f3c… event=push repo=owner/repo branch=main run=…/webhooks/test-hook.sh cwd=…/webhooks pid=60885
... info   hook finished  hook=test delivery=8f3c… exit=0 ms=12
```

GitHub's "Redeliver" button on any past delivery re-runs it. Once real hooks are
in place the `test` hook can stay — it does nothing on every delivery, which is
also a heartbeat — or come out of `hooks.json`.


Configure the webhook on GitHub
-------------------------------

Repository → Settings → Webhooks → Add webhook

```
Payload URL:  https://your-domain.com/hooks/github
Content type: application/json
Secret:       (the value from webhooks/.env)
Events:       Just the push event
Active:       checked
```

GitHub sends a `ping` delivery right away; the server answers `pong`.

Deliveries must be answered within 10 seconds, so the server replies `202`
first and runs the hook afterwards.


Examples
--------

```bash
# Start with the configured hooks
gift serve

# Watch what would happen without running anything
gift serve --dry-run

# Listen on all interfaces, custom port and path
gift serve --host=0.0.0.0 --port=4000 --path=/hooks/gh

# Log somewhere else, or nowhere
node webhooks/server.js --log=/var/log/gift-webhook.log
node webhooks/server.js --no-log
```

Local testing without a public address — forward deliveries from GitHub with
the `gh` CLI:

```bash
gh webhook forward --repo=owner/repo --events=push --url=http://127.0.0.1:3999/hooks/github
```

A tunnel (`cloudflared tunnel --url http://127.0.0.1:3999`, `ngrok http 3999`)
works too; use the tunnel's HTTPS address as the Payload URL.


Running it as a service
-----------------------

PM2 — through the CLI:

```bash
gift serve      # pull the latest code, then (re)start under PM2
gift stop       # stop it
```

or the scripts in this folder, which are what those two run:

```bash
./start.sh      # pm2 start ecosystem.config.cjs --update-env
./stop.sh       # pm2 stop $PM2_NAME
./restart.sh    # git pull --ff-only, then stop and start
```

`gift serve` runs `restart.sh`, so it always deploys the current remote before
starting. To run the server attached to the terminal instead — which is what the
`--dry-run`, `--port` and `--config` flags above are for — start it directly:

```bash
node webhooks/server.js --dry-run
```

`ecosystem.config.cjs` takes two settings from this folder's `.env`:

```
PM2_NAME=gift-webhooks
PORT=3999
```

`PM2_NAME` is the name PM2 lists the process under, so `pm2 logs gift-webhooks`
and `pm2 delete gift-webhooks` follow from it. The secret is not passed through
PM2 — `server.js` reads `.env` itself at startup, which keeps it out of
`pm2 show` and the PM2 dump file.

`start.sh` refuses to start when `GITHUB_WEBHOOK_SECRET` is empty; without that
check the server would exit immediately and PM2 would restart it in a loop.

To bring it up on boot, run `pm2 save` once the process is running, then
`pm2 startup` and follow the command it prints.

systemd — `/etc/systemd/system/gift-webhook.service`:

```ini
[Unit]
Description=gift GitHub webhook server
After=network.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/gift
EnvironmentFile=/etc/gift-webhook.env
ExecStart=/usr/bin/node /opt/gift/webhooks/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/gift-webhook.env` (`chmod 600`, owned by root):

```
GITHUB_WEBHOOK_SECRET=your-secret
GIFT_SERVE_PORT=3999
```

`EnvironmentFile` is the better place for a production secret — root-owned and
outside the checkout — and systemd passes it as the real environment, so it wins
over `webhooks/.env`. Drop the line to keep the secret in `webhooks/.env` instead.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gift-webhook
sudo journalctl -u gift-webhook -f
```

Behind Nginx, keep the server on localhost and proxy to it:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location /hooks/github {
        proxy_pass http://127.0.0.1:3999;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 25m;
    }
}
```


Troubleshooting
---------------

`webhooks/hooks.log` is the first place to look: every request is there with the
status it was answered with, and every hook run with its exit code.

Repository → Settings → Webhooks → Recent deliveries shows the headers, the
payload, and the response for every delivery, and can redeliver any of them.

| Status    | Meaning                                                  |
|-----------|----------------------------------------------------------|
| 200 / 202 | Accepted (`200` also means no hook matched, or a `ping`) |
| 401       | Missing or invalid signature — the secrets do not match  |
| 404       | Wrong path — check `--path` and the proxy configuration  |
| 405       | Reached the endpoint with something other than POST      |
| 413       | Payload above 25 MB                                      |
| 502       | The server is not running behind the proxy               |


Requirements
------------

- Node.js >= 18 — no third-party packages are used
