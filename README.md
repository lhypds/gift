
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

When `gh` has an authenticated GitHub user, `gift create` also creates the
repository webhook. Set `GIFT_WEBHOOK_URL` in `.env` to the complete public
delivery URL, including `/hooks/github`; otherwise `gift create` asks for it.

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
