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
    log, openLog, openErrorLog, appendErrorLog, errorLogFile,
} = require('./log.js');

/** Both logs pointed at fresh files, with the console kept quiet. */
function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-log-'));
    const activity = path.join(dir, 'hooks.log');
    const errors = path.join(dir, 'logs', 'hooks', 'error.log');

    const out = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    t.after(() => {
        console.log = out;
        console.error = err;
        openLog(null);
        openErrorLog(null);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    return {
        activity,
        errors,
        readActivity: () => fs.readFileSync(activity, 'utf8'),
        readErrors: () => fs.readFileSync(errors, 'utf8'),
    };
}

test('only error lines reach error.log, and all of them reach hooks.log', (t) => {
    const files = scratch(t);
    openLog(files.activity);
    openErrorLog(files.errors);

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

    appendErrorLog('2026-01-01T00:00:00.000Z  error  hooks.json: not valid JSON\n');

    assert.match(files.readErrors(), /hooks\.json: not valid JSON/);
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
