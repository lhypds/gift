// `gift hook` — the hooks the webhook server runs, from the command line.
//
//   gift hook list            what is configured right now
//   gift hook create          add one, asking for each field
//   gift hook delete [name]   remove one
//
// All three work on webhooks/hooks.json — the file `gift serve` reads at startup
// (--config=FILE, or GIFT_SERVE_CONFIG, points them somewhere else). The server
// only reads it when it starts, so a change here takes effect on the next
// `gift serve`. What the server then writes is read by `gift log`.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ROOT } = require('../functions.js');
const { ask } = require('../utils/pick.js');
const { WEBHOOK_DIR } = require('../utils/service.js');

const DEFAULT_CONFIG = path.join(WEBHOOK_DIR, 'hooks.json');

// What a freshly created hooks.json is seeded with — the same defaults the
// server falls back to, written out so the file is a complete picture.
const DEFAULT_SETTINGS = {
    host: '127.0.0.1',
    port: 3999,
    path: '/hooks/github',
    log: 'hooks.log',
};

const DEFAULT_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';

const VALID_REPO_PART = /^[A-Za-z0-9._-]+$/;
const VALID_HOOK_NAME = /^[A-Za-z0-9._-]+$/;
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SUBCOMMANDS = {
    list: 'Show the configured hooks.',
    create: 'Add a hook, asking for each field.',
    delete: 'Remove a hook.',
};

// -------------------------------------------------------------------- paths ---

/** Shorten a path for printing: relative to the repo when it is inside it. */
function show(target) {
    const inside = path.relative(ROOT, target);
    return inside && !inside.startsWith('..') ? inside : target;
}

function expandHome(target) {
    if (target === '~') return os.homedir();
    return target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
}

/** Resolve a path the user typed: `~` expanded, relative to where they stand. */
function resolveTyped(target) {
    return path.resolve(process.cwd(), expandHome(target));
}

function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/**
 * What is worth saying about a hook's script — the same two things the server
 * warns about at startup, so they surface before a delivery arrives.
 */
function scriptNotes(run) {
    if (!fs.existsSync(run)) return [`no file at ${run} yet`];
    try {
        fs.accessSync(run, fs.constants.X_OK);
    } catch {
        return [`${run} is not executable — chmod +x it`];
    }
    return [];
}

// ------------------------------------------------------------------- config ---

/**
 * Read hooks.json as it is written, without normalising anything: what is read
 * here is written back, so editing one hook leaves the rest of the file alone.
 *
 * @returns {{config: object, missing: boolean}}
 */
function readConfig(file) {
    if (!fs.existsSync(file)) {
        return { config: { ...DEFAULT_SETTINGS, hooks: [] }, missing: true };
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`${show(file)}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${show(file)}: expected a JSON object`);
    }
    if (parsed.hooks === undefined) parsed.hooks = [];
    if (!Array.isArray(parsed.hooks)) throw new Error(`${show(file)}: "hooks" is not an array`);

    return { config: parsed, missing: false };
}

function isPrimitive(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * JSON in the shape hooks.json is written by hand: a two-space indent, with
 * arrays of plain values kept on one line — `"events": ["push"]` — so a hook
 * stays readable as a block. JSON.stringify would break every array open.
 */
function stringify(value, indent = '') {
    if (Array.isArray(value)) {
        if (value.every(isPrimitive)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
        const inner = `${indent}  `;
        const items = value.map((v) => inner + stringify(v, inner));
        return `[\n${items.join(',\n')}\n${indent}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (entries.length === 0) return '{}';
        const inner = `${indent}  `;
        const lines = entries.map(([key, v]) => `${inner}${JSON.stringify(key)}: ${stringify(v, inner)}`);
        return `{\n${lines.join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(value);
}

/** Write the config through a temporary file, so a failure cannot truncate it. */
function writeConfig(file, config) {
    let mode = 0o644;
    try {
        mode = fs.statSync(file).mode & 0o777;
    } catch {
        /* new file — keep the default */
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${stringify(config)}\n`, { mode });
    fs.renameSync(temp, file);
}

function configFile(options) {
    return path.resolve(options.config || process.env.GIFT_SERVE_CONFIG || DEFAULT_CONFIG);
}

// ------------------------------------------------------------------- fields ---

/** Split a typed list — `push, pull_request` or `push pull_request`. */
function splitList(text) {
    return String(text)
        .split(/[\s,]+/)
        .filter(Boolean);
}

/** Split a typed argument line into arguments, honouring simple quoting. */
function splitArgs(text) {
    const args = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    while ((match = pattern.exec(String(text))) !== null) {
        args.push(match[1] ?? match[2] ?? match[3]);
    }
    return args;
}

/**
 * Pull the owner and repository out of whatever the user pasted: `owner`,
 * `owner/repo`, an HTTPS URL, or an SSH remote.
 */
function parseRepo(text) {
    let value = String(text).trim();
    value = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, ''); // https://
    value = value.replace(/^[^@/\s]+@([^:/\s]+):/, ''); // git@github.com:
    value = value.replace(/\.git$/i, '');
    value = value.replace(/^\/+|\/+$/g, '');

    const parts = value.split('/').filter(Boolean);
    // A first segment with a dot in it is the host, not the owner.
    if (parts.length > 1 && parts[0].includes('.')) parts.shift();

    return { owner: parts[0] || '', name: parts[1] || '' };
}

/**
 * The rows shown for one hook, by `list` and by the confirmation in `create`.
 * `run` and `cwd` are resolved against webhooks/ — where the server resolves
 * them from, wherever the configuration file itself is.
 */
function describe(hook) {
    const events = Array.isArray(hook.events) && hook.events.length ? hook.events : ['push'];
    const branches = Array.isArray(hook.branches) ? hook.branches : [];
    const run = hook.run ? path.resolve(WEBHOOK_DIR, expandHome(String(hook.run))) : '';

    const rows = [
        ['repo', hook.repo || '*'],
        ['events', events.join(', ')],
        ['branches', branches.length ? branches.join(', ') : 'any'],
        ['run', run ? show(run) : '(none — this hook cannot run)'],
    ];
    if (Array.isArray(hook.args) && hook.args.length) {
        // Quoted the way it would be typed, so an argument with a space in it
        // does not read as two.
        rows.push(['args', hook.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')]);
    }
    rows.push([
        'cwd',
        hook.cwd
            ? show(path.resolve(WEBHOOK_DIR, expandHome(String(hook.cwd))))
            : run
                ? `${show(path.dirname(run))} (the script's folder)`
                : "(the script's folder)",
    ]);
    if (hook.detach) rows.push(['detach', 'yes']);
    if (hook.secretEnv && hook.secretEnv !== DEFAULT_SECRET_ENV) rows.push(['secret', hook.secretEnv]);
    if (run) for (const note of scriptNotes(run)) rows.push(['note', note]);
    return rows;
}

function printRows(rows, indent = '     ') {
    const width = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
        console.log(`${indent}${label.padEnd(width)}  ${value}`);
    }
}

/**
 * Resolve what the user typed to a hook: a position in the list, an exact name,
 * or enough of one — the same rule the rest of the CLI follows.
 *
 * @returns {{status: 'ok', index: number} | {status: 'unknown'}
 *          | {status: 'out-of-range'} | {status: 'ambiguous', matches: string[]}}
 */
function resolveHook(hooks, token) {
    const text = String(token).trim();

    if (/^\d+$/.test(text)) {
        const index = Number(text) - 1;
        if (index < 0 || index >= hooks.length) return { status: 'out-of-range' };
        return { status: 'ok', index };
    }

    const exact = hooks.findIndex((h) => String(h.name) === text);
    if (exact >= 0) return { status: 'ok', index: exact };

    const matches = [];
    hooks.forEach((hook, index) => {
        if (String(hook.name).startsWith(text)) matches.push(index);
    });
    if (matches.length === 1) return { status: 'ok', index: matches[0] };
    if (matches.length > 1) {
        return { status: 'ambiguous', matches: matches.map((i) => String(hooks[i].name)) };
    }
    return { status: 'unknown' };
}

// ------------------------------------------------------------------ asking ---

/**
 * Ask for one field. Enter takes the default; validate() returns a message to
 * show and ask again, or null to accept. Resolves null if the user gave up.
 */
async function askText(question, { fallback = '', validate } = {}) {
    for (; ;) {
        const answer = await ask(fallback ? `${question} [${fallback}]: ` : `${question}: `);
        if (answer === null) return null;

        const value = answer.trim() || fallback;
        const problem = validate ? validate(value) : null;
        if (problem) {
            console.log(problem);
            continue;
        }
        return value;
    }
}

async function askYesNo(question, fallback) {
    for (; ;) {
        const answer = await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `);
        if (answer === null) return null;

        const value = answer.trim().toLowerCase();
        if (value === '') return fallback;
        if (['y', 'yes'].includes(value)) return true;
        if (['n', 'no'].includes(value)) return false;
        console.log('Answer y or n.');
    }
}

// -------------------------------------------------------------------- list ---

function printList(file) {
    const { config, missing } = readConfig(file);
    if (missing) {
        console.error(`gift hook: no ${show(file)}`);
        console.error('Run `gift hook create` to write one.');
        return 1;
    }

    const hooks = config.hooks;
    if (hooks.length === 0) {
        console.log(`${show(file)} configures no hooks.`);
        console.log('Run `gift hook create` to add one.');
        return 0;
    }

    console.log(`${show(file)}`);
    const numberWidth = String(hooks.length).length;
    hooks.forEach((hook, index) => {
        console.log('');
        console.log(`  ${String(index + 1).padStart(numberWidth)}  ${hook.name || `hook-${index + 1}`}`);
        printRows(describe(hook), `  ${' '.repeat(numberWidth)}    `);
    });

    console.log('');
    const settings = [
        `${config.host || DEFAULT_SETTINGS.host}:${config.port || DEFAULT_SETTINGS.port}`,
        config.path || DEFAULT_SETTINGS.path,
    ].join('');
    console.log(`${hooks.length} hook${hooks.length === 1 ? '' : 's'}, served on ${settings}.`);
    return 0;
}

// ------------------------------------------------------------------ create ---

/** A name for the new hook that says what it is and is not taken yet. */
function defaultName(repoName, taken) {
    const base = repoName ? `hook-${repoName.toLowerCase()}` : 'hook';
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
}

async function createHook(file) {
    if (!process.stdin.isTTY) {
        console.error('gift hook: `create` needs a terminal to ask in.');
        console.error(`Add the hook to ${show(file)} by hand instead.`);
        return 2;
    }

    const { config, missing } = readConfig(file);
    const taken = new Set(config.hooks.map((h) => String(h.name)));

    console.log(`Adding a hook to ${show(file)}${missing ? ', which will be created' : ''}.`);
    console.log('Enter takes the [default]; Ctrl-C stops without writing anything.');
    console.log('');

    const cancelled = () => {
        console.log('Nothing was written.');
        return 130;
    };

    // Which repository may trigger it. The server compares `owner/repo` whole,
    // so it is either one repository or `*` — an owner on its own cannot match.
    const owner = await askText('Repository owner — GitHub user or organisation, * for any', {
        fallback: '*',
        validate: (value) => {
            if (value === '*') return null;
            const parsed = parseRepo(value);
            if (!parsed.owner) return 'Type the owner as it appears in the repository URL.';
            if (!VALID_REPO_PART.test(parsed.owner)) return `'${parsed.owner}' is not a GitHub owner name.`;
            if (parsed.name && !VALID_REPO_PART.test(parsed.name)) {
                return `'${parsed.name}' is not a repository name.`;
            }
            return null;
        },
    });
    if (owner === null) return cancelled();

    let repo = '*';
    if (owner !== '*') {
        const parsed = parseRepo(owner);
        let name = parsed.name;
        if (!name) {
            // `owner/repo` pasted in one go already answered this.
            const answer = await askText(`Repository name — the part after ${parsed.owner}/`, {
                validate: (value) => {
                    if (!value) return 'A repository name is needed. Answer * to the owner for any repository.';
                    if (!VALID_REPO_PART.test(value)) return `'${value}' is not a repository name.`;
                    return null;
                },
            });
            if (answer === null) return cancelled();
            name = answer;
        }
        repo = `${parsed.owner}/${name}`;
    }

    const name = await askText('Hook name — the label it appears under in the log', {
        fallback: defaultName(repo === '*' ? '' : repo.split('/')[1], taken),
        validate: (value) => {
            if (!VALID_HOOK_NAME.test(value)) return 'Letters, digits, dot, dash and underscore only.';
            if (taken.has(value)) return `${show(file)} already has a hook called '${value}'.`;
            return null;
        },
    });
    if (name === null) return cancelled();

    const eventsAnswer = await askText('Events — e.g. push, pull_request, release; * for any', {
        fallback: 'push',
        validate: (value) => (splitList(value).length ? null : 'Name at least one event, or * for any.'),
    });
    if (eventsAnswer === null) return cancelled();
    const events = splitList(eventsAnswer);

    // Branches only narrow pushes; for other events the field is ignored.
    const pushes = events.includes('*') || events.includes('push');
    const branchesAnswer = await askText('Branches for push events — * for any', {
        fallback: pushes ? 'main' : '*',
        validate: (value) => (splitList(value).length ? null : 'Name at least one branch, or * for any.'),
    });
    if (branchesAnswer === null) return cancelled();
    const branches = splitList(branchesAnswer);

    // Absolute only. A relative path would be resolved against wherever the user
    // happens to be standing, which is not what the hook would run months later.
    const runAnswer = await askText('Script to run — an absolute path', {
        validate: (value) => {
            if (!value) return 'A script is needed; it is what the hook runs.';
            if (!path.isAbsolute(expandHome(value))) {
                return 'That path must be absolute, so the hook runs the same script wherever the server was started.';
            }
            return null;
        },
    });
    if (runAnswer === null) return cancelled();
    const run = resolveTyped(runAnswer);
    for (const note of scriptNotes(run)) console.log(`  note: ${note}`);

    const argsAnswer = await askText('Arguments for the script — blank for none');
    if (argsAnswer === null) return cancelled();
    const args = splitArgs(argsAnswer);

    const cwdAnswer = await askText('Working directory the script runs in', {
        fallback: path.dirname(run),
    });
    if (cwdAnswer === null) return cancelled();
    const cwd = resolveTyped(cwdAnswer);
    if (!isDirectory(cwd)) console.log(`  note: no directory at ${cwd} yet`);

    const detach = await askYesNo('Let the script keep running if the server stops (detach)?', false);
    if (detach === null) return cancelled();

    const secretEnv = await askText('Environment variable holding this hook\'s webhook secret', {
        fallback: DEFAULT_SECRET_ENV,
        validate: (value) => (VALID_ENV_NAME.test(value) ? null : 'That is not an environment variable name.'),
    });
    if (secretEnv === null) return cancelled();

    // Field order matches hooks.example.json, so hand-written and generated
    // hooks read the same way.
    const hook = { name, repo, events, branches, run, args, cwd, detach, secretEnv };

    console.log('');
    console.log(`  ${name}`);
    printRows(describe(hook), '    ');
    console.log('');

    const confirmed = await askYesNo(`Add this hook to ${show(file)}?`, true);
    if (confirmed === null) return cancelled();
    if (!confirmed) {
        console.log('Nothing was written.');
        return 0;
    }

    config.hooks.push(hook);
    writeConfig(file, config);

    console.log('');
    console.log(`Added '${name}' to ${show(file)}.`);
    if (!process.env[secretEnv]) {
        console.log(`warning: ${secretEnv} is not set — the server refuses to start without a secret.`);
        console.log(`         Put it in webhooks/.env, the same value as the webhook's Secret on GitHub.`);
    }
    console.log('Run `gift serve` to restart the server with it.');
    return 0;
}

// ------------------------------------------------------------------ delete ---

/** Show the hooks numbered and read a choice; null if the user backs out. */
async function pickHook(hooks) {
    const label = (hook, index) => String(hook.name || `hook-${index + 1}`);
    const numberWidth = String(hooks.length).length;
    const nameWidth = Math.max(...hooks.map((hook, index) => label(hook, index).length));
    const repoWidth = Math.max(...hooks.map((h) => String(h.repo || '*').length));

    console.log('hooks:');
    hooks.forEach((hook, index) => {
        const number = String(index + 1).padStart(numberWidth);
        const events = (Array.isArray(hook.events) && hook.events.length ? hook.events : ['push']).join('|');
        const repo = String(hook.repo || '*').padEnd(repoWidth);
        console.log(`  ${number}  ${label(hook, index).padEnd(nameWidth)}  ${repo}  ${events}`);
    });
    console.log('');

    for (; ;) {
        const answer = await ask(`Delete which hook [1-${hooks.length}], or q to quit: `);
        if (answer === null) return null;

        const token = answer.trim();
        if (token === '' || token === 'q' || token === 'quit') return null;

        const result = resolveHook(hooks, token);
        if (result.status === 'ok') return result.index;
        if (result.status === 'out-of-range') {
            console.log(`There is no ${token} in the list — pick 1 to ${hooks.length}.`);
        } else if (result.status === 'ambiguous') {
            console.log(`'${token}' matches ${result.matches.join(', ')} — type more of the name.`);
        } else {
            console.log(`No hook called '${token}'.`);
        }
    }
}

async function deleteHook(file, options, positionals) {
    const { config, missing } = readConfig(file);
    if (missing) {
        console.error(`gift hook: no ${show(file)}`);
        return 1;
    }
    if (config.hooks.length === 0) {
        console.error(`gift hook: ${show(file)} configures no hooks.`);
        return 1;
    }

    let index;
    if (positionals.length > 0) {
        const token = positionals[0];
        const result = resolveHook(config.hooks, token);
        if (result.status === 'ambiguous') {
            console.error(`gift hook: '${token}' matches more than one hook:`);
            for (const match of result.matches) console.error(`  ${match}`);
            console.error('Type more of the name to pick one.');
            return 2;
        }
        if (result.status === 'out-of-range') {
            console.error(`gift hook: there is no hook ${token} — ${show(file)} has ${config.hooks.length}.`);
            return 2;
        }
        if (result.status !== 'ok') {
            console.error(`gift hook: no hook called '${token}' in ${show(file)}`);
            console.error('Run `gift hook list` to see them.');
            return 2;
        }
        index = result.index;
    } else {
        if (!process.stdin.isTTY) {
            console.error('gift hook: `delete` needs a hook name, or a terminal to ask in.');
            return 2;
        }
        index = await pickHook(config.hooks);
        if (index === null) {
            console.log('Nothing was deleted.');
            return 130;
        }
    }

    const hook = config.hooks[index];
    const name = String(hook.name || `hook-${index + 1}`);

    if (!options.yes) {
        if (!process.stdin.isTTY) {
            console.error('gift hook: nothing to ask on — pass --yes to delete without confirming.');
            return 2;
        }
        console.log('');
        console.log(`  ${name}`);
        printRows(describe(hook), '    ');
        console.log('');
        const confirmed = await askYesNo(`Delete '${name}' from ${show(file)}?`, false);
        if (!confirmed) {
            console.log('Nothing was deleted.');
            return confirmed === null ? 130 : 0;
        }
    }

    config.hooks.splice(index, 1);
    writeConfig(file, config);

    console.log(`Deleted '${name}' from ${show(file)}.`);
    console.log('Run `gift serve` to restart the server without it.');
    return 0;
}

// ---------------------------------------------------------------- dispatch ---

function usage() {
    const width = Math.max(...Object.keys(SUBCOMMANDS).map((n) => n.length)) + 8;
    const line = (name, description) => console.log(`  ${name.padEnd(width)}  ${description}`);

    console.log('usage: gift hook <command>');
    console.log('');
    console.log('commands:');
    line('list', SUBCOMMANDS.list);
    line('create', SUBCOMMANDS.create);
    line('delete [name]', SUBCOMMANDS.delete);
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: webhooks/hooks.json)');
    console.log('  -y, --yes       Delete without asking for confirmation');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('Hooks live in webhooks/hooks.json, which the server reads at startup, so');
    console.log('run `gift serve` after adding or deleting one. A command name can be');
    console.log('shortened to any unique prefix: `gift hook cr`, `gift hook li`.');
    console.log('');
    console.log('`gift log` prints the tail of what the server writes.');
}

function parseArgs(argv) {
    const options = { yes: false, help: false };
    const positionals = [];

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '-y' || arg === '--yes') options.yes = true;
        else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}' (try: gift hook --help)`);
        else positionals.push(arg);
    }
    return { options, positionals };
}

/** Exact name, or any unique prefix of one — as everywhere else in the CLI. */
function resolveSubcommand(token) {
    if (SUBCOMMANDS[token]) return { status: 'ok', name: token };

    const matches = Object.keys(SUBCOMMANDS).filter((name) => name.startsWith(token));
    if (matches.length === 1) return { status: 'ok', name: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', matches: matches.sort() };
    return { status: 'unknown' };
}

async function main(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    } catch (err) {
        console.error(`gift hook: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        usage();
        return 0;
    }

    const [token, ...rest] = positionals;
    if (!token) {
        usage();
        return 1;
    }

    const command = resolveSubcommand(token);
    if (command.status === 'ambiguous') {
        console.error(`gift hook: '${token}' matches more than one command:`);
        for (const match of command.matches) console.error(`  ${match}`);
        console.error('Type more of the name to pick one.');
        return 2;
    }
    if (command.status !== 'ok') {
        console.error(`gift hook: unknown command '${token}'`);
        console.error('Run `gift hook --help` to see the commands.');
        return 2;
    }

    const file = configFile(options);
    try {
        switch (command.name) {
            case 'list':
                return printList(file);
            case 'create':
                return await createHook(file);
            case 'delete':
                return await deleteHook(file, options, rest);
            default:
                return 2;
        }
    } catch (err) {
        console.error(`gift hook: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

module.exports = {
    main,
    usage,
    // Configuration and path helpers shared with `gift log` and `gift status`.
    readConfig,
    configFile,
    show,
    expandHome,
};
