
gift
====

`gift` is short for `git functions`.  
Provide Git and GitHub helper functions and a GitHub webhooks server.  


Git and GitHub helper functions
-------------------------------

List functions  
`gift list` lists all functions.  

Run a function  
`gift run` then choose a function to run.
Or run a function directly with  
`gift <function-name>`.  


Webhooks Server
---------------

Start  
`gift serve` starts a webhooks server that listens for GitHub events.

Stop  
`gift stop`  

Status  
`gift status` says whether the server is running: what PM2 reports about the
process, what the server answers on `GET /health`, and what it is set up to serve
— the endpoint, the hooks and the log. The exit code is 0 when it answers and 1
when it does not, and `gift status --json` prints the same for a script.  

Use `hooks.json` to configure which functions run for which GitHub events.  

Hooks  
`gift hook list` shows the configured hooks.  
`gift hook create` adds one, asking for the repository, the events, the script
and the working directory it runs in.  
`gift hook delete` removes one.  

The server reads `hooks.json` at startup, so run `gift serve` after a change.  

Log  
`gift log` prints the last 100 lines of the server log — `gift log 20` fewer —
and then keeps watching, printing each line as the server writes it. Ctrl-C
stops. `gift log --no-follow` prints the lines and exits.  


Setup
-----

Setup and install  
```
./setup.sh
./install.sh
```

Update  
`gift update` pulls the latest code into the folder gift is installed from.
Fast-forward only, so local work is never merged over. Run `gift serve` afterwards
to restart the webhooks server on it.  

Uninstall  
`./uninstall.sh`  
