website
=======

Poll a URL and run a script when the page changes or matches.

The page is fetched on a timer. What counts as worth firing for is `on`, and it
is worth being deliberate about it, because two of the three fire repeatedly:

    change   the page came back different from last time — a new status, a new
             build number, a page that started returning 500. Fires once per
             change, which is what most website hooks want.
    match    the page says something in particular, every poll it says it.
             Fires again on the next poll, and the one after.
    always   every successful poll. For a heartbeat, and little else.

A match narrows all three: with one set, `change` fires only when the page
changed *and* matches — which is how "tell me when the status page starts saying
'degraded'" is written.

The first poll after a restart never fires on `change`. There is nothing for it
to have changed from.

A poll that fails — DNS, a refused connection, a timeout — is logged and fires
nothing. A hook cannot tell "the site is down" from "this machine's network is
down", and running a deploy over the second is worse than missing the first.


hooks.json
----------

    {
        "name": "status-changed",
        "trigger": {
            "type": "website",
            "url": "https://example.com/status.json",
            "on": "change",
            "match": "degraded",
            "matchType": "contains",
            "interval": 60000,
            "timeout": 10000
        },
        "run": "/home/me/bin/alert.sh",
        "cwd": "/home/me/bin"
    }

url         the page to fetch. http:// or https://.
method      GET by default.
on          change (the default), match, or always.
match       text the page must contain for the hook to fire. Empty means any.
matchType   any, contains (case-insensitive), exact, or regex.
interval    how often to poll, in milliseconds. At least 1000.
timeout     how long to wait for the page, in milliseconds. 10000 by default.

Each website hook polls on its own timer, staggered a second apart at startup so
that ten of them are ten requests over ten seconds rather than ten at once.


What the script is given
------------------------

GIFT_HOOK              the hook's name
GIFT_TRIGGER           website
GIFT_EVENT             changed, matched or polled
GIFT_URL               the URL polled
GIFT_STATUS            the HTTP status
GIFT_PREVIOUS_STATUS   the status the poll before returned
GIFT_CHANGED           1 when the page differed from last time
GIFT_BODY              the body, up to 4 KB of it
GIFT_BODY_BYTES        how long it really was
GIFT_BODY_FILE         a file holding all of it, removed after the run
GIFT_MATCH             the text that matched
GIFT_MATCH_1 …         the regex capture groups, when matchType is regex

Only the first 5 MB of a response is read. A page that streams forever cannot
fill memory, and one that never finishes sending is abandoned at the timeout
rather than stalling the polls behind it.


Settings
--------

interval     the interval `gift create` suggests (60000 ms)
user_agent   the User-Agent sent with each poll (gift)
