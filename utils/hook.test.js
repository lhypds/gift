// What a hook's handler half is allowed to be, and what it becomes.
//
// `run` used to be one absolute path to a `.sh` file, which made `cwd` free:
// the script's own folder. Now it is a command line, and the two things worth a
// test are that the old shape still normalises to exactly what it always did —
// every hooks.json in the wild is written that way — and that a command with no
// folder in it is refused at startup rather than silently run wherever the
// server happened to be started.
//
//     node --test utils/hook.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const hookRecord = require('./hook.js');

/** A hook with a trigger that asks for nothing, so `run` is what is under test. */
const withRun = (run, rest = {}) => ({
    name: 'deploy',
    trigger: { type: 'file', path: '/opt/myapp/conf' },
    run,
    ...rest,
});

test('a script path keeps working, and still names its own folder', () => {
    const hook = hookRecord.normalize(withRun('/opt/myapp/deploy.sh'));
    assert.strictEqual(hook.run, '/opt/myapp/deploy.sh');
    assert.strictEqual(hook.cwd, '/opt/myapp');
});

test('a command is kept as written', () => {
    const hook = hookRecord.normalize(withRun('bash /opt/myapp/deploy.sh --quiet'));
    assert.strictEqual(hook.run, 'bash /opt/myapp/deploy.sh --quiet');
    assert.strictEqual(hook.cwd, '/opt/myapp');

    // Surrounding space is the one thing trimmed: it is a typo in every case,
    // and bash would only make an empty first word of it.
    assert.strictEqual(hookRecord.normalize(withRun('  /opt/myapp/deploy.sh  ')).run, '/opt/myapp/deploy.sh');
});

test('cwd is answered by the hook when the command does not', () => {
    const hook = hookRecord.normalize(withRun('npm run deploy', { cwd: '/opt/myapp' }));
    assert.strictEqual(hook.cwd, '/opt/myapp');

    assert.throws(
        () => hookRecord.normalize(withRun('npm run deploy')),
        /needs a "cwd"/,
    );
});

test('a hook with nothing to run is refused', () => {
    assert.throws(() => hookRecord.normalize(withRun('')), /has no "run" command/);
    assert.throws(() => hookRecord.normalize(withRun('   ')), /has no "run" command/);
    assert.throws(() => hookRecord.normalize(withRun(undefined)), /has no "run" command/);
});

test('cwd is still absolute or nothing', () => {
    assert.throws(
        () => hookRecord.normalize(withRun('/opt/myapp/deploy.sh', { cwd: 'myapp' })),
        /"cwd" must be an absolute path/,
    );
});
