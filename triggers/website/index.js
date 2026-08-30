// The website trigger — poll a URL and run a script when the answer is
// interesting.
//
//     { "type": "website", "url": "https://example.com/status", "on": "change" }
//
// Three things "interesting" can mean, and it is worth being deliberate about
// which, because two of them fire repeatedly:
//
//     change   the page came back different from last time — a new status, a
//              new build number, a page that started returning 500. Fires once
//              per change, which is what most website hooks want.
//     match    the page says something in particular, every poll it says it.
//              Fires again on the next poll, and the one after.
//     always   every successful poll. For a heartbeat, and little else.
//
// A `match` narrows all three: with one set, `change` fires only when the page
// changed *and* matches, which is how "tell me when the status page starts
// saying 'degraded'" is written.
//
// The first poll after a restart never fires on `change`: there is nothing to
// have changed from, and firing would mean every restart runs every hook.
'use strict';

const { forTrigger } = require('../../utils/log.js');
const { INLINE_LIMIT } = require('../runtime.js');
const match = require('../match.js');
const { fetchPage } = require('./poll.js');

const log = forTrigger('website');

const DEFAULT_INTERVAL_MS = 60000;
const MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const WHEN = ['change', 'match', 'always'];

// ----------------------------------------------------------------- contract ---

function urlProblem(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return 'Type the complete URL, including https://.';
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'The URL must use http:// or https://.';
    return null;
}

function normalize(trigger) {
    if (!trigger.url) throw new Error('has no "url" to poll');
    const problem = urlProblem(String(trigger.url));
    if (problem) throw new Error(`has a "url" that cannot be polled — ${problem}`);

    const spec = match.normalize(trigger);

    const on = String(trigger.on || 'change').toLowerCase();
    if (!WHEN.includes(on)) {
        throw new Error(`has an unknown "on" '${trigger.on}' — try one of: ${WHEN.join(', ')}`);
    }
    if (on === 'match' && spec.matchType === 'any') {
        throw new Error('is set to fire "on": "match" but has no "match" to test — it would fire on every poll');
    }

    const interval = trigger.interval === undefined ? DEFAULT_INTERVAL_MS : Number(trigger.interval);
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
        throw new Error(`has an "interval" of ${trigger.interval} — it must be at least ${MIN_INTERVAL_MS} ms`);
    }

    const timeout = trigger.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(trigger.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`has a "timeout" of ${trigger.timeout} — it must be a number of milliseconds`);
    }

    return {
        url: String(trigger.url),
        method: String(trigger.method || 'GET').toUpperCase(),
        on,
        ...spec,
        interval: Math.round(interval),
        timeout: Math.round(timeout),
    };
}

const FIRES = {
    change: 'when the page comes back different',
    match: 'every poll the page matches',
    always: 'every poll',
};

function describe(trigger) {
    const rows = [
        ['url', `${trigger.method === 'GET' ? '' : `${trigger.method} `}${trigger.url}`],
        ['fires', FIRES[trigger.on]],
    ];
    if (trigger.matchType !== 'any') rows.push(['match', match.describe(trigger)]);
    rows.push(['polled', `every ${trigger.interval} ms`]);
    return rows;
}

function line(trigger) {
    return `${trigger.url}  on ${trigger.on}`;
}

async function ask({ askText }) {
    console.log('The page is fetched on a timer; what comes back decides whether the script runs.');
    console.log('');

    const url = await askText('URL to poll', { validate: (value) => (value ? urlProblem(value) : 'A URL is needed.') });
    if (url === null) return null;

    const on = await askText('Fire when — change, match or always', {
        fallback: 'change',
        validate: (value) => (WHEN.includes(value.toLowerCase()) ? null : `Answer ${WHEN.join(', ')}.`),
    });
    if (on === null) return null;

    // `match` has no meaning without something to match, so it is asked for
    // rather than offered; for `change` and `always` it narrows what fires.
    const required = on.toLowerCase() === 'match';
    const text = await askText(
        required ? 'Text the page must contain to fire' : 'Text the page must contain — blank for any',
        {
            validate: (value) => (required && !value ? 'Firing on a match takes something to match.' : null),
        },
    );
    if (text === null) return null;

    const interval = await askText('How often to poll, in milliseconds', {
        fallback: String(Number(process.env.GIFT_WEBSITE_INTERVAL) || DEFAULT_INTERVAL_MS),
        validate: (value) => {
            const ms = Number(value);
            if (!Number.isFinite(ms)) return 'Type a number of milliseconds.';
            if (ms < MIN_INTERVAL_MS) return `Poll no more often than every ${MIN_INTERVAL_MS} ms.`;
            return null;
        },
    });
    if (interval === null) return null;

    return {
        trigger: {
            type: 'website',
            url,
            method: 'GET',
            on: on.toLowerCase(),
            match: text || '',
            matchType: text ? 'contains' : 'any',
            interval: Math.round(Number(interval)),
            timeout: DEFAULT_TIMEOUT_MS,
        },
        label: url,
    };
}

function afterNotes() {
    return [];
}

// --------------------------------------------------------------------- poll ---

/**
 * One timer per hook, unlike the clipboard: two hooks watching two URLs have
 * nothing to share, and two watching the same URL at different intervals still
 * want their own cadence. The polls are staggered so that a restart does not
 * fire ten requests in the same millisecond.
 */
function start({ hooks, runtime, options }) {
    const timers = [];
    let stopped = false;

    hooks.forEach((hook, index) => {
        const trigger = hook.trigger;
        // What the last poll saw. Null until the first one lands, which is what
        // stops `change` from firing on the poll that has nothing to compare to.
        let previous = null;
        let polling = false;

        const poll = async () => {
            if (polling || stopped) return;
            polling = true;
            try {
                const result = await fetchPage(trigger.url, {
                    method: trigger.method,
                    timeout: trigger.timeout,
                    userAgent: process.env.GIFT_WEBSITE_USER_AGENT || options.userAgent,
                });
                if (stopped) return;

                if (!result.ok) {
                    // Logged, never fired on: a hook cannot tell "the site is
                    // down" from "this machine's DNS is down", and running a
                    // deploy script over the second is worse than missing the
                    // first.
                    log('warn', `poll failed: ${result.error}`, { hook: hook.name, url: trigger.url });
                    return;
                }

                // The status is part of what "changed" means, so a page that
                // starts answering 500 with the same body still counts.
                const state = `${result.status}:${result.digest}`;
                const changed = previous !== null && previous.state !== state;
                const first = previous === null;
                const was = previous;
                previous = { state, status: result.status };

                const found = match.test(result.body, trigger);
                if (trigger.matchType !== 'any' && !found) return;

                const fires = trigger.on === 'always'
                    || (trigger.on === 'match' && found)
                    || (trigger.on === 'change' && changed);
                if (!fires) {
                    if (first && trigger.on === 'change') {
                        log('info', 'first poll — nothing to compare against yet', {
                            hook: hook.name, url: trigger.url, status: result.status,
                        });
                    }
                    return;
                }

                runtime.dispatch([hook], {
                    trigger: 'website',
                    kind: trigger.on === 'change' ? 'changed' : trigger.on === 'match' ? 'matched' : 'polled',
                    title: trigger.url,
                    link: { label: trigger.url, href: trigger.url, title: `Open ${trigger.url}` },
                    detail: `${result.status} in ${result.ms} ms`,
                    env: {
                        GIFT_URL: trigger.url,
                        GIFT_STATUS: String(result.status),
                        GIFT_PREVIOUS_STATUS: was ? String(was.status) : '',
                        GIFT_CHANGED: changed ? '1' : '',
                        GIFT_BODY: result.body.length > INLINE_LIMIT ? result.body.slice(0, INLINE_LIMIT) : result.body,
                        GIFT_BODY_BYTES: String(Buffer.byteLength(result.body)),
                        ...match.env(found),
                    },
                    files: { GIFT_BODY_FILE: { data: result.body, suffix: bodySuffix(trigger.url) } },
                });
            } finally {
                polling = false;
            }
        };

        // Staggered by a second each, so ten website hooks are ten requests
        // spread over ten seconds rather than ten at once.
        const startTimer = setTimeout(() => {
            if (stopped) return;
            poll();
            const timer = setInterval(poll, trigger.interval);
            timer.unref?.();
            timers.push(timer);
        }, index * 1000);
        startTimer.unref?.();
        timers.push(startTimer);

        log('info', `polling ${trigger.url}`, {
            hook: hook.name,
            every: `${trigger.interval}ms`,
            on: trigger.on,
        });
    });

    return {
        stop() {
            stopped = true;
            for (const timer of timers) {
                clearInterval(timer);
                clearTimeout(timer);
            }
        },
    };
}

/** So a script that opens GIFT_BODY_FILE gets a name its tools recognise. */
function bodySuffix(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        for (const suffix of ['.json', '.xml', '.txt', '.csv', '.html']) {
            if (pathname.endsWith(suffix)) return suffix;
        }
    } catch {
        /* a URL that will not parse cannot have named a type */
    }
    return '.txt';
}

module.exports = {
    name: 'website',
    title: 'Website',
    summary: 'Poll a URL and run a script when the page changes or matches.',
    prompt: 'a page changes, or starts saying something',
    WHEN,
    DEFAULT_INTERVAL_MS,
    normalize,
    describe,
    line,
    ask,
    afterNotes,
    start,
};
