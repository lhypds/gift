github
======

An API endpoint that accepts webhook deliveries from GitHub.

The server listens on GIFT_SERVE_PATH (/hooks/github by default). Every delivery
has its X-Hub-Signature-256 checked against the shared secret before anything
else happens; one that does not verify is answered 401 and runs nothing, and the
log says which of the three reasons it was — a secret that does not match, a body
that did not arrive whole, or a signature header something in front rewrote.

A verified delivery runs the hooks whose repository, event and branch all match.


hooks.json
----------

    {
        "name": "restart-stash",
        "trigger": {
            "type": "github",
            "repo": "lhypds/stash",
            "events": ["push"],
            "branches": ["main"],
            "secretEnv": "GITHUB_WEBHOOK_SECRET"
        },
        "run": "/var/www/stash/restart.sh",
        "cwd": "/var/www/stash"
    }

repo        owner/repo, or * for any. Compared whole, so an owner on its own
            never matches.
events      the GitHub event names — push, pull_request, release — or * for any.
branches    branch names, or * for any. An empty list is any. A push to a branch
            outside the list is answered with 'No match' and runs nothing.
secretEnv   which environment variable holds the secret this webhook is signed
            with. Only needed when different repositories use different secrets.


What the script is given
------------------------

GIFT_HOOK            the hook's name
GIFT_TRIGGER         github
GIFT_EVENT           the GitHub event — push, pull_request, …
GIFT_DELIVERY        GitHub's delivery id
GIFT_REPO            owner/repo
GIFT_REF             refs/heads/main
GIFT_BRANCH          main
GIFT_BEFORE          the commit before the push
GIFT_AFTER           the commit after it
GIFT_SENDER          the GitHub login that caused it
GIFT_PAYLOAD_FILE    a file holding the delivery's JSON, removed after the run


Telling GitHub about it
-----------------------

`gift create` offers to create the repository's webhook with `gh`, and then asks
GitHub to confirm it is really there — gh exiting 0 is gh's word for it, and a
hook GitHub never calls looks exactly like a working one. That needs gh installed
and signed in with an account that may write the repository's webhooks, and
github_webhook_secret set. Set webhook_url in config.json to the complete public
delivery URL, or gift asks for it.

Answering no adds the local hook alone; create the webhook under the repository's
Settings > Webhooks with the same secret.


Settings
--------

github_webhook_secret   the value in the webhook's Secret field on GitHub
webhook_url             the complete public delivery URL
serve_path              the endpoint deliveries arrive on (/hooks/github)
