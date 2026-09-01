// The website trigger — poll a URL and run a command when the answer is
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
// safeHookName is shared rather than repeated: it decides the folder a hook's
// responses are saved in, and the folder its error log is opened in. Two copies
// that drifted would put the pair in two different places.
const { forTrigger, logHook, safeHookName } = require('../../utils/log.js');
const { INLINE_LIMIT } = require('../runtime.js');
const match = require('../match.js');
const { fetchPage } = require('./poll.js');
const {
    STORAGE_NAMES,
    HEADER_NAME,
    plainObject,
    usable,
    valueAtField,
    normalizeRefresh,
    renew,
} = require('./credentials.js');

const log = forTrigger('website');

const DEFAULT_INTERVAL_MS = 60000;
const MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const WHEN = ['change', 'match', 'always'];
const DEFAULT_RESPONSE_LOG_DIR = path.join(ROOT, 'logs', 'hooks');
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

    const credentials = trigger.credentials === undefined ? null : normalizeCredentials(trigger.credentials);

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
        credentials,
        // Keeping the latest response is the normal website-hook behavior.
        // An explicit false is the manual opt-out.
        saveLastResponse: trigger.saveLastResponse !== false,
    };
}

const FIRES = {
    change: 'when the page comes back different',
    match: 'every poll the page matches',
    always: 'every poll',
};

// Why the poll that fired, fired — the second half of a `fired` line in the
// hook's own hook.log.
const FIRED_BECAUSE = {
    change: 'the page came back different',
    match: 'the page matches',
    always: 'every poll fires this hook',
};

function describe(trigger) {
    const rows = [
        ['url', `${trigger.method === 'GET' ? '' : `${trigger.method} `}${trigger.url}`],
        ['fires', FIRES[trigger.on]],
    ];
    if (trigger.matchType !== 'any') rows.push(['match', match.describe(trigger)]);
    if (trigger.credentials) {
        rows.push(['credentials', trigger.credentials.refresh
            ? `stored privately in hooks.json, renewed on ${trigger.credentials.refresh.on.join(', ')}`
            : 'stored privately in hooks.json']);
    }
    if (trigger.saveLastResponse) rows.push(['response', 'save latest under logs/hooks/<hook name>']);
    rows.push(['polled', `every ${trigger.interval} ms`]);
    return rows;
}

function line(trigger) {
    return `${trigger.url}  on ${trigger.on}`;
}

async function ask({ askText, askYesNo }) {
    console.log('The page is fetched on a timer; what comes back decides whether the command runs.');
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

    const useCredentials = await askYesNo('Use credentials for this website?', false);
    if (useCredentials === null) return null;
    if (useCredentials) {
        console.log('  A credential template will be added to hooks.json.');
        console.log('  Finish creating the hook, then edit its localStorage, sessionStorage, cookies and headers manually.');
    }

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
            credentials: useCredentials ? credentialTemplate() : undefined,
            saveLastResponse: true,
        },
        label: url,
        name: siteName(url),
    };
}

/**
 * What to call a hook that watches this URL: hook-hub.example.com. The site,
 * not the last part of the path — half the pages worth polling are called
 * /status or /api/v1/state, and a name out of those says nothing about which
 * service is being watched. The path is also the part most likely to be edited
 * later, and a hook named after it would then be named after nothing.
 */
function siteName(url) {
    try {
        // `www.` is not which site this is, only how it was typed.
        return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
        // ask() validated the URL, so this is unreachable from there; a caller
        // that passes something else falls back to the general rule.
        return '';
    }
}

function afterNotes(hook, context = {}) {
    const trigger = hook && hook.trigger ? hook.trigger : {};
    const notes = [];
    if (trigger.saveLastResponse) {
        notes.push(
            `Latest responses will replace ${path.join(DEFAULT_RESPONSE_LOG_DIR, safeHookName(hook.name), 'last_response.*')}.`,
        );
    }
    if (trigger.credentials) {
        const file = context.file && context.show ? context.show(context.file) : 'hooks.json';
        notes.push(
            `Credentials are enabled but still empty — edit ${file} manually before relying on this hook.`,
            'Fill the localStorage, sessionStorage, cookies and headers entries, then run `gift restart`.',
        );
    }
    return notes;
}

// ---------------------------------------------------------- auth / response ---

function credentialTemplate() {
    return {
        localStorage: { sample_auth_store: { accessToken: 'xxx' } },
        sessionStorage: {},
        cookies: {},
        headers: {
            'x-sample-authorization': {
                from: 'localStorage',
                key: 'sample_auth_store',
                field: 'accessToken',
            },
        },
    };
}

function normalizeCredentials(credentials) {
    if (!plainObject(credentials)) throw new Error('has "credentials" that is not a JSON object');

    const normalized = {};
    for (const name of [...STORAGE_NAMES, 'cookies', 'headers']) {
        const value = credentials[name] === undefined ? {} : credentials[name];
        if (!plainObject(value)) throw new Error(`has "credentials.${name}" that is not a JSON object`);
        normalized[name] = { ...value };
    }

    for (const [name, value] of Object.entries(normalized.cookies)) {
        if (!HEADER_NAME.test(name)) throw new Error(`has an invalid cookie name '${name}'`);
        if (typeof value !== 'string') throw new Error(`has a cookie '${name}' whose value is not a string`);
        if (/[\r\n;]/.test(value)) throw new Error(`has a cookie '${name}' with an unsafe value`);
    }

    const headers = {};
    for (const [writtenName, value] of Object.entries(normalized.headers)) {
        const name = writtenName.toLowerCase();
        if (!HEADER_NAME.test(name)) throw new Error(`has an invalid credential header name '${writtenName}'`);
        if (typeof value === 'string') {
            if (/[\r\n]/.test(value)) throw new Error(`has credential header '${writtenName}' with an unsafe value`);
            headers[name] = value;
            continue;
        }
        if (!plainObject(value) || !STORAGE_NAMES.includes(value.from) || !value.key) {
            throw new Error(`has credential header '${writtenName}' that must be a string or a localStorage/sessionStorage reference`);
        }
        headers[name] = {
            from: value.from,
            key: String(value.key),
            field: value.field === undefined ? '' : String(value.field),
        };
    }
    if (Object.keys(normalized.cookies).length && headers.cookie !== undefined) {
        throw new Error('sets both "credentials.cookies" and a credential Cookie header');
    }
    normalized.headers = headers;

    // Optional, and the difference between a hook that works for as long as the
    // pasted token lives and one that keeps working. See credentials.js.
    // `== null` rather than `=== undefined`: normalize() is called again on its
    // own output, where an absent refresh has already become null.
    normalized.refresh = credentials.refresh == null ? null : normalizeRefresh(credentials.refresh);
    if (normalized.refresh) {
        // The refresh token has to already be somewhere in the file — a body
        // pointing at a key nobody pasted is the typo worth catching at startup
        // rather than at the first 401, ten minutes into a log nobody is reading.
        for (const [name, value] of Object.entries(normalized.refresh.body)) {
            if (!plainObject(value)) continue;
            if (normalized[value.from][value.key] === undefined) {
                throw new Error(
                    `has "credentials.refresh.body.${name}" pointing at ${value.from} '${value.key}',`
                    + ` which is not in "credentials.${value.from}"`,
                );
            }
        }
    }
    return normalized;
}

/** Resolve static strings and storage references without ever logging their values. */
function credentialHeaders(trigger) {
    if (!trigger.credentials) return { ok: true, headers: {} };

    const credentials = trigger.credentials;
    const headers = {};
    for (const [name, spec] of Object.entries(credentials.headers)) {
        const value = typeof spec === 'string'
            ? spec
            : valueAtField(credentials[spec.from][spec.key], spec.field);
        if (!usable(value)) return { ok: false, error: `credential header ${name} has no value` };
        const text = String(value);
        if (/[\r\n]/.test(text)) return { ok: false, error: `credential header ${name} has an unsafe value` };
        headers[name] = text;
    }

    const cookies = Object.entries(credentials.cookies).map(([name, value]) => `${name}=${value}`);
    if (cookies.length) headers.cookie = cookies.join('; ');
    if (Object.keys(headers).length === 0) {
        return { ok: false, error: 'credentials are enabled but no headers or cookies are filled in' };
    }
    return { ok: true, headers };
}

/**
 * Write renewed credential values back into hooks.json, so a refresh token that
 * rotated is the one the next start reads rather than the spent one it replaced.
 *
 * The file is read fresh instead of remembered: `gift create` and `gift delete`
 * write it too, and a renewal happens whenever a token happens to expire, which
 * may be hours after the copy in memory was loaded. Only the stored values that
 * changed are touched, so an edit made in the meantime survives.
 */
function persistCredentials(configFile, hookName, changes) {
    if (!configFile) throw new Error('there is no hooks.json to write to');
    // Required here rather than at the top of the file: utils/hooks.js reaches
    // back through triggers/index.js to this module, and a cycle resolved at
    // load time would leave one of the two half-built. By the time a poll runs,
    // both are finished.
    const { writeConfig } = require('../../utils/hooks.js');

    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    const entry = hooks.find((hook, index) => (hook && hook.name ? hook.name : `hook-${index + 1}`) === hookName);
    if (!entry) throw new Error(`hook '${hookName}' is no longer in the file`);

    const credentials = entry.trigger && entry.trigger.credentials;
    if (!plainObject(credentials)) throw new Error(`hook '${hookName}' no longer has credentials`);

    for (const change of changes) {
        if (!plainObject(credentials[change.storage])) credentials[change.storage] = {};
        credentials[change.storage][change.key] = change.value;
    }
    writeConfig(configFile, config);
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
        // The reason the last poll did not work, so that an hour of a host that
        // will not resolve is one line in the hook's error log rather than sixty.
        let failure = '';

        const refresh = trigger.credentials && trigger.credentials.refresh;

        /**
         * One line in this hook's hook.log, for the poll that just finished:
         * when it asked, and whether it ran the script. Every poll writes one,
         * including the ordinary ones that changed nothing — a file of those is
         * how "this hook is still asking" is checked without a running terminal.
         */
        const record = (outcome, message, fields = {}) => {
            logHook(hook.name, outcome, message, { url: trigger.url, ...fields });
        };

        /**
         * A poll that did not work. The first one, and any change of reason, is
         * an error — a hook that cannot reach its URL is not doing its job, and
         * that belongs in the hook's error.log. While the same thing keeps
         * happening it drops to a warning: repeating it into the error log once
         * a minute would bury the next real problem under an old one.
         *
         * hook.log takes every one of them, at full volume: there the point is
         * that no poll is missing from the sequence, and each line is one line.
         */
        const trouble = (message, fields = {}) => {
            const first = message !== failure;
            failure = message;
            log(first ? 'error' : 'warn', message, { hook: hook.name, ...fields });
            record('failed', message);
        };

        /** A poll that worked after one that did not. */
        const recovered = () => {
            if (!failure) return;
            log('info', 'polling again', { hook: hook.name, url: trigger.url });
            failure = '';
        };

        /** Renew the credential, say so, and answer whether the poll can go on. */
        const tryRenew = async (why) => {
            const renewed = await renew(trigger.credentials, {
                userAgent: process.env.GIFT_WEBSITE_USER_AGENT || options.userAgent,
                persist: (changes) => persistCredentials(options.configFile, hook.name, changes),
            });
            if (stopped) return false;
            if (!renewed.ok) {
                trouble(`poll skipped: ${why} and could not be renewed — ${renewed.error}`, { url: trigger.url });
                return false;
            }
            if (renewed.persisted) {
                log('info', `credential renewed: ${renewed.changed.join(', ')}`, { hook: hook.name });
            } else {
                // An error rather than a note: the token still in the file has
                // been spent, so a restart before the next successful write is
                // a restart with nothing left to refresh with.
                log('error', `credential renewed but not saved: ${renewed.error}`, {
                    hook: hook.name, hint: 'the new credential is lost when the server restarts',
                });
            }
            return true;
        };

        const poll = async () => {
            if (polling || stopped) return;
            polling = true;
            try {
                let credentials = credentialHeaders(trigger);
                if (!credentials.ok) {
                    // With a refresh configured, an empty access token is not a
                    // hook somebody forgot to fill in — it is one whose token has
                    // already been spent. Ask for another rather than skipping
                    // every poll from here to the next manual paste.
                    if (!refresh) {
                        trouble(`poll skipped: ${credentials.error}`, { url: trigger.url });
                        return;
                    }
                    if (!await tryRenew(credentials.error)) return;
                    credentials = credentialHeaders(trigger);
                    if (!credentials.ok) {
                        trouble(`poll skipped: ${credentials.error}`, { url: trigger.url });
                        return;
                    }
                }

                const fetchOnce = (headers) => fetchPage(trigger.url, {
                    method: trigger.method,
                    timeout: trigger.timeout,
                    userAgent: process.env.GIFT_WEBSITE_USER_AGENT || options.userAgent,
                    headers,
                });

                let result = await fetchOnce(credentials.headers);
                if (stopped) return;

                // A credential that expired between polls is the ordinary life of
                // a short-lived token, not news: renew it and ask again, and let
                // the second answer be the one the hook sees. Without this the
                // 401 itself would read as the page having changed.
                if (result.ok && refresh && refresh.on.includes(result.status)) {
                    if (!await tryRenew(`the page answered ${result.status}`)) return;
                    const renewed = credentialHeaders(trigger);
                    if (!renewed.ok) {
                        trouble(`poll skipped: ${renewed.error}`, { url: trigger.url });
                        return;
                    }
                    result = await fetchOnce(renewed.headers);
                    if (stopped) return;
                    if (result.ok && refresh.on.includes(result.status)) {
                        // A fresh credential the page still refuses is a broken
                        // hook, not a changed page. Firing a script on it would
                        // run a deploy over an authentication problem.
                        trouble(
                            `poll skipped: the page still answered ${result.status} with a renewed credential`,
                            { url: trigger.url },
                        );
                        return;
                    }
                }

                if (!result.ok) {
                    // Recorded, never fired on: a hook cannot tell "the site is
                    // down" from "this machine's DNS is down", and running a
                    // deploy script over the second is worse than missing the
                    // first. Not firing is not the same as not saying so, though
                    // — a hook that has stopped reaching its URL is broken, and
                    // the first poll to fail says that in the hook's error.log.
                    trouble(`poll failed: ${result.error}`, { url: trigger.url });
                    return;
                }

                recovered();

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
                            log('error', `cannot save latest response: ${message}`, { hook: hook.name });
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

                const seen = { status: result.status, ms: result.ms };

                const found = match.test(result.body, trigger);
                if (trigger.matchType !== 'any' && !found) {
                    record('quiet', 'the page does not match', seen);
                    return;
                }

                const fires = trigger.on === 'always'
                    || (trigger.on === 'match' && found)
                    || (trigger.on === 'change' && changed);
                if (!fires) {
                    // Only `change` reaches here: `always` fires on every poll,
                    // and `match` has already returned above when it did not match.
                    if (first) {
                        log('info', 'first poll — nothing to compare against yet', {
                            hook: hook.name, url: trigger.url, status: result.status,
                        });
                    }
                    record('quiet', first ? 'first poll, nothing to compare against yet' : 'the page has not changed', seen);
                    return;
                }

                record('fired', FIRED_BECAUSE[trigger.on], seen);

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
            credentials: trigger.credentials
                ? (refresh ? `hooks.json, renewed on ${refresh.on.join('/')}` : 'hooks.json')
                : undefined,
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
    summary: 'Poll a URL and run a command when the page changes or matches.',
    prompt: 'a page changes, or starts saying something',
    WHEN,
    DEFAULT_INTERVAL_MS,
    DEFAULT_RESPONSE_LOG_DIR,
    normalize,
    describe,
    line,
    ask,
    afterNotes,
    credentialTemplate,
    normalizeCredentials,
    credentialHeaders,
    persistCredentials,
    contentSuffix,
    safeHookName,
    saveLastResponse,
    siteName,
    start,
};
