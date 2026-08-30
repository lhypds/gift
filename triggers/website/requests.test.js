// One line per request, in the hook's own hook.log.
//
// A website hook that polls every minute and fires twice a month is silent in
// between: hooks.log records what the server did, and a poll that changed
// nothing is not that. hook.log is the file where "it is still asking, the
// answer is simply the same as yesterday's" can be read — so the thing to get
// right is that every poll leaves a line, and that the line says whether the
// script ran.
//
//     node --test triggers/website/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const website = require('./index.js');
const hookRecord = require('../../utils/hook.js');
const { openLog, openErrorLog, openHookLogs } = require('../../utils/log.js');

const INTERVAL = 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function scratch(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-hook-log-'));
    const hookDir = path.join(root, 'logs', 'hooks');

    const out = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};

    openLog(path.join(root, 'hooks.log'));
    openErrorLog(path.join(hookDir, 'error.log'));
    openHookLogs(hookDir);

    t.after(() => {
        console.log = out;
        console.error = err;
        openLog(null);
        openErrorLog(null);
        openHookLogs(null);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const file = (name) => path.join(hookDir, name, 'hook.log');
    return {
        hookDir,
        lines: (name) => (fs.existsSync(file(name))
            ? fs.readFileSync(file(name), 'utf8').trim().split('\n').filter(Boolean)
            : []),
    };
}

/** A page whose body the test can change between polls. */
async function page(t, body) {
    const state = { body };
    const server = http.createServer((_req, res) => res.end(state.body));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    state.url = `http://127.0.0.1:${server.address().port}/status`;
    return state;
}

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

function startHook(t, files, url, fired) {
    const hook = hookRecord.normalize({
        name: 'polling-hook',
        trigger: { type: 'website', url, on: 'change', interval: INTERVAL, timeout: 500, saveLastResponse: false },
        run: path.join(os.tmpdir(), 'never-run.sh'),
        cwd: os.tmpdir(),
    }, 0);

    const handle = website.start({
        hooks: [hook],
        runtime: { dispatch: () => fired.push(Date.now()) },
        options: { configFile: null, responseLogDir: files.hookDir },
    });
    t.after(() => handle.stop());
    return hook;
}

test('every poll writes a line, and the line says whether the hook ran', async (t) => {
    const files = scratch(t);
    const site = await page(t, 'still waiting');
    const fired = [];
    startHook(t, files, site.url, fired);

    // The first poll has nothing to compare against, the second matches it.
    await wait(INTERVAL + 400);
    let lines = files.lines('polling-hook');
    assert.strictEqual(lines.length, 2, `one line per poll, got ${lines.length}`);
    assert.match(lines[0], /quiet {3}first poll, nothing to compare against yet {2}url=\S+ status=200 ms=\d+/);
    assert.match(lines[1], /quiet {3}the page has not changed/);
    assert.strictEqual(fired.length, 0, 'nothing ran, and the log says so');

    site.body = 'approved';
    await wait(INTERVAL + 400);

    lines = files.lines('polling-hook');
    assert.strictEqual(lines.length, 3);
    assert.match(lines[2], /fired {3}the page came back different {2}url=\S+ status=200 ms=\d+/);
    assert.strictEqual(fired.length, 1, 'the hook the log says fired is the one that fired');
});

test('a poll that never reached the page is a line too', async (t) => {
    const files = scratch(t);
    const port = await closedPort();
    startHook(t, files, `http://127.0.0.1:${port}/status`, []);

    await wait(INTERVAL + 400);

    // error.log keeps one line for an outage that is still the same outage;
    // hook.log keeps them all, because there the question is whether the hook
    // asked at all — an hour of silence and an hour of failures look the same
    // in a file that only records the first one.
    const lines = files.lines('polling-hook');
    assert.strictEqual(lines.length, 2, `one line per poll, got ${lines.length}`);
    for (const line of lines) assert.match(line, /failed {2}poll failed:/);
});
