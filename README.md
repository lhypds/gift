
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
webhook with `gh`. Set `GIFT_WEBHOOK_URL` in `.env` to the complete public
delivery URL, including `/hooks/github`; otherwise it asks for the URL too.
It then asks GitHub to confirm the webhook is there, so a hook in `hooks.json`
that GitHub never calls is reported rather than assumed to work.

This needs a signed-in `gh` on the machine gift runs on — `gh auth login`, with
an account that may write the repository's webhooks. Without one, `gift create`
says so and adds the local hook only; add the webhook under the repository's
Settings > Webhooks, with the same secret as `GITHUB_WEBHOOK_SECRET`.

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
