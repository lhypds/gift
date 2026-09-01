clipboard
=========


Watch the clipboard and run a command when its contents change.

The clipboard is read on a timer and compared with what was there last time. A
change that matches runs the hook; a change that does not is ignored, and so is
whatever was already on the clipboard when the server started — that is not a
change, and firing on it would mean every restart runs every clipboard hook.


hooks.json
----------

    {
        "name": "save-todo",
        "trigger": {
            "type": "clipboard",
            "match": "^TODO:",
            "matchType": "regex",
            "interval": 1000
        },
        "run": "/home/me/bin/save-todo.sh",
        "cwd": "/home/me/notes"
    }

match       the text to look for. Empty means every change fires.
matchType   any, contains (the default, case-insensitive), exact, or regex.
            A regex's capture groups reach the command as GIFT_MATCH_1, _2, …
interval    how often to read the clipboard, in milliseconds. At least 200.
            All clipboard hooks share one timer, at the shortest interval any
            of them asked for.


What the command is given
-------------------------

GIFT_HOOK             the hook's name
GIFT_TRIGGER          clipboard
GIFT_EVENT            copied
GIFT_CLIPBOARD        what was copied, up to 4 KB of it
GIFT_CLIPBOARD_BYTES  how long it really was
GIFT_CLIPBOARD_FILE   a file holding all of it, removed after the run
GIFT_MATCH            the text that matched
GIFT_MATCH_1 …        the regex capture groups, when matchType is regex

What was copied is never part of a command line. Someone who copies `; rm -rf /`
has copied a string, and it reaches the command as one.


Reading the clipboard
---------------------

There is no portable way to do it, so gift uses the tool the platform has, chosen
once at startup:

    macOS      pbpaste
    Wayland    wl-paste
    X11        xclip, or xsel
    Windows    powershell Get-Clipboard

A machine with none of them says so once at startup, and its clipboard hooks
never fire. On a headless Linux server that is usually the right answer — there
is no clipboard to watch.


Settings
--------

interval   the interval `gift create` suggests (1000 ms)
