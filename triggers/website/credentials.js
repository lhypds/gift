// Credentials for a polled page: reading them, and renewing them when they run
// out.
//
// A hook's credentials are a snapshot — an access token pasted out of a
// browser's localStorage into hooks.json. Snapshots go stale, and some go stale
// fast: an access token with a ten-minute life is spent long before the next
// interesting change on the page it guards, so a hook holding one works for ten
// minutes and then logs 401s until somebody pastes another.
//
// The optional `refresh` block is the way out of that. It says which statuses
// mean "the credential has expired", what request asks for a new one, and where
// in the answer the new values are:
//
//     "refresh": {
//         "url": "https://example.com/api/v1/auth/refresh",
//         "on": [401],
//         "body": {
//             "refresh_token": { "from": "localStorage", "key": "auth", "field": "refreshToken" }
//         },
//         "expect": { "code": 0 },
//         "save": {
//             "data.access_token":  { "from": "localStorage", "key": "auth", "field": "accessToken" },
//             "data.refresh_token": { "from": "localStorage", "key": "auth", "field": "refreshToken" }
//         }
//     }
//
// Nothing in here knows what a token is. It moves values named by the config out
// of a JSON answer and into the storage objects the credential headers already
// read, which is enough for the refresh-token exchange every session API spells
// slightly differently.
//
// A renewed credential is written back to hooks.json as well as kept in memory,
// because refresh tokens usually rotate: the one in the file is spent the moment
// it is used, and a restart that read the spent one would have nothing left to
// refresh with. That write is the reason `save` is all-or-nothing below — half a
// rotated credential cannot be recovered from either end.
'use strict';

const STORAGE_NAMES = ['localStorage', 'sessionStorage'];
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DEFAULT_ON = [401];
const DEFAULT_TIMEOUT_MS = 10000;

// ------------------------------------------------------------------ reading ---

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a resolved credential value is worth sending. The placeholder the
 * created template carries is rejected along with the empty string: a request
 * made with 'xxx' is a request that fails in a way nobody reads as "unfilled".
 */
function usable(value) {
    return ['string', 'number', 'boolean'].includes(typeof value)
        && !['', 'xxx'].includes(String(value).trim().toLowerCase());
}

/**
 * Read a dotted field out of a stored value. The value may be the object a
 * browser holds or the JSON string localStorage.getItem() hands back, because
 * both are what a person ends up pasting.
 */
function valueAtField(value, field) {
    let current = value;
    if (field && typeof current === 'string') {
        try {
            current = JSON.parse(current);
        } catch {
            return undefined;
        }
    }
    for (const part of String(field || '').split('.').filter(Boolean)) {
        if (!plainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * The counterpart: put `next` at `field` and give back the whole stored value in
 * the shape it arrived in, so one pasted as a JSON string stays a JSON string
 * and one pasted as an object stays an object. hooks.json is a file somebody
 * hand-edits; a write that reshapes what they wrote is a write they have to
 * re-read.
 *
 * @throws {Error} when the stored value is not something a field can be set on.
 */
function setValueAtField(value, field, next) {
    const parts = String(field || '').split('.').filter(Boolean);
    if (!parts.length) return next;

    const wasText = typeof value === 'string';
    let root = value === undefined ? {} : value;
    if (wasText) {
        try {
            root = JSON.parse(value);
        } catch {
            throw new Error('holds a string that is not JSON');
        }
    }
    if (!plainObject(root)) throw new Error('does not hold a JSON object');

    const copy = structuredClone(root);
    let current = copy;
    for (const part of parts.slice(0, -1)) {
        if (!plainObject(current[part])) current[part] = {};
        current = current[part];
    }
    current[parts[parts.length - 1]] = next;
    return wasText ? JSON.stringify(copy) : copy;
}

/** One { from, key, field } pointer resolved against a credentials object. */
function resolve(credentials, reference) {
    const store = credentials[reference.from];
    return plainObject(store) ? valueAtField(store[reference.key], reference.field) : undefined;
}

// -------------------------------------------------------------- the contract ---

/**
 * `save` and `expect` are written as objects and normalized into arrays of
 * { field, … } — and normalize() is called again on its own output, because the
 * startup log and the dashboard both re-read hooks that have already been
 * through it. Read either shape, so normalizing twice is normalizing once.
 */
function asObject(value, carries) {
    if (!Array.isArray(value)) return value;
    return Object.fromEntries(value.map((entry) => [entry.field, entry[carries]]));
}

/** A { from, key, field } pointer at one stored value, as headers already use. */
function normalizeReference(value, what) {
    if (!plainObject(value) || !STORAGE_NAMES.includes(value.from) || !value.key) {
        throw new Error(`has ${what} that must be a localStorage/sessionStorage reference`);
    }
    return {
        from: value.from,
        key: String(value.key),
        field: value.field === undefined ? '' : String(value.field),
    };
}

/**
 * Fill in a refresh block's defaults and reject the shapes that could never
 * renew anything. Called while hooks.json is read, so a refresh that is written
 * wrong stops the server rather than waiting to fail at the first 401 — which
 * would be ten minutes later, in a log nobody is watching.
 *
 * @throws {Error} with a message that names the field, for `hook '<name>' …`.
 */
function normalizeRefresh(refresh) {
    if (!plainObject(refresh)) throw new Error('has "credentials.refresh" that is not a JSON object');

    if (!refresh.url) throw new Error('has "credentials.refresh" with no "url" to ask');
    let parsed;
    try {
        parsed = new URL(String(refresh.url));
    } catch {
        throw new Error('has a "credentials.refresh.url" that is not a complete URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('has a "credentials.refresh.url" that must use http:// or https://');
    }

    const written = refresh.on === undefined ? DEFAULT_ON : refresh.on;
    if (!Array.isArray(written) || written.length === 0) {
        throw new Error('has a "credentials.refresh.on" that is not a non-empty array of status codes');
    }
    const on = written.map((status) => {
        const code = Number(status);
        if (!Number.isInteger(code) || code < 100 || code > 599) {
            throw new Error(`has "credentials.refresh.on" holding '${status}', which is not an HTTP status`);
        }
        return code;
    });

    const timeout = refresh.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(refresh.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`has a "credentials.refresh.timeout" of ${refresh.timeout} — it must be a number of milliseconds`);
    }

    const body = {};
    const writtenBody = refresh.body === undefined ? {} : refresh.body;
    if (!plainObject(writtenBody)) throw new Error('has a "credentials.refresh.body" that is not a JSON object');
    for (const [name, value] of Object.entries(writtenBody)) {
        body[name] = value === null || typeof value !== 'object'
            ? value
            : normalizeReference(value, `"credentials.refresh.body.${name}"`);
    }

    const headers = {};
    const writtenHeaders = refresh.headers === undefined ? {} : refresh.headers;
    if (!plainObject(writtenHeaders)) throw new Error('has a "credentials.refresh.headers" that is not a JSON object');
    for (const [writtenName, value] of Object.entries(writtenHeaders)) {
        const name = writtenName.toLowerCase();
        if (!HEADER_NAME.test(name)) throw new Error(`has an invalid "credentials.refresh.headers" name '${writtenName}'`);
        if (typeof value === 'string') {
            if (/[\r\n]/.test(value)) throw new Error(`has "credentials.refresh.headers.${writtenName}" with an unsafe value`);
            headers[name] = value;
            continue;
        }
        headers[name] = normalizeReference(value, `"credentials.refresh.headers.${writtenName}"`);
    }

    // What the answer has to say for the refresh to have worked. An API that
    // reports failure as `{"code": 401}` under a 200 is common enough that
    // trusting the status alone would store a credential made of nulls.
    const expect = [];
    if (refresh.expect !== undefined) {
        const written = asObject(refresh.expect, 'value');
        if (!plainObject(written)) throw new Error('has a "credentials.refresh.expect" that is not a JSON object');
        for (const [field, value] of Object.entries(written)) {
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
                throw new Error(`has "credentials.refresh.expect.${field}" that is not a string, number, boolean or null`);
            }
            expect.push({ field: String(field), value });
        }
    }

    const writtenSave = asObject(refresh.save, 'into');
    if (!plainObject(writtenSave) || Object.keys(writtenSave).length === 0) {
        throw new Error('has a "credentials.refresh" with no "save" — a refresh that stores nothing renews nothing');
    }
    const save = Object.entries(writtenSave).map(([field, into]) => ({
        field: String(field),
        into: normalizeReference(into, `"credentials.refresh.save.${field}"`),
    }));

    return {
        url: String(refresh.url),
        method: String(refresh.method || 'POST').toUpperCase(),
        on,
        timeout: Math.round(timeout),
        headers,
        body,
        expect,
        save,
    };
}

// ----------------------------------------------------------------- renewing ---

/**
 * Ask the refresh endpoint for a new credential and put it where the poll's
 * headers will find it, in memory and — through `persist` — in hooks.json.
 *
 * Nothing here logs. The values passing through are the secrets themselves, and
 * the caller is given names to report rather than anything worth redacting.
 *
 * @param {object} credentials a normalized credentials object, mutated in place
 * @param {{persist?: (changes: Array<{storage: string, key: string, value: unknown}>) => unknown,
 *          userAgent?: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{ok: true, persisted: boolean, changed: string[], error?: string}
 *                 | {ok: false, error: string}>}
 */
async function renew(credentials, { persist, userAgent, fetchImpl } = {}) {
    const send = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!send) return { ok: false, error: 'this Node has no fetch — renewing a credential needs Node 18 or newer' };

    const refresh = credentials && credentials.refresh;
    if (!refresh) return { ok: false, error: 'no "refresh" is configured for these credentials' };

    const body = {};
    for (const [name, value] of Object.entries(refresh.body)) {
        if (value === null || typeof value !== 'object') {
            body[name] = value;
            continue;
        }
        const found = resolve(credentials, value);
        if (!usable(found)) return { ok: false, error: `refresh body field ${name} has no value` };
        body[name] = found;
    }

    const headers = {
        'user-agent': userAgent || 'gift',
        accept: 'application/json',
        'content-type': 'application/json',
    };
    for (const [name, spec] of Object.entries(refresh.headers)) {
        const value = typeof spec === 'string' ? spec : resolve(credentials, spec);
        if (!usable(value)) return { ok: false, error: `refresh header ${name} has no value` };
        const text = String(value);
        if (/[\r\n]/.test(text)) return { ok: false, error: `refresh header ${name} has an unsafe value` };
        headers[name] = text;
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), refresh.timeout);
    let response;
    let text;
    try {
        response = await send(refresh.url, {
            method: refresh.method,
            headers,
            body: ['GET', 'HEAD'].includes(refresh.method) ? undefined : JSON.stringify(body),
            // Unlike a poll, a refresh is not followed anywhere: the request
            // carries the long-lived token in its body, and a redirect is an
            // invitation to hand that to whoever answered.
            redirect: 'error',
            signal: controller.signal,
        });
        text = await response.text();
    } catch (err) {
        const aborted = err.name === 'AbortError' || err.name === 'TimeoutError';
        return { ok: false, error: aborted ? `no answer within ${refresh.timeout} ms` : err.message || String(err) };
    } finally {
        clearTimeout(deadline);
    }

    if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `the refresh endpoint answered ${response.status}` };
    }

    let answer;
    try {
        answer = JSON.parse(text);
    } catch {
        return { ok: false, error: 'the refresh endpoint answered with something that is not JSON' };
    }

    for (const check of refresh.expect) {
        const found = valueAtField(answer, check.field);
        if (found !== check.value) {
            return {
                ok: false,
                error: `the refresh endpoint answered with ${check.field} ${JSON.stringify(found) ?? 'missing'}`
                    + `, not ${JSON.stringify(check.value)}`,
            };
        }
    }

    // Everything, or nothing. A rotated refresh token that is stored while its
    // partner is dropped leaves the hook holding half a credential and no way
    // back to a whole one, so the answer is read in full before anything moves.
    const writes = [];
    for (const entry of refresh.save) {
        const value = valueAtField(answer, entry.field);
        if (!usable(value)) return { ok: false, error: `the refresh endpoint answered with nothing at ${entry.field}` };
        writes.push({ into: entry.into, value });
    }

    // Two saved fields often land in one stored value — an access token and the
    // refresh token beside it — so the writes are folded together before either
    // is applied, rather than each one rebuilding what the last one wrote.
    const touched = new Map();
    for (const { into, value } of writes) {
        const id = `${into.from} ${into.key}`;
        const current = touched.has(id) ? touched.get(id).value : credentials[into.from][into.key];
        let next;
        try {
            next = setValueAtField(current, into.field, value);
        } catch (err) {
            return { ok: false, error: `credentials.${into.from}.${into.key} ${err.message}` };
        }
        touched.set(id, { storage: into.from, key: into.key, value: next });
    }

    const changes = [...touched.values()];
    for (const change of changes) credentials[change.storage][change.key] = change.value;
    const changed = changes.map((change) => `${change.storage}.${change.key}`);

    if (typeof persist !== 'function') return { ok: true, persisted: false, changed };
    try {
        await persist(changes);
    } catch (err) {
        // The credential is good and in memory; only its home on disk is stale.
        // Worth saying loudly, because the token written there is now spent.
        return { ok: true, persisted: false, changed, error: err.message || String(err) };
    }
    return { ok: true, persisted: true, changed };
}

module.exports = {
    STORAGE_NAMES,
    HEADER_NAME,
    DEFAULT_ON,
    DEFAULT_TIMEOUT_MS,
    plainObject,
    usable,
    valueAtField,
    setValueAtField,
    resolve,
    normalizeReference,
    normalizeRefresh,
    renew,
};
