
gift
====

`gift` is a simple webhook server.  


Webhooks Server
---------------

Start  
`gift serve` starts a webhooks server that listens for GitHub events.

Stop  
`gift stop`  

Status  
`gift status` says whether the server is running.  

Hooks  
`gift list` shows the configured hooks.  
`gift create` adds one.  
Hook names are labels and may be reused; delete same-named hooks by their list position.

For a specific repository, `gift create` asks whether to create the GitHub
webhook with `gh` — right after the repository, before anything else is asked or
written. Set `GIFT_WEBHOOK_URL` in `.env` to the complete public delivery URL,
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
