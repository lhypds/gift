file
====

Watch a file or folder and run a script when it changes.

fs.watch is used as the doorbell rather than the answer: it reports 'rename' for
a file appearing *and* for one disappearing, and 'change' more than once for a
single save. So a notification starts a short debounce, and when that settles the
tree is walked and compared against the snapshot from last time. The difference
between the two is what actually happened — this file added, that one changed,
this one gone.

One run per settled batch, not one per file. Saving a file is one thing that
happened, and so is a checkout that rewrote four hundred of them; the script is
told which file through GIFT_FILE and given the whole list in GIFT_FILES_FILE.

What is already on disk when the server starts is never a change. The first
snapshot is the baseline.


hooks.json
----------

    {
        "name": "reload-config",
        "trigger": {
            "type": "file",
            "path": "/etc/myapp",
            "pattern": "*.yml",
            "events": ["add", "change"],
            "recursive": true,
            "debounce": 500
        },
        "run": "/etc/myapp/reload.sh",
        "cwd": "/etc/myapp"
    }

path        the file or folder to watch. Absolute — a relative path would mean
            whatever folder the server happened to start in.
pattern     only files matching it count: *.yml, **/*.test.js, config.*. A path
            pattern, not a regular expression. Empty means every file.
events      add, change, delete. ["add", "change"] by default.
recursive   watch subfolders too. Yes by default; no meaning for a single file.
debounce    how long to wait for writes to settle before comparing, in
            milliseconds. 500 by default. A long copy is compared once it is
            over rather than halfway through.
poll        how often to re-scan when fs.watch cannot be used. 2000 ms.


What the script is given
------------------------

GIFT_HOOK          the hook's name
GIFT_TRIGGER       file
GIFT_EVENT         add, change, delete — or `changed` for a mixed batch
GIFT_PATH          the folder or file being watched
GIFT_FILE          the file that changed, absolute
GIFT_FILE_NAME     just its name
GIFT_FILE_EVENT    what happened to it — add, change or delete
GIFT_FILE_COUNT    how many files were in the batch
GIFT_FILES_FILE    a tab-separated `event<TAB>path` list of all of them,
                   removed after the run


Limits
------

Recursive fs.watch is not available on every platform and Node version, and a
folder that does not exist yet cannot be watched at all. Both fall back to
re-scanning on a timer, and the log says which mode a hook is in. Everything
downstream is identical either way.

At most 20000 files under one watched folder are tracked; past that the log says
so at startup. A watch aimed at a home directory should degrade into a complaint,
not into a server that never finishes a scan.


Settings
--------

debounce   the debounce `gift create` suggests (500 ms)
poll       how often to re-scan when fs.watch cannot be used (2000 ms)
