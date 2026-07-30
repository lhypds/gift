#!/usr/bin/env node
// Tests for the gift CLI, the `gift run` picker, and the webhook server.
// No test framework, no packages:
//   node test/run-tests.js
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../lib/cli.js');
const functions = require('../lib/functions.js');
const env = require('../lib/env.js');
const pick = require('../lib/pick.js');
const server = require('../webhooks/server.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ----------------------------------------------------------- function list ---

test('every function folder is discovered', () => {
    const names = functions.list().map((f) => f.name);
    for (const expected of ['list-weekly-prs', 'recursively-pull-repos']) {
        assert.ok(names.includes(expected), `missing function: ${expected}`);
    }
});

test('only folders inside functions/ are functions', () => {
    for (const fn of functions.list()) {
        assert.strictEqual(
            path.dirname(fn.dir),
            functions.FUNCTIONS_DIR,
            `${fn.name} was found outside functions/`
        );
    }
    // Folders beside functions/ — the webhook server included — are not functions.
    const names = functions.list().map((f) => f.name);
    for (const outside of ['bin', 'lib', 'test', 'functions', 'webhooks']) {
        assert.ok(!names.includes(outside), `${outside} should not be a function`);
    }
});

test('entry scripts resolve, including underscored names', () => {
    const byName = Object.fromEntries(functions.list().map((f) => [f.name, f]));
    assert.strictEqual(path.basename(byName['list-weekly-prs'].entry), 'list_weekly_prs.sh');
    assert.strictEqual(path.basename(byName['recursively-pull-repos'].entry), 'recursively-pull-repos.sh');
});

test('descriptions come from each folder README', () => {
    for (const fn of functions.list()) {
        assert.ok(fn.description.length > 0, `${fn.name} has no description`);
        assert.ok(!fn.description.startsWith('='), `${fn.name} picked up an underline`);
    }
});

test('a unique prefix resolves to its function', () => {
    assert.strictEqual(functions.resolve('list').fn.name, 'list-weekly-prs');
    assert.strictEqual(functions.resolve('recur').fn.name, 'recursively-pull-repos');
});

test('an unknown function is reported, not guessed', () => {
    assert.strictEqual(functions.resolve('definitely-not-a-function').status, 'unknown');
    assert.strictEqual(cli.resolveToken('definitely-not-a-function').status, 'unknown');
});

// ---------------------------------------------------------- serve and stop ---

test('serve restarts the webhooks server, which is not a functions/ folder', () => {
    const result = cli.resolveToken('serve');
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.fn.name, 'serve');
    assert.strictEqual(path.basename(result.fn.entry), 'restart.sh');
    assert.strictEqual(path.basename(path.dirname(result.fn.entry)), 'webhooks');
    assert.ok(fs.existsSync(result.fn.entry), 'restart script is missing');
    // serve's folder is webhooks/, so it picks up webhooks/.env like any function.
    assert.strictEqual(result.fn.dir, path.join(functions.ROOT, 'webhooks'));
});

test('stop stops the webhooks server', () => {
    const result = cli.resolveToken('stop');
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.fn.name, 'stop');
    assert.strictEqual(path.basename(result.fn.entry), 'stop.sh');
    assert.ok(fs.existsSync(result.fn.entry), 'stop script is missing');
    assert.strictEqual(result.fn.dir, path.join(functions.ROOT, 'webhooks'));
});

test('serve and stop answer to a unique prefix, and share an ambiguous one', () => {
    assert.strictEqual(cli.resolveToken('se').fn.name, 'serve');
    assert.strictEqual(cli.resolveToken('serv').fn.name, 'serve');
    assert.strictEqual(cli.resolveToken('st').fn.name, 'stop');

    // `s` used to be serve; with stop beside it the CLI must ask rather than guess.
    const ambiguous = cli.resolveToken('s');
    assert.strictEqual(ambiguous.status, 'ambiguous');
    assert.deepStrictEqual(ambiguous.matches, ['serve', 'stop']);
});

test('both service scripts are executable', () => {
    for (const service of Object.values(cli.SERVICE)) {
        assert.doesNotThrow(
            () => fs.accessSync(service.entry, fs.constants.X_OK),
            `${service.name} entry is not executable`
        );
    }
});

test('built-ins and function folders share one namespace', () => {
    assert.strictEqual(cli.resolveToken('help').builtin, 'help');
    assert.strictEqual(cli.resolveToken('recursively-pull-repos').fn.name, 'recursively-pull-repos');

    // A prefix has to be unique across both namespaces, not just within one:
    // `r` starts the built-in `run` and the function `recursively-pull-repos`,
    // `l` starts the built-in `list` and the function `list-weekly-prs`.
    for (const [token, matches] of [
        ['r', ['recursively-pull-repos', 'run']],
        ['l', ['list', 'list-weekly-prs']],
    ]) {
        const result = cli.resolveToken(token);
        assert.strictEqual(result.status, 'ambiguous', `'${token}' should be ambiguous`);
        assert.deepStrictEqual(result.matches, matches);
    }
});

test('an exact built-in name wins over a function it prefixes', () => {
    // `gift list` lists the functions; list-weekly-prs answers to `list-` up.
    assert.strictEqual(cli.resolveToken('list').builtin, 'list');
    assert.strictEqual(cli.resolveToken('list-').fn.name, 'list-weekly-prs');
    assert.strictEqual(cli.resolveToken('list-weekly-prs').fn.name, 'list-weekly-prs');
});

// ------------------------------------------------------------------ picker ---

test('run is a built-in, reachable by name and by prefix', () => {
    assert.strictEqual(cli.resolveToken('run').builtin, 'run');
    assert.strictEqual(cli.resolveToken('ru').builtin, 'run');
    assert.ok(cli.BUILTINS.run, 'run is missing from the built-in list');
});

const menu = [
    { name: 'alpha', description: 'The first one.' },
    { name: 'beta', description: 'The second one.' },
    { name: 'beta-two', description: 'Shares a prefix with beta.' },
];

test('a number picks by position in the list', () => {
    assert.strictEqual(pick.choose('1', menu).fn.name, 'alpha');
    assert.strictEqual(pick.choose(' 3 ', menu).fn.name, 'beta-two');
});

test('a number outside the list is rejected, not clamped', () => {
    for (const answer of ['0', '4', '99']) {
        assert.strictEqual(pick.choose(answer, menu).status, 'invalid', `accepted ${answer}`);
    }
});

test('a name or unique prefix picks too, and an exact name beats a prefix', () => {
    assert.strictEqual(pick.choose('alpha', menu).fn.name, 'alpha');
    assert.strictEqual(pick.choose('al', menu).fn.name, 'alpha');
    // `beta` also prefixes `beta-two`; typing it in full must not be ambiguous.
    assert.strictEqual(pick.choose('beta', menu).fn.name, 'beta');
    assert.strictEqual(pick.choose('beta-', menu).fn.name, 'beta-two');
    assert.strictEqual(pick.choose('bet', menu).status, 'invalid');
    assert.strictEqual(pick.choose('nope', menu).status, 'invalid');
});

test('an empty answer or q backs out', () => {
    for (const answer of ['', '   ', 'q', 'quit']) {
        assert.strictEqual(pick.choose(answer, menu).status, 'cancelled', `${answer} did not quit`);
    }
});

test('the menu shows one line per function, numbered', () => {
    const lines = pick.menuLines(menu);
    assert.strictEqual(lines.length, menu.length);
    assert.match(lines[0], /^ {2}1 {2}alpha {2,}The first one\.$/);
    assert.match(lines[2], /^ {2}3 {2}beta-two/);
});

test('gift run needs a terminal to ask in', async () => {
    const wasTTY = process.stdin.isTTY;
    try {
        process.stdin.isTTY = false;
        assert.strictEqual((await pick.pick()).status, 'no-tty');
    } finally {
        process.stdin.isTTY = wasTTY;
    }
});

test('the removed completion built-ins are gone', () => {
    for (const name of ['completion', 'commands']) {
        assert.strictEqual(
            cli.resolveToken(name).status,
            'unknown',
            `${name} should no longer resolve`
        );
    }
    assert.ok(!fs.existsSync(path.join(functions.ROOT, 'completions')), 'completions/ still exists');
});

test('an ambiguous prefix lists the candidates', () => {
    const dirs = ['zz-test-alpha', 'zz-test-beta'].map((n) =>
        path.join(functions.FUNCTIONS_DIR, n)
    );
    try {
        for (const dir of dirs) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'main.sh'), '#!/bin/bash\ntrue\n');
        }
        const result = functions.resolve('zz-test');
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

test('a function folder can bring its own .env, and the environment still wins', () => {
    const dir = path.join(functions.FUNCTIONS_DIR, 'zz-test-env');
    const keys = ['ZZ_OWN', 'ZZ_FROM_ENV'];
    const before = keys.map((k) => [k, process.env[k]]);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.env'),
            'ZZ_OWN=from-function\nZZ_FROM_ENV=from-function\n'
        );

        for (const k of keys) delete process.env[k];
        process.env.ZZ_FROM_ENV = 'from-environment';

        env.loadFor(dir);
        assert.strictEqual(process.env.ZZ_OWN, 'from-function');
        assert.strictEqual(process.env.ZZ_FROM_ENV, 'from-environment');

        // Without a function folder, nothing from that folder is read.
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

test('the file loaded first wins — how the function .env beats the shared one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-env-'));
    const before = process.env.ZZ_LAYERED;
    try {
        const own = path.join(dir, 'own.env');
        const shared = path.join(dir, 'shared.env');
        fs.writeFileSync(own, 'ZZ_LAYERED=own\n');
        fs.writeFileSync(shared, 'ZZ_LAYERED=shared\n');

        delete process.env.ZZ_LAYERED;
        env.load(own); // the function's, loaded first
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
