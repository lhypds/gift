website
=======


Poll a URL and run a command when the page changes or matches.

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
            "timeout": 10000,
            "credentials": {
                "localStorage": {
                    "sample_auth_store": {
                        "accessToken": "xxx",
                        "refreshToken": "xxx"
                    }
                },
                "sessionStorage": {},
                "cookies": {
                    "session_id": "replace-with-cookie-value"
                },
                "headers": {
                    "x-sample-authorization": {
                        "from": "localStorage",
                        "key": "sample_auth_store",
                        "field": "accessToken"
                    }
                },
                "refresh": {
                    "url": "https://example.com/api/v1/auth/refresh",
                    "on": [401],
                    "body": {
                        "refresh_token": {
                            "from": "localStorage",
                            "key": "sample_auth_store",
                            "field": "refreshToken"
                        }
                    },
                    "expect": { "code": 0 },
                    "save": {
                        "data.access_token": {
                            "from": "localStorage",
                            "key": "sample_auth_store",
                            "field": "accessToken"
                        },
                        "data.refresh_token": {
                            "from": "localStorage",
                            "key": "sample_auth_store",
                            "field": "refreshToken"
                        }
                    }
                }
            },
            "saveLastResponse": true
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
credentials optional localStorage, sessionStorage, cookies and headers kept in
            hooks.json, plus an optional `refresh` for credentials that expire.
            `gift create` adds an empty template when "Use credentials?" is
            answered yes; edit the file manually and restart.
saveLastResponse
            true saves the body of every completed HTTP response under
            logs/hooks/<hook name>/last_response.ext. The file is replaced
            atomically and written 0600. Its extension follows Content-Type,
            falling back to the URL, and the same 5 MB response cap applies.
            true is the default; set it to false manually to opt out.

`gift create` offers hook-<site> as the name: hook-hub.example.com for
https://hub.example.com/api/v1/publish-reviews/status. The site rather than the
last part of the path, because half the pages worth polling are called /status,
and the path is the part most likely to be edited after the hook exists. A
leading www. is dropped, and any other name may be typed over it.

Each website hook polls on its own timer, staggered a second apart at startup so
that ten of them are ten requests over ten seconds rather than ten at once.

Every poll writes one line to logs/hooks/<hook name>/hook.log — the time it
asked, whether the command ran (fired, quiet or failed), and why:

    2026-08-30T14:47:06.704Z  quiet   the page has not changed  url=… status=200 ms=138
    2026-08-30T14:48:06.912Z  fired   the page came back different  url=… status=200 ms=142

A hook that fires twice a month says nothing in hooks.log in between and has an
empty error.log while it works, so this is where "it is still polling, the answer
is just the same" is read.


Credentials from browser storage
--------------------------------

The hook runs in Node, so it cannot load a browser profile or directly populate
a page's localStorage/sessionStorage. The two storage objects in hooks.json are
credential sources: a header can point to a storage key and field, as
x-sample-authorization does above. A storage value may be pasted as a JSON object
or as the JSON string returned by localStorage.getItem(). Headers may also be
literal strings:

    "headers": {
        "x-api-key": "replace-with-key"
    }

Cookies are sent as one HTTP Cookie header. Put them in the cookies object as
name/value strings. If credentials are enabled but a referenced field is empty,
the poll is skipped instead of making an unauthenticated request.
Credential headers and cookies follow same-origin redirects, but are stripped
before following a redirect to another origin.

hooks.json is written 0600 and credentials are redacted from the dashboard's
/api/hooks.json view, but it still contains plaintext secrets on disk. Keep it
out of source control, include only the fields the request needs, and rotate any
value that is exposed. Storage and cookies are snapshots; without a `refresh`
below, edit hooks.json and run `gift restart` after the browser rotates them.


Credentials that expire
-----------------------

An access token pasted out of a browser often lives ten minutes. Poll every
minute with one and the hook works for ten polls and then answers 401 forever,
which is not a page that changed and must not run anybody's command.

`credentials.refresh` is what stops that. It says which statuses mean "expired",
what request asks for a new credential, and where in the answer the new values
are — see the block in the example above.

    url       the endpoint that issues a new credential.
    method    POST by default.
    on        the statuses that mean the credential expired. [401] by default.
    timeout   how long to wait for it, in milliseconds. 10000 by default.
    body      the JSON body to send. A value may be a literal, or a
              { from, key, field } pointer at stored credentials — which is how
              the refresh token gets sent without being written twice.
    headers   extra headers, as literals or the same pointers. The poll's own
              credential headers are NOT sent: a refresh is normally the one
              request that must work with the access token already expired.
    expect    fields the answer must equal for the refresh to have worked. An
              API that reports failure as {"code": 401} under a 200 is common
              enough that trusting the status alone would store a credential
              made of nulls.
    save      where the new values go: a dotted path into the answer, pointing
              at the stored credential to overwrite. Required.

What `save` writes is kept in memory and written back into hooks.json, because
refresh tokens usually rotate — the one in the file is spent the moment it is
used, and a restart that read the spent one would have nothing left to refresh
with. The write replaces only the stored values that changed, keeps the shape
they were pasted in, and leaves the file at 0600.

A poll that gets an `on` status renews once and asks again, and the second answer
is the one the hook sees; a 401 never reaches the command. If the renewal fails,
or the page still refuses the new credential, the poll is skipped and logged, the
same as any other failed poll. Nothing fires.

Two things worth knowing before turning it on. A refresh is never followed
through a redirect, because the request carries the long-lived token in its body.
And rotating a refresh token invalidates the one the browser is holding, so the
browser session that produced the credential gets logged out the first time gift
renews it.


What the command is given
-------------------------

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
