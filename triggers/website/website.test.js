'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const config = require('../../utils/config.js');
const website = require('./index.js');
const { fetchPage } = require('./poll.js');

test('authHeaders extracts only the configured token into the configured header', () => {
    const trigger = website.normalize({
        url: 'https://example.com/private',
        authStateEnv: 'TEST_AUTH_STATE',
        authTokenField: 'accessToken',
        authHeader: 'x-even-authorization',
    });
    const result = website.authHeaders(trigger, {
        TEST_AUTH_STATE: JSON.stringify({ email: 'person@example.com', accessToken: 'secret-token' }),
    });

    assert.deepEqual(result, {
        ok: true,
        headers: { 'x-even-authorization': 'secret-token' },
    });
});

test('authHeaders refuses to poll with missing or malformed auth state', () => {
    const trigger = website.normalize({
        url: 'https://example.com/private',
        authStateEnv: 'TEST_AUTH_STATE',
    });

    assert.equal(website.authHeaders(trigger, {}).ok, false);
    assert.equal(website.authHeaders(trigger, { TEST_AUTH_STATE: 'not-json' }).ok, false);
    assert.equal(website.authHeaders(trigger, { TEST_AUTH_STATE: '{}' }).ok, false);
});

test('website creation asks for auth and latest-response persistence', async () => {
    const textAnswers = [
        'https://example.com/private.json',
        'always',
        '',
        '30000',
        'ER_AUTH_STATE_STORE',
        'accessToken',
        'x-even-authorization',
    ];
    const yesNoAnswers = [true, true];
    const originalLog = console.log;
    console.log = () => {};

    try {
        const result = await website.ask({
            askText: async () => textAnswers.shift(),
            askYesNo: async () => yesNoAnswers.shift(),
        });
        assert.equal(result.trigger.authStateEnv, 'ER_AUTH_STATE_STORE');
        assert.equal(result.trigger.authTokenField, 'accessToken');
        assert.equal(result.trigger.authHeader, 'x-even-authorization');
        assert.equal(result.trigger.saveLastResponse, true);
        assert.equal(textAnswers.length, 0);
        assert.equal(yesNoAnswers.length, 0);
    } finally {
        console.log = originalLog;
    }
});

test('config.json may store auth state as a private JSON object', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-website-config-test-'));
    const file = path.join(root, 'config.json');
    const oldConfigFile = process.env.GIFT_CONFIG_FILE;
    const oldAuthState = process.env.ER_AUTH_STATE_STORE;
    fs.writeFileSync(file, JSON.stringify({
        triggers: {
            website: { auth_state_store: { accessToken: 'secret-from-config' } },
        },
    }));

    try {
        process.env.GIFT_CONFIG_FILE = file;
        delete process.env.ER_AUTH_STATE_STORE;
        config.loadFor();
        assert.deepEqual(JSON.parse(process.env.ER_AUTH_STATE_STORE), {
            accessToken: 'secret-from-config',
        });
    } finally {
        if (oldConfigFile === undefined) delete process.env.GIFT_CONFIG_FILE;
        else process.env.GIFT_CONFIG_FILE = oldConfigFile;
        if (oldAuthState === undefined) delete process.env.ER_AUTH_STATE_STORE;
        else process.env.ER_AUTH_STATE_STORE = oldAuthState;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('fetchPage sends caller headers and reports the response content type', async () => {
    const originalFetch = global.fetch;
    let request;
    global.fetch = async (url, options) => {
        request = { url, options };
        return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
    };

    try {
        const result = await fetchPage('https://example.com/private', {
            headers: { 'x-even-authorization': 'secret-token' },
        });
        assert.equal(result.ok, true);
        assert.equal(result.contentType, 'application/json; charset=utf-8');
        assert.equal(request.options.headers['x-even-authorization'], 'secret-token');
    } finally {
        global.fetch = originalFetch;
    }
});

test('saveLastResponse writes an atomic private snapshot with a safe hook path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-website-test-'));
    try {
        const saved = website.saveLastResponse(root, '../unsafe hook', 'https://example.com/api', {
            body: '{"version":2}',
            contentType: 'application/json',
        });

        assert.equal(saved, path.join(root, '.._unsafe_hook', 'last_response.json'));
        assert.equal(fs.readFileSync(saved, 'utf8'), '{"version":2}');
        assert.equal(fs.statSync(saved).mode & 0o777, 0o600);

        const replaced = website.saveLastResponse(root, '../unsafe hook', 'https://example.com/api', {
            body: '<p>new</p>',
            contentType: 'text/html',
        });
        assert.equal(path.basename(replaced), 'last_response.html');
        assert.equal(fs.existsSync(saved), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
