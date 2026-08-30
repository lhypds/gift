// What `gift create` calls a hook, and what `gift delete` takes away.
//
// The name is a default offered at the prompt, but it is the one most hooks end
// up with, and it is also the folder their logs are filed under — so a name out
// of the part of a URL most likely to be edited later is a name that stops
// describing the hook.
//
// A deleted hook's folder under logs/hooks goes with it: nothing will ever add
// to it again, and `gift status` reads those files to decide what to report as
// broken. The case worth a test is the one the folder layout makes possible —
// hook names are labels and may be repeated, so two hooks can share a folder,
// and deleting one of them must not empty the other's.
//
//     node --test utils/hooks.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultName, removeHookLogs } = require('./hooks.js');
const { hookLogDirFor, HOOK_LOG_DIR } = require('./log.js');
const website = require('../triggers/website/index.js');

/** `gift create` for a website hook, with the answers typed for it. */
async function askWebsite(url, answers = {}) {
    const typed = {
        'URL to poll': url,
        'Fire when': 'change',
        'Text the page': '',
        'How often': '60000',
        ...answers,
    };
    // ask() explains itself on the way past; the answers are what is under test.
    const out = console.log;
    console.log = () => {};
    try {
        return await website.ask({
            askText: async (question) => {
                const match = Object.keys(typed).find((start) => question.startsWith(start));
                return match === undefined ? '' : typed[match];
            },
            askYesNo: async () => false,
        });
    } finally {
        console.log = out;
    }
}

test('a website hook is named after the site, not the last part of the path', async () => {
    const asked = await askWebsite('https://hub.evenrealities.com/api/v1/publish-reviews/status?package_id=com.gcc3.lo');

    // Not hook-status: half the pages worth polling are called /status, and the
    // path is the part most likely to be edited after the hook is created.
    assert.strictEqual(defaultName('website', asked, new Set()), 'hook-hub.evenrealities.com');
});

test('the site keeps its top-level domain, which is not a file extension', async () => {
    const asked = await askWebsite('https://example.com');

    // The general rule cuts `.json` off `status.json`; a name the trigger chose
    // is taken as written, or this would be hook-example.
    assert.strictEqual(defaultName('website', asked, new Set()), 'hook-example.com');
});

test('www is how a site was typed, not which site it is', () => {
    assert.strictEqual(website.siteName('https://www.example.com/status'), 'example.com');
    assert.strictEqual(website.siteName('https://WWW.Example.COM/status'), 'example.com');
});

test('a second hook on the same site is numbered rather than refused', async () => {
    const asked = await askWebsite('https://example.com/status');

    assert.strictEqual(defaultName('website', asked, new Set(['hook-example.com'])), 'hook-example.com-2');
});

test('a trigger with nothing to suggest still falls back to the general rule', () => {
    // What the other three triggers hand over: a repository, a folder, a phrase.
    assert.strictEqual(defaultName('github', { label: 'owner/deploy-scripts' }, new Set()), 'hook-deploy-scripts');
    assert.strictEqual(defaultName('file', { label: '/var/log/nginx.conf' }, new Set()), 'hook-nginx');
    assert.strictEqual(defaultName('github', { label: '*' }, new Set()), 'hook-github');
});

/** A hook folder with the files a working hook accumulates. */
function hookFolder(t, name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-delete-'));
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ['error.log', 'hook.log', 'last_response.json']) {
        fs.writeFileSync(path.join(dir, file), 'something\n');
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return dir;
}

test('deleting a hook takes its logs and its saved response with it', (t) => {
    const dir = hookFolder(t, 'gone-hook');

    const result = removeHookLogs('gone-hook', ['another-hook'], dir);

    assert.deepStrictEqual(result.removed.sort(), ['error.log', 'hook.log', 'last_response.json']);
    assert.strictEqual(fs.existsSync(dir), false);
});

test('a folder two hooks share is kept for the one still configured', (t) => {
    const dir = hookFolder(t, 'twice-over');

    // Same name, two lines of hooks.json: the folder is chosen by name, so it
    // belongs to both, and the one that remains is still writing to it.
    const result = removeHookLogs('twice-over', ['twice-over', 'other'], dir);

    assert.strictEqual(result.kept, true);
    assert.ok(fs.existsSync(path.join(dir, 'hook.log')), 'the surviving hook keeps its log');
});

test('a hook that never wrote anything is deleted without complaint', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-delete-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const result = removeHookLogs('quiet-hook', [], path.join(root, 'quiet-hook'));

    assert.strictEqual(result.missing, true);
    assert.strictEqual(result.error, undefined);
});

test('the folder a name resolves to is always inside logs/hooks', () => {
    // The name comes out of hooks.json, and what is about to happen to that
    // folder is rm -r: a hook called ../../etc must not name a path out of here.
    const dir = hookLogDirFor('../../etc');

    assert.strictEqual(path.dirname(dir), HOOK_LOG_DIR);
    assert.strictEqual(path.basename(dir), '.._.._etc');
});
