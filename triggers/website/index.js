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

const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../../functions.js');
const { forTrigger } = require('../../utils/log.js');
const { INLINE_LIMIT } = require('../runtime.js');
const match = require('../match.js');
const { fetchPage } = require('./poll.js');

const log = forTrigger('website');

const DEFAULT_INTERVAL_MS = 60000;
const MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const WHEN = ['change', 'match', 'always'];
const DEFAULT_AUTH_STATE_ENV = 'ER_AUTH_STATE_STORE';
const DEFAULT_AUTH_TOKEN_FIELD = 'accessToken';
const DEFAULT_AUTH_HEADER = 'x-even-authorization';
const DEFAULT_RESPONSE_LOG_DIR = path.join(ROOT, 'logs', 'hooks');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESPONSE_SUFFIXES = ['.json', '.xml', '.txt', '.csv', '.html'];
let responseWriteCounter = 0;

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

    const authStateEnv = trigger.authStateEnv ? String(trigger.authStateEnv).trim() : '';
    if (authStateEnv && !ENV_NAME.test(authStateEnv)) {
        throw new Error(`has an "authStateEnv" of '${trigger.authStateEnv}' — use an environment-variable name such as ${DEFAULT_AUTH_STATE_ENV}`);
    }
    if (!authStateEnv && (trigger.authTokenField || trigger.authHeader)) {
        throw new Error('sets an auth token field or header but has no "authStateEnv"');
    }

    const authTokenField = String(trigger.authTokenField || DEFAULT_AUTH_TOKEN_FIELD).trim();
    if (authStateEnv && !authTokenField) throw new Error('has an empty "authTokenField"');

    const authHeader = String(trigger.authHeader || DEFAULT_AUTH_HEADER).trim().toLowerCase();
    if (authStateEnv && !HEADER_NAME.test(authHeader)) {
        throw new Error(`has an "authHeader" of '${trigger.authHeader}' — it is not a valid HTTP header name`);
    }

    if (trigger.saveLastResponse !== undefined && typeof trigger.saveLastResponse !== 'boolean') {
        throw new Error('has a "saveLastResponse" that is not true or false');
    }

    return {
        url: String(trigger.url),
        method: String(trigger.method || 'GET').toUpperCase(),
        on,
        ...spec,
        interval: Math.round(interval),
        timeout: Math.round(timeout),
        authStateEnv,
        authTokenField,
        authHeader,
        saveLastResponse: trigger.saveLastResponse === true,
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
    if (trigger.authStateEnv) {
        rows.push(['auth', `${trigger.authTokenField} from ${trigger.authStateEnv} → ${trigger.authHeader}`]);
    }
    if (trigger.saveLastResponse) rows.push(['response', 'save latest under logs/hooks/<hook name>']);
    rows.push(['polled', `every ${trigger.interval} ms`]);
    return rows;
}

function line(trigger) {
    return `${trigger.url}  on ${trigger.on}`;
}

async function ask({ askText, askYesNo }) {
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

    const useAuth = await askYesNo(
        `Send ${DEFAULT_AUTH_TOKEN_FIELD} from auth-state JSON as ${DEFAULT_AUTH_HEADER}?`,
        false,
    );
    if (useAuth === null) return null;

    let auth = {};
    if (useAuth) {
        const authStateEnv = await askText('Environment variable containing the localStorage auth-state JSON', {
            fallback: DEFAULT_AUTH_STATE_ENV,
            validate: (value) => (ENV_NAME.test(value) ? null : 'Type a valid environment-variable name.'),
        });
        if (authStateEnv === null) return null;

        const authTokenField = await askText('Property holding the access token', {
            fallback: DEFAULT_AUTH_TOKEN_FIELD,
            validate: (value) => (value ? null : 'A token property is needed.'),
        });
        if (authTokenField === null) return null;

        const authHeader = await askText('Request header to receive the token', {
            fallback: DEFAULT_AUTH_HEADER,
            validate: (value) => (HEADER_NAME.test(value) ? null : 'Type a valid HTTP header name.'),
        });
        if (authHeader === null) return null;

        auth = { authStateEnv, authTokenField, authHeader: authHeader.toLowerCase() };
    }

    const saveLastResponse = await askYesNo(
        'Save every latest successful response under logs/hooks/<hook name>?',
        false,
    );
    if (saveLastResponse === null) return null;

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
            ...auth,
            saveLastResponse,
        },
        label: url,
    };
}

function afterNotes(hook) {
    const trigger = hook && hook.trigger ? hook.trigger : {};
    const notes = [];
    if (trigger.saveLastResponse) {
        notes.push(
            `Latest responses will replace ${path.join(DEFAULT_RESPONSE_LOG_DIR, safeHookName(hook.name), 'last_response.*')}.`,
        );
    }
    if (!trigger.authStateEnv) return notes;

    const auth = authHeaders(trigger);
    if (!auth.ok) {
        notes.push(
            `warning: ${auth.error}.`,
            `         Put the JSON value copied from localStorage in ${trigger.authStateEnv}; the token is never written to hooks.json or the log.`,
        );
    }
    notes.push(`note: ${trigger.authStateEnv} is loaded when gift starts; restart gift after replacing a rotated token.`);
    return notes;
}

// ---------------------------------------------------------- auth / response ---

/** Build the one secret header without ever returning or logging the auth state. */
function authHeaders(trigger, env = process.env) {
    if (!trigger.authStateEnv) return { ok: true, headers: {} };

    const raw = env[trigger.authStateEnv];
    if (!raw) return { ok: false, error: `${trigger.authStateEnv} is not set` };

    let state;
    try {
        state = JSON.parse(raw);
    } catch {
        return { ok: false, error: `${trigger.authStateEnv} does not contain valid JSON` };
    }

    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return { ok: false, error: `${trigger.authStateEnv} does not contain a JSON object` };
    }

    const token = state[trigger.authTokenField];
    if (typeof token !== 'string' || !token.trim()) {
        return { ok: false, error: `${trigger.authStateEnv} has no non-empty ${trigger.authTokenField}` };
    }
    if (/[\r\n]/.test(token)) {
        return { ok: false, error: `${trigger.authStateEnv}.${trigger.authTokenField} is not a safe HTTP header value` };
    }

    return { ok: true, headers: { [trigger.authHeader]: token } };
}

function contentSuffix(url, contentType = '') {
    const mime = String(contentType).split(';', 1)[0].trim().toLowerCase();
    if (mime === 'application/json' || mime.endsWith('+json')) return '.json';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return '.html';
    if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return '.xml';
    if (mime === 'text/csv' || mime === 'application/csv') return '.csv';
    if (mime === 'text/plain') return '.txt';
    return bodySuffix(url);
}

function safeHookName(name) {
    return String(name || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

/** Replace the prior response atomically and keep exactly one recognised suffix. */
function saveLastResponse(root, hookName, url, result) {
    const folder = path.join(root, safeHookName(hookName));
    const target = path.join(folder, `last_response${contentSuffix(url, result.contentType)}`);
    const temp = `${target}.tmp-${process.pid}-${(responseWriteCounter++).toString(36)}`;

    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    try {
        fs.writeFileSync(temp, result.body, { mode: 0o600 });
        fs.renameSync(temp, target);
        for (const suffix of RESPONSE_SUFFIXES) {
            const previous = path.join(folder, `last_response${suffix}`);
            if (previous === target) continue;
            try {
                fs.unlinkSync(previous);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        }
        return target;
    } catch (err) {
        try {
            fs.unlinkSync(temp);
        } catch {
            /* the rename may already have consumed it */
        }
        throw err;
    }
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
        let saveError = '';

        const poll = async () => {
            if (polling || stopped) return;
            polling = true;
            try {
                const auth = authHeaders(trigger);
                if (!auth.ok) {
                    log('warn', `poll skipped: ${auth.error}`, { hook: hook.name, url: trigger.url });
                    return;
                }

                const result = await fetchPage(trigger.url, {
                    method: trigger.method,
                    timeout: trigger.timeout,
                    userAgent: process.env.GIFT_WEBSITE_USER_AGENT || options.userAgent,
                    headers: auth.headers,
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

                if (trigger.saveLastResponse) {
                    try {
                        const saved = saveLastResponse(
                            options.responseLogDir || DEFAULT_RESPONSE_LOG_DIR,
                            hook.name,
                            trigger.url,
                            result,
                        );
                        if (saveError) {
                            log('info', 'saving the latest response again', { hook: hook.name, file: saved });
                            saveError = '';
                        }
                    } catch (err) {
                        const message = err && err.message ? err.message : String(err);
                        if (message !== saveError) {
                            log('warn', `cannot save latest response: ${message}`, { hook: hook.name });
                            saveError = message;
                        }
                    }
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
            auth: trigger.authStateEnv ? `${trigger.authStateEnv} → ${trigger.authHeader}` : undefined,
            saves: trigger.saveLastResponse
                ? path.join(options.responseLogDir || DEFAULT_RESPONSE_LOG_DIR, safeHookName(hook.name))
                : undefined,
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
    DEFAULT_AUTH_STATE_ENV,
    DEFAULT_AUTH_TOKEN_FIELD,
    DEFAULT_AUTH_HEADER,
    DEFAULT_RESPONSE_LOG_DIR,
    normalize,
    describe,
    line,
    ask,
    afterNotes,
    authHeaders,
    contentSuffix,
    safeHookName,
    saveLastResponse,
    start,
};
