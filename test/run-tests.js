#!/usr/bin/env node
// Tests for the gift CLI and webhook server. No test framework, no packages:
//   node test/run-tests.js
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../lib/cli.js');
const commands = require('../lib/commands.js');
const env = require('../lib/env.js');
const server = require('../webhooks/server.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------ command list ---

test('every command folder is discovered', () => {
    const names = commands.list().map((c) => c.name);
    for (const expected of ['list-weekly-prs', 'recursively-pull-repos']) {
        assert.ok(names.includes(expected), `missing command: ${expected}`);
    }
});

test('only folders inside commands/ are commands', () => {
    for (const command of commands.list()) {
        assert.strictEqual(
            path.dirname(command.dir),
            commands.COMMANDS_DIR,
            `${command.name} was found outside commands/`
        );
    }
    // Folders beside commands/ — the webhook server included — are not commands.
    const names = commands.list().map((c) => c.name);
    for (const outside of ['bin', 'lib', 'completions', 'test', 'commands', 'webhooks']) {
        assert.ok(!names.includes(outside), `${outside} should not be a command`);
    }
});

test('entry scripts resolve, including underscored names', () => {
    const byName = Object.fromEntries(commands.list().map((c) => [c.name, c]));
    assert.strictEqual(path.basename(byName['list-weekly-prs'].entry), 'list_weekly_prs.sh');
    assert.strictEqual(path.basename(byName['recursively-pull-repos'].entry), 'recursively-pull-repos.sh');
});

test('descriptions come from each folder README', () => {
    for (const command of commands.list()) {
        assert.ok(command.description.length > 0, `${command.name} has no description`);
        assert.ok(!command.description.startsWith('='), `${command.name} picked up an underline`);
    }
});

test('a unique prefix resolves to its command', () => {
    assert.strictEqual(commands.resolve('list').command.name, 'list-weekly-prs');
    assert.strictEqual(commands.resolve('recur').command.name, 'recursively-pull-repos');
});

test('an unknown command is reported, not guessed', () => {
    assert.strictEqual(commands.resolve('definitely-not-a-command').status, 'unknown');
    assert.strictEqual(cli.resolveToken('definitely-not-a-command').status, 'unknown');
});

// ------------------------------------------------------- the serve command ---

test('serve runs the webhook server, which is not a commands/ folder', () => {
    const result = cli.resolveToken('serve');
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.command.name, 'serve');
    assert.strictEqual(path.basename(result.command.entry), 'server.js');
    assert.strictEqual(path.basename(path.dirname(result.command.entry)), 'webhooks');
    assert.ok(fs.existsSync(result.command.entry), 'server entry script is missing');
    // serve's folder is webhooks/, so it picks up webhooks/.env like any command.
    assert.strictEqual(result.command.dir, path.join(commands.ROOT, 'webhooks'));
});

test('serve answers to a unique prefix like any other command', () => {
    assert.strictEqual(cli.resolveToken('s').command.name, 'serve');
    assert.strictEqual(cli.resolveToken('serv').command.name, 'serve');
});

test('built-ins and command folders share one namespace', () => {
    assert.strictEqual(cli.resolveToken('help').builtin, 'help');
    assert.strictEqual(cli.resolveToken('list').command.name, 'list-weekly-prs');
    // `c` prefixes both built-ins `commands` and `completion`.
    const ambiguous = cli.resolveToken('c');
    assert.strictEqual(ambiguous.status, 'ambiguous');
    assert.deepStrictEqual(ambiguous.matches, ['commands', 'completion']);
});

test('an ambiguous prefix lists the candidates', () => {
    const dirs = ['zz-test-alpha', 'zz-test-beta'].map((n) => path.join(commands.COMMANDS_DIR, n));
    try {
        for (const dir of dirs) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'main.sh'), '#!/bin/bash\ntrue\n');
        }
        const result = commands.resolve('zz-test');
        assert.strictEqual(result.status, 'ambiguous');
        assert.deepStrictEqual(
            result.matches.map((m) => m.name).sort(),
            ['zz-test-alpha', 'zz-test-beta']
        );
    } finally {
        for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -------------------------------------------------------------------- .env ---

test('.env parsing handles quotes, export and comments', () => {
    const values = env.parse(
        [
            '# a comment',
            'PLAIN=value',
            'export EXPORTED=yes',
            'QUOTED="with spaces"',
            "SINGLE='single'",
            'TRAILING=value # note',
            'EMPTY=',
            'not a pair',
        ].join('\n')
    );
    assert.deepStrictEqual(values, {
        PLAIN: 'value',
        EXPORTED: 'yes',
        QUOTED: 'with spaces',
        SINGLE: 'single',
        TRAILING: 'value',
        EMPTY: '',
    });
});

test('a command folder can bring its own .env, and the environment still wins', () => {
    const dir = path.join(commands.COMMANDS_DIR, 'zz-test-env');
    const keys = ['ZZ_OWN', 'ZZ_FROM_ENV'];
    const before = keys.map((k) => [k, process.env[k]]);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.env'),
            'ZZ_OWN=from-command\nZZ_FROM_ENV=from-command\n'
        );

        for (const k of keys) delete process.env[k];
        process.env.ZZ_FROM_ENV = 'from-environment';

        env.loadFor(dir);
        assert.strictEqual(process.env.ZZ_OWN, 'from-command');
        assert.strictEqual(process.env.ZZ_FROM_ENV, 'from-environment');

        // Without a command folder, nothing from that folder is read.
        delete process.env.ZZ_OWN;
        env.loadFor();
        assert.strictEqual(process.env.ZZ_OWN, undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [k, v] of before) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test('the file loaded first wins — how the command .env beats the shared one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-env-'));
    const before = process.env.ZZ_LAYERED;
    try {
        const own = path.join(dir, 'own.env');
        const shared = path.join(dir, 'shared.env');
        fs.writeFileSync(own, 'ZZ_LAYERED=own\n');
        fs.writeFileSync(shared, 'ZZ_LAYERED=shared\n');

        delete process.env.ZZ_LAYERED;
        env.load(own); // the command's, loaded first
        env.load(shared); // the shared one, second — must not overwrite
        assert.strictEqual(process.env.ZZ_LAYERED, 'own');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        if (before === undefined) delete process.env.ZZ_LAYERED;
        else process.env.ZZ_LAYERED = before;
    }
});

// ------------------------------------------------------------- signatures ---

const SECRET = 'test-secret';
const secrets = new Map([['GITHUB_WEBHOOK_SECRET', SECRET]]);

function sign(body, secret = SECRET) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('a correct signature is accepted', () => {
    const body = Buffer.from('{"hello":"world"}');
    assert.deepStrictEqual(server.verifySignature(body, sign(body), secrets), [
        'GITHUB_WEBHOOK_SECRET',
    ]);
});

test('a wrong secret, tampered body or missing header is rejected', () => {
    const body = Buffer.from('{"hello":"world"}');
    assert.deepStrictEqual(server.verifySignature(body, sign(body, 'other'), secrets), []);
    assert.deepStrictEqual(server.verifySignature(Buffer.from('{}'), sign(body), secrets), []);
    assert.deepStrictEqual(server.verifySignature(body, undefined, secrets), []);
    assert.deepStrictEqual(server.verifySignature(body, 'sha256=short', secrets), []);
});

// ---------------------------------------------------------------- matching ---

const hook = {
    name: 'deploy',
    repo: 'owner/repo',
    events: ['push'],
    branches: ['main'],
    secretEnv: 'GITHUB_WEBHOOK_SECRET',
};
const delivery = {
    event: 'push',
    repo: 'owner/repo',
    ref: 'refs/heads/main',
    secretNames: ['GITHUB_WEBHOOK_SECRET'],
};

test('a matching delivery triggers the hook', () => {
    assert.strictEqual(server.matches(hook, delivery), true);
});

test('event, repository and branch all have to match', () => {
    assert.strictEqual(server.matches(hook, { ...delivery, event: 'pull_request' }), false);
    assert.strictEqual(server.matches(hook, { ...delivery, repo: 'someone/else' }), false);
    assert.strictEqual(server.matches(hook, { ...delivery, ref: 'refs/heads/dev' }), false);
    assert.strictEqual(server.matches(hook, { ...delivery, ref: 'refs/tags/v1' }), false);
});

test('a hook only fires for its own secret', () => {
    assert.strictEqual(server.matches(hook, { ...delivery, secretNames: ['OTHER_SECRET'] }), false);
});

test('wildcards widen repo, events and branches', () => {
    const any = { ...hook, repo: '*', events: ['*'], branches: ['*'] };
    assert.strictEqual(server.matches(any, { ...delivery, event: 'release', repo: 'x/y' }), true);
});

test('repository comparison ignores case', () => {
    assert.strictEqual(server.matches(hook, { ...delivery, repo: 'Owner/Repo' }), true);
});

// ---------------------------------------------------------------- requests ---

function startServer() {
    const config = {
        path: '/hooks/github',
        hooks: [{ ...hook, run: '/bin/echo', args: [], detach: false }],
    };
    const instance = server.createServer(config, secrets, {
        path: '/hooks/github',
        dryRun: true, // never actually spawn anything from the test suite
    });
    return new Promise((resolve) => {
        instance.listen(0, '127.0.0.1', () => {
            const { port } = instance.address();
            resolve({ instance, base: `http://127.0.0.1:${port}` });
        });
    });
}

function post(base, event, payload, { secret = SECRET, signed = true } = {}) {
    const body = JSON.stringify(payload);
    const headers = {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': 'test-delivery',
    };
    if (signed) headers['x-hub-signature-256'] = sign(Buffer.from(body), secret);
    return fetch(`${base}/hooks/github`, { method: 'POST', headers, body });
}

const pushPayload = {
    ref: 'refs/heads/main',
    repository: { full_name: 'owner/repo' },
    sender: { login: 'someone' },
};

async function withServer(fn) {
    const { instance, base } = await startServer();
    try {
        await fn(base);
    } finally {
        await new Promise((resolve) => instance.close(resolve));
    }
}

test('GET /health answers ok', () =>
    withServer(async (base) => {
        const res = await fetch(`${base}/health`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), 'ok');
    }));

test('an unknown path is a 404', () =>
    withServer(async (base) => {
        assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
    }));

test('GET on the webhook path is a 405', () =>
    withServer(async (base) => {
        assert.strictEqual((await fetch(`${base}/hooks/github`)).status, 405);
    }));

test('an unsigned delivery is a 401', () =>
    withServer(async (base) => {
        const res = await post(base, 'push', pushPayload, { signed: false });
        assert.strictEqual(res.status, 401);
    }));

test('a delivery signed with the wrong secret is a 401', () =>
    withServer(async (base) => {
        const res = await post(base, 'push', pushPayload, { secret: 'wrong' });
        assert.strictEqual(res.status, 401);
    }));

test('ping is answered with pong', () =>
    withServer(async (base) => {
        const res = await post(base, 'ping', { zen: 'Keep it logically awesome.' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), 'pong');
    }));

test('a matching push is accepted with 202', () =>
    withServer(async (base) => {
        const res = await post(base, 'push', pushPayload);
        assert.strictEqual(res.status, 202);
        assert.match(await res.text(), /deploy/);
    }));

test('a push to another branch matches no hook', () =>
    withServer(async (base) => {
        const res = await post(base, 'push', { ...pushPayload, ref: 'refs/heads/dev' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), 'No hook matched');
    }));

test('a signed but malformed body is a 400', () =>
    withServer(async (base) => {
        const body = 'not json';
        const res = await fetch(`${base}/hooks/github`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-github-event': 'push',
                'x-github-delivery': 'test-delivery',
                'x-hub-signature-256': sign(Buffer.from(body)),
            },
            body,
        });
        assert.strictEqual(res.status, 400);
    }));

// ------------------------------------------------------------------ runner ---

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ok    ${name}`);
        } catch (err) {
            failed++;
            console.log(`  FAIL  ${name}`);
            console.log(`        ${err.message.split('\n').join('\n        ')}`);
        }
    }
    console.log('');
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed === 0 ? 0 : 1);
})();
