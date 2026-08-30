// What a renewal must get right, and what it must refuse to do halfway.
//
//     node --test triggers/website/
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    setValueAtField,
    valueAtField,
    normalizeRefresh,
    renew,
} = require('./credentials.js');
const website = require('./index.js');

/** A fetch that answers once with the given status and JSON, and records the call. */
function stubFetch(status, answer, calls = []) {
    return async (url, init) => {
        calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
        return {
            status,
            text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)),
        };
    };
}

function credentials({ store = { accessToken: 'old-access', refreshToken: 'old-refresh' } } = {}) {
    return {
        localStorage: { auth: store },
        sessionStorage: {},
        cookies: {},
        headers: { 'x-auth': { from: 'localStorage', key: 'auth', field: 'accessToken' } },
        refresh: normalizeRefresh({
            url: 'https://example.com/api/v1/auth/refresh',
            body: { refresh_token: { from: 'localStorage', key: 'auth', field: 'refreshToken' } },
            expect: { code: 0 },
            save: {
                'data.access_token': { from: 'localStorage', key: 'auth', field: 'accessToken' },
                'data.refresh_token': { from: 'localStorage', key: 'auth', field: 'refreshToken' },
            },
        }),
    };
}

const GOOD = { code: 0, data: { access_token: 'new-access', refresh_token: 'new-refresh' } };

// ------------------------------------------------------------------- fields ---

test('setValueAtField keeps an object an object', () => {
    const next = setValueAtField({ a: 1, b: 2 }, 'b', 3);
    assert.deepStrictEqual(next, { a: 1, b: 3 });
});

test('setValueAtField keeps a pasted JSON string a JSON string', () => {
    const next = setValueAtField('{"a":1,"b":2}', 'b', 3);
    assert.strictEqual(typeof next, 'string');
    assert.deepStrictEqual(JSON.parse(next), { a: 1, b: 3 });
});

test('setValueAtField reaches through dots, and round-trips with valueAtField', () => {
    const next = setValueAtField({ outer: { inner: 'old' } }, 'outer.inner', 'new');
    assert.strictEqual(valueAtField(next, 'outer.inner'), 'new');
});

test('setValueAtField with no field replaces the whole value', () => {
    assert.strictEqual(setValueAtField({ a: 1 }, '', 'plain'), 'plain');
});

test('setValueAtField refuses a stored value it cannot set a field on', () => {
    assert.throws(() => setValueAtField('not json', 'a', 1), /not JSON/);
    assert.throws(() => setValueAtField(42, 'a', 1), /not hold a JSON object/);
});

// ----------------------------------------------------------------- contract ---

test('normalizeRefresh fills in the defaults', () => {
    const refresh = normalizeRefresh({
        url: 'https://example.com/refresh',
        save: { token: { from: 'localStorage', key: 'auth', field: 'accessToken' } },
    });
    assert.strictEqual(refresh.method, 'POST');
    assert.deepStrictEqual(refresh.on, [401]);
    assert.strictEqual(refresh.timeout, 10000);
    assert.deepStrictEqual(refresh.expect, []);
});

test('normalizeRefresh refuses a refresh that stores nothing', () => {
    assert.throws(
        () => normalizeRefresh({ url: 'https://example.com/refresh' }),
        /no "save"/,
    );
});

test('normalizeRefresh refuses a url that is not one, and a status that is not one', () => {
    const save = { token: { from: 'localStorage', key: 'auth', field: 'accessToken' } };
    assert.throws(() => normalizeRefresh({ url: 'example.com', save }), /complete URL/);
    assert.throws(() => normalizeRefresh({ url: 'ftp://example.com', save }), /http:\/\/ or https:\/\//);
    assert.throws(() => normalizeRefresh({ url: 'https://example.com', on: [99], save }), /not an HTTP status/);
    assert.throws(() => normalizeRefresh({ url: 'https://example.com', on: [], save }), /non-empty array/);
});

test('normalizeCredentials refuses a refresh body pointing at a key nobody pasted', () => {
    assert.throws(
        () => website.normalizeCredentials({
            localStorage: { auth: { refreshToken: 'r' } },
            headers: { 'x-auth': { from: 'localStorage', key: 'auth', field: 'accessToken' } },
            refresh: {
                url: 'https://example.com/refresh',
                body: { refresh_token: { from: 'localStorage', key: 'typo', field: 'refreshToken' } },
                save: { 'data.access_token': { from: 'localStorage', key: 'auth', field: 'accessToken' } },
            },
        }),
        /pointing at localStorage 'typo'/,
    );
});

test('normalizing twice is normalizing once', () => {
    // The startup log and the dashboard both call normalize() on hooks that have
    // already been through it, and report "(not configured)" for anything that
    // throws the second time.
    const written = {
        localStorage: { auth: { accessToken: 'a', refreshToken: 'r' } },
        headers: { 'x-auth': { from: 'localStorage', key: 'auth', field: 'accessToken' } },
        refresh: {
            url: 'https://example.com/refresh',
            body: { refresh_token: { from: 'localStorage', key: 'auth', field: 'refreshToken' } },
            expect: { code: 0 },
            save: { 'data.access_token': { from: 'localStorage', key: 'auth', field: 'accessToken' } },
        },
    };
    const once = website.normalizeCredentials(written);
    assert.deepStrictEqual(website.normalizeCredentials(once), once);
});

test('normalizing twice is normalizing once without a refresh', () => {
    const once = website.normalizeCredentials({
        localStorage: { auth: { accessToken: 'a' } },
        headers: { 'x-auth': { from: 'localStorage', key: 'auth', field: 'accessToken' } },
    });
    assert.strictEqual(once.refresh, null);
    assert.deepStrictEqual(website.normalizeCredentials(once), once);
});

// ----------------------------------------------------------------- renewing ---

test('renew sends the refresh token and stores what comes back', async () => {
    const calls = [];
    const creds = credentials();
    const saved = [];

    const result = await renew(creds, {
        fetchImpl: stubFetch(200, GOOD, calls),
        persist: (changes) => saved.push(...changes),
    });

    assert.deepStrictEqual(result, {
        ok: true,
        persisted: true,
        changed: ['localStorage.auth'],
    });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].body, { refresh_token: 'old-refresh' });
    assert.strictEqual(calls[0].init.method, 'POST');
    // A refresh carries the long-lived token; it must not be handed to whoever
    // answers a redirect.
    assert.strictEqual(calls[0].init.redirect, 'error');

    assert.deepStrictEqual(creds.localStorage.auth, {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
    });
    // Both saved fields land in one stored value, written once.
    assert.strictEqual(saved.length, 1);
    assert.deepStrictEqual(saved[0].value, { accessToken: 'new-access', refreshToken: 'new-refresh' });
});

test('renew writes into a stored value pasted as a JSON string, and leaves it one', async () => {
    const creds = credentials({ store: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh' }) });

    const result = await renew(creds, { fetchImpl: stubFetch(200, GOOD) });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(typeof creds.localStorage.auth, 'string');
    assert.deepStrictEqual(JSON.parse(creds.localStorage.auth), {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
    });
});

test('renew refuses an answer that fails its expect, and changes nothing', async () => {
    const creds = credentials();
    const result = await renew(creds, {
        fetchImpl: stubFetch(200, { code: 401, message: 'refresh token expired' }),
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /answered with code 401, not 0/);
    assert.strictEqual(creds.localStorage.auth.accessToken, 'old-access');
    assert.strictEqual(creds.localStorage.auth.refreshToken, 'old-refresh');
});

test('renew writes nothing when only half the answer is there', async () => {
    const creds = credentials();
    const result = await renew(creds, {
        fetchImpl: stubFetch(200, { code: 0, data: { access_token: 'new-access' } }),
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /nothing at data\.refresh_token/);
    // The half that did arrive must not have been stored: a rotated credential
    // written in pieces cannot be put back together.
    assert.strictEqual(creds.localStorage.auth.accessToken, 'old-access');
});

test('renew reports a non-2xx and a body that is not JSON', async () => {
    assert.match(
        (await renew(credentials(), { fetchImpl: stubFetch(503, '') })).error,
        /answered 503/,
    );
    assert.match(
        (await renew(credentials(), { fetchImpl: stubFetch(200, '<html>nope</html>') })).error,
        /not JSON/,
    );
});

test('renew keeps the new credential in memory when it cannot be saved', async () => {
    const creds = credentials();
    const result = await renew(creds, {
        fetchImpl: stubFetch(200, GOOD),
        persist: () => { throw new Error('hooks.json is read-only'); },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.persisted, false);
    assert.match(result.error, /read-only/);
    assert.strictEqual(creds.localStorage.auth.accessToken, 'new-access');
});

test('renew refuses to ask when the refresh token itself is missing', async () => {
    const creds = credentials({ store: { accessToken: 'old-access', refreshToken: '' } });
    let asked = false;

    const result = await renew(creds, { fetchImpl: async () => { asked = true; } });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /refresh body field refresh_token has no value/);
    assert.strictEqual(asked, false);
});
