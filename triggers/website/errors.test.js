// What a hook that stops working writes down.
//
// A failing poll is not fired on — a hook cannot tell "the site is down" from
// "this machine's DNS is down" — but it is still a hook that is not doing its
// job, and that belongs in its error log. The thing to get right is the volume:
// polling a dead host every minute must not put a line an hour into error.log
// and bury the next real problem under an old one.
//
//     node --test triggers/website/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const website = require('./index.js');
const hookRecord = require('../../utils/hook.js');
const { openLog, openErrorLog, openHookErrorLogs } = require('../../utils/log.js');

const INTERVAL = 1000;

/** A port with nothing on it: connecting fails at once, with no DNS involved. */
function closedPort() {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function scratch(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-hook-err-'));
    const hookDir = path.join(root, 'logs', 'hooks');
    const activity = path.join(root, 'hooks.log');

    const out = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};

    openLog(activity);
    openErrorLog(path.join(hookDir, 'error.log'));
    openHookErrorLogs(hookDir);

    t.after(() => {
        console.log = out;
        console.error = err;
        openLog(null);
        openErrorLog(null);
        openHookErrorLogs(null);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const errorLog = (name) => path.join(hookDir, name, 'error.log');
    return {
        hookDir,
        readActivity: () => fs.readFileSync(activity, 'utf8'),
        errorLines: (name) => (fs.existsSync(errorLog(name))
            ? fs.readFileSync(errorLog(name), 'utf8').trim().split('\n').filter(Boolean)
            : []),
    };
}

function startHook(t, files, url) {
    const hook = hookRecord.normalize({
        name: 'flaky-hook',
        trigger: { type: 'website', url, on: 'change', interval: INTERVAL, timeout: 500, saveLastResponse: false },
        run: path.join(os.tmpdir(), 'never-run.sh'),
        cwd: os.tmpdir(),
    }, 0);

    const handle = website.start({
        hooks: [hook],
        runtime: { dispatch: () => {} },
        options: { configFile: null, responseLogDir: files.hookDir },
    });
    t.after(() => handle.stop());
    return hook;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a hook that keeps failing the same way writes one error, not one per poll', async (t) => {
    const files = scratch(t);
    const port = await closedPort();
    startHook(t, files, `http://127.0.0.1:${port}/thing`);

    await wait(INTERVAL * 3 + 400);

    const errors = files.errorLines('flaky-hook');
    assert.strictEqual(errors.length, 1, `one error for one outage, got ${errors.length}`);
    assert.match(errors[0], /error {2}poll failed:/);

    // The repeats are not lost — they are in hooks.log, as warnings.
    const repeats = files.readActivity().split('\n').filter((l) => l.includes('warn') && l.includes('poll failed'));
    assert.ok(repeats.length >= 1, 'the polls after the first are still recorded');
});

test('recovering resets it, so the next outage is a fresh error', async (t) => {
    const files = scratch(t);
    const port = await closedPort();
    const hook = startHook(t, files, `http://127.0.0.1:${port}/thing`);

    await wait(INTERVAL + 400);
    assert.strictEqual(files.errorLines('flaky-hook').length, 1);

    // Something it can reach. Any answer at all counts as the hook working.
    const server = require('node:http').createServer((_req, res) => res.end('{}'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    hook.trigger.url = `http://127.0.0.1:${server.address().port}/thing`;

    await wait(INTERVAL + 400);
    assert.match(files.readActivity(), /polling again/);
    assert.strictEqual(files.errorLines('flaky-hook').length, 1, 'recovering writes no error of its own');

    hook.trigger.url = `http://127.0.0.1:${port}/thing`;
    await wait(INTERVAL + 400);
    assert.strictEqual(files.errorLines('flaky-hook').length, 2, 'a new outage is a new error');
});

test("a failing hook's errors go to its own folder, not the shared file", async (t) => {
    const files = scratch(t);
    const port = await closedPort();
    startHook(t, files, `http://127.0.0.1:${port}/thing`);

    await wait(INTERVAL + 400);

    assert.strictEqual(files.errorLines('flaky-hook').length, 1);
    assert.strictEqual(fs.readFileSync(path.join(files.hookDir, 'error.log'), 'utf8'), '');
});
