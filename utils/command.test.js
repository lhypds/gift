// What can be read out of a hook's `run` without running it.
//
// A command line is bash's to interpret, and everything here is a guess made to
// be helpful rather than an answer that has to be right: which folder the hook
// belongs in when it does not say, and which file to warn about at startup. The
// cases worth a test are the ones where the obvious reading is the wrong one —
// `/usr/bin/env python3 /opt/app/notify.py` does not belong in /usr/bin, and a
// word holding `$HOME` is not a path this can check.
//
//     node --test utils/command.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const command = require('./command.js');

const text = (line) => command.words(line).map((word) => word.text);

test('words splits a line the way bash would', () => {
    assert.deepStrictEqual(text('bash /opt/app/deploy.sh --quiet'), ['bash', '/opt/app/deploy.sh', '--quiet']);
    assert.deepStrictEqual(text('say "two words" \'and one\''), ['say', 'two words', 'and one']);
    assert.deepStrictEqual(text('cp a\\ b.txt /tmp'), ['cp', 'a b.txt', '/tmp']);
});

test('words stops where a second command begins', () => {
    // What runs after `&&` is a command of its own, and which of the two the
    // hook is "really" running is not a question with an answer.
    assert.deepStrictEqual(text('cd /opt/app && ./deploy.sh'), ['cd', '/opt/app']);
    assert.deepStrictEqual(text('cat /etc/hosts | wc -l'), ['cat', '/etc/hosts']);
    assert.deepStrictEqual(text('./deploy.sh # nightly'), ['./deploy.sh']);
});

test('a word bash will expand is not literal', () => {
    const [, variable] = command.words('bash $SCRIPT');
    assert.strictEqual(variable.literal, false);
    const [, glob] = command.words('rm /tmp/gift-*');
    assert.strictEqual(glob.literal, false);
    // Quoted, `$` is still a variable; the quotes only stop the splitting.
    const [, quoted] = command.words('echo "$GIFT_HOOK"');
    assert.strictEqual(quoted.literal, false);
    const [, plain] = command.words("echo '$GIFT_HOOK'");
    assert.strictEqual(plain.literal, true);
});

test('program is what bash runs first, or nothing it can be sure of', () => {
    assert.strictEqual(command.program('/opt/app/deploy.sh'), '/opt/app/deploy.sh');
    assert.strictEqual(command.program('bash /opt/app/deploy.sh'), 'bash');
    assert.strictEqual(command.program('  npm run deploy'), 'npm');
    // An assignment standing in front of the real program, and a program named
    // by a variable: in both, the first word is not what runs.
    assert.strictEqual(command.program('NODE_ENV=production npm run deploy'), null);
    assert.strictEqual(command.program('$DEPLOY --quiet'), null);
    assert.strictEqual(command.program(''), null);
});

test('directory is the folder of the script, not of the interpreter', () => {
    assert.strictEqual(command.directory('/opt/app/deploy.sh'), '/opt/app');
    assert.strictEqual(command.directory('bash /opt/app/deploy.sh'), '/opt/app');
    assert.strictEqual(command.directory('/usr/bin/env python3 /opt/app/notify.py'), '/opt/app');
    assert.strictEqual(command.directory('cd /opt/app && ./deploy.sh'), '/opt/app');
    assert.strictEqual(command.directory('~/bin/deploy.sh'), path.join(os.homedir(), 'bin'));
    // Nothing absolute to go on: the hook has to say where it runs.
    assert.strictEqual(command.directory('npm run deploy'), null);
    assert.strictEqual(command.directory('./deploy.sh'), null);
});

test('notes name the file that will fail, before it fails', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-command-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const script = path.join(dir, 'deploy.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\n', { mode: 0o644 });

    assert.deepStrictEqual(command.notes(script), [`${script} is not executable — chmod +x it`]);
    // Handed to an interpreter it is read rather than executed, so being there
    // is all that is asked of it.
    assert.deepStrictEqual(command.notes(`bash ${script}`), []);

    const missing = path.join(dir, 'nope.sh');
    assert.deepStrictEqual(command.notes(missing), [`no file at ${missing} yet`]);
    assert.deepStrictEqual(command.notes(`bash ${missing}`), [`nothing at ${missing} yet`]);

    fs.chmodSync(script, 0o755);
    assert.deepStrictEqual(command.notes(script), []);

    // Relative to the folder the hook runs in, which is where bash will look.
    assert.deepStrictEqual(command.notes('./deploy.sh', dir), []);
});

test('a path with a space in it is named as the one file it is', (t) => {
    // It was one word while `run` was a path; as a command it is two, and the
    // half bash reports going looking for is not what anyone wrote.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-command-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const script = path.join(dir, 'my deploy.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\n', { mode: 0o755 });

    assert.deepStrictEqual(command.notes(script), [
        `${script} is one file, but the command reads as 2 words — quote it`,
    ]);
    // Quoted, it is the one word it looks like, and there is nothing to say.
    assert.deepStrictEqual(command.notes(`"${script}"`), []);
});

test('notes stay quiet about what they cannot check', () => {
    // A shell builtin is on no PATH, a variable is not a name to look up, and
    // an unknown program is worth one line rather than a guess about the rest.
    assert.deepStrictEqual(command.notes('cd /tmp && ls'), []);
    assert.deepStrictEqual(command.notes('$DEPLOY --quiet'), []);
    assert.deepStrictEqual(command.notes('definitely-not-a-real-program --go'), [
        'definitely-not-a-real-program is not on PATH',
    ]);
});
