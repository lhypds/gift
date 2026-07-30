webhooks
========


Receive GitHub webhooks and run local scripts when a delivery matches.


Files
-----

| File                 | Description                                                             |
|----------------------|-------------------------------------------------------------------------|
| `server.js`          | The webhook server — started by `gift serve`                            |
| `.env.example`       | Template for the secret and listener defaults; `./setup.sh` copies it   |
| `.env`               | Your local settings, the secret included (git-ignored)                  |
| `hooks.example.json` | Example configuration; `./setup.sh` copies it to `hooks.json`           |
| `hooks.json`         | Your local configuration (git-ignored — it points at machine paths)     |
| `ecosystem.config.cjs` | PM2 configuration; takes `PM2_NAME` and `PORT` from `.env`            |
| `start.sh`           | Start the server under PM2                                              |
| `stop.sh`            | Stop it                                                                 |
| `restart.sh`         | Pull the latest code, then stop and start                               |

Everything `gift serve` needs lives in this folder; the rest of the repo holds
no server configuration.


Usage
-----

```bash
gift serve [options]
```

| Option          | Description                                  | Default                      |
|-----------------|----------------------------------------------|------------------------------|
| `--config=FILE` | Hook configuration file                      | `webhooks/hooks.json`         |
| `--host=HOST`   | Interface to bind                            | `127.0.0.1`                  |
| `--port=PORT`   | Port to listen on                            | `3001`                       |
| `--path=PATH`   | Webhook endpoint path                        | `/hooks/github`              |
| `--dry-run`     | Verify and match deliveries, but run no hook | off                          |
| `-h`, `--help`  | Show the help message and exit               |                              |

Defaults can also come from the environment (`GIFT_SERVE_HOST`, `PORT`,
`GIFT_SERVE_PATH`, `GIFT_SERVE_CONFIG`) or from `hooks.json`. Flags win, then the
environment, then the config file. `GIFT_SERVE_PORT` still works and takes
precedence over `PORT` if both are set.

Those variables are read from this folder's `.env` — whether the server is
started by `gift serve` or directly with `node webhooks/server.js` — and a value
already present in the real environment overrides the file.

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
  "host": "127.0.0.1",
  "port": 3001,
  "path": "/hooks/github",
  "hooks": [
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
| `run`       | Absolute path (or path relative to this folder) of the script to run              |
| `args`      | Fixed arguments for that script — never taken from the payload                    |
| `cwd`       | Working directory for the script (default: the script's own folder)               |
| `detach`    | `true` keeps the script running if the server stops, at the cost of no exit log   |
| `secretEnv` | Environment variable holding this hook's secret (default `GITHUB_WEBHOOK_SECRET`) |

A hook only fires when the delivery was signed with *its* secret, so several
repositories can share one server with separate secrets.

Without `hooks.json` the server still runs: deliveries are verified and logged,
but nothing is executed. `--dry-run` does the same with a config in place.

While one hook is running, a new matching delivery does not start a second copy;
it is coalesced into a single re-run after the current one finishes. (`detach`
hooks are not tracked, so they always start immediately.)


What a hook script receives
---------------------------

Nothing from the payload is ever placed on a command line. Fields arrive as
environment variables instead:

| Variable            | Example                                    |
|---------------------|--------------------------------------------|
| `GIFT_HOOK`         | `deploy-example`                           |
| `GIFT_EVENT`        | `push`                                     |
| `GIFT_DELIVERY`     | `72d3162e-cc78-11e3-81ab-4c9367dc0958`     |
| `GIFT_REPO`         | `YOUR_NAME/YOUR_REPOSITORY`                |
| `GIFT_REF`          | `refs/heads/main`                          |
| `GIFT_BRANCH`       | `main`                                     |
| `GIFT_BEFORE`       | commit SHA before the push                 |
| `GIFT_AFTER`        | commit SHA after the push                  |
| `GIFT_SENDER`       | GitHub login that triggered the delivery   |
| `GIFT_PAYLOAD_FILE` | Path to the full JSON payload (mode 0600)  |

Treat all of them as untrusted input: never `eval` them or paste them into a
shell command.


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
```

Local testing without a public address — forward deliveries from GitHub with
the `gh` CLI:

```bash
gh webhook forward --repo=owner/repo --events=push --url=http://127.0.0.1:3001/hooks/github
```

A tunnel (`cloudflared tunnel --url http://127.0.0.1:3001`, `ngrok http 3001`)
works too; use the tunnel's HTTPS address as the Payload URL.


Running it as a service
-----------------------

PM2 — the scripts in this folder:

```bash
./start.sh      # pm2 start ecosystem.config.cjs --update-env
./stop.sh       # pm2 stop $PM2_NAME
./restart.sh    # git pull --ff-only, then stop and start
```

`ecosystem.config.cjs` takes two settings from this folder's `.env`:

```
PM2_NAME=gift-webhooks
PORT=3001
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
GIFT_SERVE_PORT=3001
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
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 25m;
    }
}
```


Troubleshooting
---------------

Repository → Settings → Webhooks → Recent deliveries shows the headers, the
payload, and the response for every delivery, and can redeliver any of them.

| Status    | Meaning                                                          |
|-----------|------------------------------------------------------------------|
| 200 / 202 | Accepted (`200` also means no hook matched, or a `ping`)         |
| 401       | Missing or invalid signature — the secrets do not match          |
| 404       | Wrong path — check `--path` and the proxy configuration          |
| 405       | Reached the endpoint with something other than POST              |
| 413       | Payload above 25 MB                                              |
| 502       | The server is not running behind the proxy                       |


Requirements
------------

- Node.js >= 18 — no third-party packages are used
