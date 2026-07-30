
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

Use `hooks.json` to configure which functions run for which GitHub events.  


Setup
-----

Setup and install  
```
./setup.sh
./install.sh
```

Uninstall  
`./uninstall.sh`  
