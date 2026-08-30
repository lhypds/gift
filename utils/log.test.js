// Which lines end up in which file.
//
//     node --test utils/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    log, logHook, openLog, openErrorLog, openHookLogs, appendErrorLog, errorLogFile, safeHookName,
} = require('./log.js');

/** Every log pointed at fresh files, with the console kept quiet. */
function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-log-'));
    const hookDir = path.join(dir, 'logs', 'hooks');
    const activity = path.join(dir, 'hooks.log');
    const errors = path.join(hookDir, 'error.log');

    const out = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    t.after(() => {
        console.log = out;
        console.error = err;
        openLog(null);
        openErrorLog(null);
        openHookLogs(null);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    return {
        dir,
        hookDir,
        activity,
        errors,
        hookErrors: (name) => path.join(hookDir, safeHookName(name), 'error.log'),
        hookRequests: (name) => path.join(hookDir, safeHookName(name), 'hook.log'),
        readActivity: () => fs.readFileSync(activity, 'utf8'),
        readErrors: () => fs.readFileSync(errors, 'utf8'),
        readHookErrors: (name) => fs.readFileSync(path.join(hookDir, safeHookName(name), 'error.log'), 'utf8'),
        readHookRequests: (name) => fs.readFileSync(path.join(hookDir, safeHookName(name), 'hook.log'), 'utf8'),
    };
}

test('only error lines reach error.log, and all of them reach hooks.log', (t) => {
    const files = scratch(t);
    openLog(files.activity);
    openErrorLog(files.errors);
    openHookLogs(files.hookDir);

    log('info', 'polling something');
    log('warn', 'poll skipped: credential header has no value');
    log('error', 'the website trigger could not start');

    const errors = files.readErrors();
    assert.match(errors, /the website trigger could not start/);
    assert.doesNotMatch(errors, /polling something/);
    assert.doesNotMatch(errors, /poll skipped/);
    assert.strictEqual(errors.trim().split('\n').length, 1);

    // Nothing is diverted: hooks.log still tells the whole story in order.
    const activity = files.readActivity();
    for (const line of ['polling something', 'poll skipped', 'could not start']) {
        assert.match(activity, new RegExp(line));
    }
});

test("an error naming a hook goes to that hook's folder, not the shared file", (t) => {
    const files = scratch(t);
    openLog(files.activity);
    openErrorLog(files.errors);
    openHookLogs(files.hookDir);

    log('error', 'hook error: spawn ENOEXEC', { hook: 'hook-clipboard.gochaichai' });

    assert.match(files.readHookErrors('hook-clipboard.gochaichai'), /spawn ENOEXEC/);
    // The shared file is for the server's own failures; a hook's belong to it.
    assert.strictEqual(files.readErrors(), '');
    // And hooks.log still has it, in sequence with everything else.
    assert.match(files.readActivity(), /spawn ENOEXEC/);
});

test("a hook's requests go to its own hook.log, and nowhere else", (t) => {
    const files = scratch(t);
    openLog(files.activity);
    openErrorLog(files.errors);
    openHookLogs(files.hookDir);

    logHook('hook-clipboard.gochaichai', 'quiet', 'the page has not changed', { status: 200, ms: 42 });
    logHook('hook-clipboard.gochaichai', 'fired', 'the page came back different', { status: 200, ms: 51 });

    const requests = files.readHookRequests('hook-clipboard.gochaichai').trim().split('\n');
    assert.strictEqual(requests.length, 2);
    assert.match(requests[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z {2}quiet {3}the page has not changed {2}status=200 ms=42$/);
    assert.match(requests[1], /fired {3}the page came back different/);

    // hooks.log is the story of what the server did; a poll that changed
    // nothing is not part of it, and neither file has an error to report.
    assert.strictEqual(files.readActivity(), '');
    assert.strictEqual(files.readErrors(), '');
    assert.strictEqual(fs.existsSync(files.hookErrors('hook-clipboard.gochaichai')), false);
});

test('a hook that has never failed has no error log at all', (t) => {
    const files = scratch(t);
    openLog(files.activity);
    openHookLogs(files.hookDir);

    log('info', 'polling', { hook: 'quiet-hook' });
    log('warn', 'poll skipped', { hook: 'quiet-hook' });

    assert.strictEqual(fs.existsSync(files.hookErrors('quiet-hook')), false);
});

test('a hook name that is not a filename still gets a folder', (t) => {
    const files = scratch(t);
    openErrorLog(files.errors);
    openHookLogs(files.hookDir);

    log('error', 'went wrong', { hook: '../../etc/passwd' });

    // Sanitized to a single flat directory name — never up and out of the folder.
    const written = path.join(files.hookDir, safeHookName('../../etc/passwd'), 'error.log');
    assert.ok(fs.existsSync(written), 'written inside the hooks folder');
    assert.strictEqual(path.dirname(path.dirname(written)), files.hookDir);
    assert.match(fs.readFileSync(written, 'utf8'), /went wrong/);
});

test('error.log is created 0600, with its folder', (t) => {
    const files = scratch(t);
    openErrorLog(files.errors);

    assert.ok(fs.existsSync(files.errors), 'the folder was created along with the file');
    assert.strictEqual(fs.statSync(files.errors).mode & 0o777, 0o600);
});

test('a refusal to start is written even with no hooks.log open', (t) => {
    // The case error.log exists for: hooks.json would not parse, so the log it
    // names was never opened. Nothing should be lost, and nothing should throw.
    const files = scratch(t);
    openLog(null);
    openErrorLog(files.errors);
    openHookLogs(files.hookDir);

    appendErrorLog('2026-01-01T00:00:00.000Z  error  hooks.json: not valid JSON\n');

    assert.match(files.readErrors(), /hooks\.json: not valid JSON/);
    // The reason the shared file has to exist: there are no hook names yet to
    // file this under, because reading the file that names them is what failed.
    assert.deepStrictEqual(fs.readdirSync(files.hookDir), ['error.log']);
});

test('logging survives an error log that cannot be opened', (t) => {
    const files = scratch(t);
    openLog(files.activity);
    // A directory where the file should be: opening it fails, and must not take
    // the server down or stop hooks.log from working.
    fs.mkdirSync(files.errors, { recursive: true });
    openErrorLog(files.errors);

    assert.strictEqual(errorLogFile.disabled, true);
    log('error', 'still logged somewhere');
    assert.match(files.readActivity(), /still logged somewhere/);
});
