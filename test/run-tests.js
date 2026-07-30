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
const hookCommand = require('../lib/hook.js');
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

// --------------------------------------------------------------- hooks.log ---

/** Send the server's log to a throwaway file, and put it back afterwards. */
async function withLog(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-log-'));
    const file = path.join(dir, 'hooks.log');
    server.openLog(file);
    try {
        await fn(file);
    } finally {
        server.openLog(null); // back to the console, so no other test writes a file
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('the log records every request, its verdict and what ran', () =>
    withLog(async (file) => {
        await withServer(async (base) => {
            await fetch(`${base}/health`);
            await fetch(`${base}/nope`);
            await post(base, 'push', pushPayload, { secret: 'wrong' });
            await post(base, 'push', pushPayload);
        });

        const log = fs.readFileSync(file, 'utf8');
        assert.match(log, /request to an unknown path.*status=404.*path=\/nope/);
        assert.match(log, /invalid signature.*status=401/);
        assert.match(log, /delivery received.*event=push.*signed=yes/);
        assert.match(log, /delivery accepted.*repo=owner\/repo.*branch=main.*sender=someone/);
        assert.match(log, /hooks matched.*status=202.*hooks=deploy/);
        assert.match(log, /dry run, not executing.*hook=deploy.*run=\/bin\/echo/);
        // Uptime checks are deliberately left out; they would bury the deliveries.
        assert.ok(!log.includes('/health'), 'health checks should not be logged');
    }));

test('the log file is private, and a full one rotates to .log.1', () =>
    withLog(async (file) => {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

        // Hand the server a log that is already at the 5 MB limit, so the next
        // line has to rotate it.
        fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024) + '\n');
        server.openLog(file);
        await withServer(async (base) => {
            await fetch(`${base}/nope`);
        });

        assert.ok(fs.existsSync(`${file}.1`), 'the old log was not kept as .log.1');
        assert.match(fs.readFileSync(file, 'utf8'), /request to an unknown path/);
        assert.ok(fs.statSync(file).size < 1024, 'the live log was not started fresh');
    }));

test('a log that cannot be written is warned about, not fatal', () =>
    withLog(async (file) => {
        // A regular file where a directory would have to be: nothing can be
        // created under it, so opening the log fails.
        const blocker = path.join(path.dirname(file), 'blocker');
        fs.writeFileSync(blocker, '');

        const warnings = [];
        const realError = console.error;
        console.error = (line) => warnings.push(String(line));
        try {
            server.openLog(path.join(blocker, 'hooks.log'));
            await withServer(async (base) => {
                assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
                assert.strictEqual((await post(base, 'push', pushPayload)).status, 202);
            });
        } finally {
            console.error = realError;
        }
        assert.ok(
            warnings.some((line) => /cannot open .*hooks\.log/.test(line)),
            'the unwritable log was not reported'
        );
    }));

// ------------------------------------------------------------- gift hook ---

test('hook is a built-in, listed with the server commands', () => {
    assert.strictEqual(cli.resolveToken('hook').builtin, 'hook');
    assert.strictEqual(cli.resolveToken('hoo').builtin, 'hook');
    assert.ok(cli.BUILTINS.hook, 'hook is missing from the built-in list');
    assert.ok(cli.WEBHOOK_NAMES.includes('hook'), 'hook is not listed under the webhooks heading');

    // `h` used to be help; with hook beside it the CLI must ask rather than guess.
    const ambiguous = cli.resolveToken('h');
    assert.strictEqual(ambiguous.status, 'ambiguous');
    assert.deepStrictEqual(ambiguous.matches, ['help', 'hook']);
});

test('a hook command answers to a unique prefix, and list/log share one', () => {
    assert.strictEqual(hookCommand.resolveSubcommand('create').name, 'create');
    assert.strictEqual(hookCommand.resolveSubcommand('cr').name, 'create');
    assert.strictEqual(hookCommand.resolveSubcommand('d').name, 'delete');
    assert.strictEqual(hookCommand.resolveSubcommand('li').name, 'list');
    assert.strictEqual(hookCommand.resolveSubcommand('lo').name, 'log');

    const ambiguous = hookCommand.resolveSubcommand('l');
    assert.strictEqual(ambiguous.status, 'ambiguous');
    assert.deepStrictEqual(ambiguous.matches, ['list', 'log']);
    assert.strictEqual(hookCommand.resolveSubcommand('nope').status, 'unknown');
});

test('a repository is taken from a name, a pair, a URL or an SSH remote', () => {
    for (const typed of [
        'owner/repo',
        'https://github.com/owner/repo',
        'https://github.com/owner/repo.git',
        'git@github.com:owner/repo.git',
        'github.com/owner/repo/',
    ]) {
        assert.deepStrictEqual(hookCommand.parseRepo(typed), { owner: 'owner', name: 'repo' }, typed);
    }
    // An owner on its own leaves the repository still to ask for.
    assert.deepStrictEqual(hookCommand.parseRepo('owner'), { owner: 'owner', name: '' });
});

test('events and branches are split on commas or spaces', () => {
    assert.deepStrictEqual(hookCommand.splitList('push, pull_request'), ['push', 'pull_request']);
    assert.deepStrictEqual(hookCommand.splitList('push pull_request'), ['push', 'pull_request']);
    assert.deepStrictEqual(hookCommand.splitList('  *  '), ['*']);
    assert.deepStrictEqual(hookCommand.splitList(''), []);
});

test('arguments are split like a command line, quotes holding a value together', () => {
    assert.deepStrictEqual(hookCommand.splitArgs('--fast "two words" -v'), ['--fast', 'two words', '-v']);
    assert.deepStrictEqual(hookCommand.splitArgs("'one arg'"), ['one arg']);
    assert.deepStrictEqual(hookCommand.splitArgs(''), []);
});

test('a new hook is named after its repository, without taking a used name', () => {
    assert.strictEqual(hookCommand.defaultName('gift', new Set()), 'deploy-gift');
    assert.strictEqual(hookCommand.defaultName('gift', new Set(['deploy-gift'])), 'deploy-gift-2');
    assert.strictEqual(hookCommand.defaultName('', new Set()), 'hook');
});

test('a hook is picked by position, exact name or unique prefix', () => {
    const hooks = [{ name: 'deploy' }, { name: 'deploy-docs' }, { name: 'test' }];
    assert.strictEqual(hookCommand.resolveHook(hooks, '2').index, 1);
    assert.strictEqual(hookCommand.resolveHook(hooks, 'test').index, 2);
    assert.strictEqual(hookCommand.resolveHook(hooks, 'te').index, 2);
    // An exact name wins over the longer name it prefixes.
    assert.strictEqual(hookCommand.resolveHook(hooks, 'deploy').index, 0);
    assert.strictEqual(hookCommand.resolveHook(hooks, 'deploy-').index, 1);

    assert.strictEqual(hookCommand.resolveHook(hooks, 'dep').status, 'ambiguous');
    assert.strictEqual(hookCommand.resolveHook(hooks, '0').status, 'out-of-range');
    assert.strictEqual(hookCommand.resolveHook(hooks, '4').status, 'out-of-range');
    assert.strictEqual(hookCommand.resolveHook(hooks, 'nope').status, 'unknown');
});

test('hooks.json is written the way it is written by hand', () => {
    const text = hookCommand.stringify({
        port: 3001,
        hooks: [{ name: 'deploy', events: ['push', 'release'], args: [], detach: false }],
    });
    // Arrays of plain values stay on one line; the indent is two spaces.
    assert.match(text, /^ {6}"events": \["push", "release"\],$/m);
    assert.match(text, /^ {6}"args": \[\],$/m);
    assert.match(text, /^ {2}"hooks": \[$/m);
    assert.deepStrictEqual(JSON.parse(text).hooks[0].events, ['push', 'release']);
});

/** A throwaway hooks.json to read and write. */
function withConfig(contents, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-hooks-'));
    const file = path.join(dir, 'hooks.json');
    if (contents !== null) fs.writeFileSync(file, JSON.stringify(contents, null, 2));
    try {
        return fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('a hook needs an absolute .sh script and an absolute working directory', () => {
    const valid = { name: 'test', run: '/opt/gift/webhooks/test-hook.sh', cwd: '/opt/gift/webhooks' };
    const rejected = [
        [{ ...valid, run: 'test-hook.sh' }, /"run" must be an absolute path/],
        [{ ...valid, run: './test-hook.sh' }, /"run" must be an absolute path/],
        [{ ...valid, run: '/bin/echo' }, /"run" must be a \.sh script/],
        [{ ...valid, run: undefined }, /has no "run" script/],
        [{ ...valid, cwd: undefined }, /has no "cwd" working directory/],
        [{ ...valid, cwd: 'webhooks' }, /"cwd" must be an absolute path/],
    ];

    for (const [hook, expected] of rejected) {
        withConfig({ hooks: [hook] }, (file) => {
            assert.throws(() => server.loadConfig(file), expected, `accepted ${JSON.stringify(hook)}`);
            // The hook it is complaining about is named, so the fix is obvious.
            assert.throws(() => server.loadConfig(file), /hook 'test'/);
        });
    }

    withConfig({ hooks: [valid] }, (file) => {
        const [loaded] = server.loadConfig(file).hooks;
        assert.strictEqual(loaded.run, valid.run);
        assert.strictEqual(loaded.cwd, valid.cwd);
    });

    // An absolute path is kept as given, `..` and all, not resolved against
    // webhooks/ the way it used to be.
    withConfig({ hooks: [{ ...valid, run: '/opt/gift/webhooks/../webhooks/test-hook.sh' }] }, (file) => {
        assert.strictEqual(server.loadConfig(file).hooks[0].run, '/opt/gift/webhooks/test-hook.sh');
    });
});

test('a missing hooks.json reads as the defaults, and is not created by reading', () => {
    withConfig(null, (file) => {
        const { config, missing } = hookCommand.readConfig(file);
        assert.strictEqual(missing, true);
        assert.deepStrictEqual(config.hooks, []);
        assert.strictEqual(config.port, 3999);
        assert.ok(!fs.existsSync(file), 'reading created the file');
    });
});

test('a hooks.json that is not JSON, or has no hooks array, is reported', () => {
    withConfig(null, (file) => {
        fs.writeFileSync(file, '{ oops');
        assert.throws(() => hookCommand.readConfig(file), /hooks\.json:/);
        fs.writeFileSync(file, '{"hooks": "deploy"}');
        assert.throws(() => hookCommand.readConfig(file), /"hooks" is not an array/);
    });
});

test('writing a hook back leaves the rest of the file alone', () => {
    const original = {
        host: '127.0.0.1',
        port: 4000,
        path: '/hooks/gh',
        log: 'hooks.log',
        hooks: [
            {
                name: 'test',
                repo: '*',
                events: ['*'],
                branches: ['*'],
                run: '/opt/gift/webhooks/test-hook.sh',
                cwd: '/opt/gift/webhooks',
            },
        ],
    };
    withConfig(original, (file) => {
        const { config } = hookCommand.readConfig(file);
        config.hooks.push({
            name: 'deploy',
            repo: 'owner/repo',
            events: ['push'],
            run: '/opt/app/deploy.sh',
            cwd: '/opt/app',
        });
        hookCommand.writeConfig(file, config);

        const written = hookCommand.readConfig(file).config;
        assert.strictEqual(written.port, 4000, 'the port was lost');
        assert.strictEqual(written.path, '/hooks/gh', 'the path was lost');
        assert.deepStrictEqual(written.hooks.map((h) => h.name), ['test', 'deploy']);
        // The server has to be able to load whatever was written.
        assert.strictEqual(server.loadConfig(file).hooks.length, 2);

        // And deleting one leaves the other untouched.
        written.hooks.splice(0, 1);
        hookCommand.writeConfig(file, written);
        assert.deepStrictEqual(
            hookCommand.readConfig(file).config.hooks.map((h) => h.name),
            ['deploy']
        );
        assert.ok(!fs.existsSync(`${file}.tmp`), 'the temporary file was left behind');
    });
});

test('the log tail returns the last lines, and nothing for a file that is not there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-tail-'));
    try {
        const file = path.join(dir, 'hooks.log');
        fs.writeFileSync(file, `${Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);

        const tail = hookCommand.tail(file, 100);
        assert.strictEqual(tail.total, 250);
        assert.strictEqual(tail.lines.length, 100);
        assert.strictEqual(tail.lines[0], 'line 151');
        assert.strictEqual(tail.lines[99], 'line 250');

        // Asking for more than there is gives everything, not padding.
        assert.strictEqual(hookCommand.tail(file, 400).lines.length, 250);
        assert.strictEqual(hookCommand.tail(path.join(dir, 'nothing.log'), 100), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('gift hook create needs a terminal to ask in', async () => {
    const wasTTY = process.stdin.isTTY;
    const realError = console.error;
    const lines = [];
    try {
        process.stdin.isTTY = false;
        console.error = (line) => lines.push(String(line));
        assert.strictEqual(await hookCommand.main(['create']), 2);
    } finally {
        console.error = realError;
        process.stdin.isTTY = wasTTY;
    }
    assert.ok(lines.some((line) => /needs a terminal/.test(line)), 'no terminal was not reported');
});

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
