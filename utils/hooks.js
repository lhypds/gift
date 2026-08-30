// The implementation shared by the top-level hook-management commands.
//
//   gift list            show what is configured
//   gift create          add one, asking what should trigger it and what to run
//   gift delete [name]   remove one
//
// All three work on hooks.json — the file `gift serve` reads at startup
// (--config=FILE, or GIFT_SERVE_CONFIG, points them somewhere else). The server
// only reads it when it starts, so create and delete restart the server after
// writing a change. What the server then writes is read by `gift log`.
//
// `create` asks two sorts of question. What should trigger the hook belongs to
// the trigger — a repository and its branches, a URL and how often to poll, a
// folder and a pattern — so the trigger module asks those, and nothing in here
// knows what they are. What to run is the same for every type, and is asked here.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT } = require('../functions.js');
const { ask } = require('./pick.js');
const { SERVER_DIR } = require('./service.js');
const hookRecord = require('./hook.js');
const triggers = require('../triggers/index.js');
const gh = require('../triggers/github/gh.js');

const DEFAULT_CONFIG = path.join(SERVER_DIR, 'hooks.json');

// What a freshly created hooks.json is seeded with — the same defaults the
// server falls back to, written out so the file is a complete picture.
const DEFAULT_SETTINGS = {
    host: '127.0.0.1',
    port: 3999,
    path: '/hooks/github',
    log: 'hooks.log',
};

const VALID_HOOK_NAME = /^[A-Za-z0-9._-]+$/;

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
 * warns about at startup, so they surface before anything fires.
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

/** Restart the PM2 process after hooks.json changes, using the normal start path. */
function restartServer(run = spawnSync) {
    const script = path.join(SERVER_DIR, 'start.sh');
    const result = run('bash', [script], { cwd: SERVER_DIR, stdio: 'inherit' });

    if (result.error) {
        return { ok: false, message: result.error.code === 'ENOENT' ? 'bash is not installed' : result.error.message };
    }
    if (result.status !== 0) {
        return { ok: false, message: `start.sh exited ${result.status === null ? 'without a status' : result.status}` };
    }
    return { ok: true };
}

// ------------------------------------------------------------------ display ---

/**
 * The rows shown for one hook, by `list` and by the confirmation in `create`.
 * `run` and `cwd` are resolved against the project root — where the server
 * resolves them from, wherever the configuration file itself is.
 */
function describe(hook) {
    return hookRecord.describe(hook, {
        resolve: (target) => show(path.resolve(SERVER_DIR, target)),
        notes: (run) => scriptNotes(path.resolve(SERVER_DIR, run)),
    });
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

    const exact = [];
    hooks.forEach((hook, index) => {
        if (String(hook.name) === text) exact.push(index);
    });
    if (exact.length === 1) return { status: 'ok', index: exact[0] };
    if (exact.length > 1) {
        return { status: 'ambiguous', matches: exact.map((i) => String(hooks[i].name)) };
    }

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

/**
 * The first question `gift create` asks: what should set this hook off. Every
 * later question follows from the answer, which is why it comes before the
 * hook's own name — a file hook and a webhook have almost nothing else in
 * common.
 */
async function pickTrigger() {
    const available = triggers.list();
    const width = Math.max(...available.map((trigger) => trigger.title.length));

    console.log('What should trigger this hook?');
    console.log('');
    available.forEach((trigger, index) => {
        console.log(`  ${index + 1}  ${trigger.title.padEnd(width)}  ${trigger.summary}`);
    });
    console.log('');

    for (; ;) {
        const answer = await ask(`Trigger [1-${available.length}], or q to quit: `);
        if (answer === null) return null;

        const token = answer.trim().toLowerCase();
        if (token === '' || token === 'q' || token === 'quit') return null;

        if (/^\d+$/.test(token)) {
            const index = Number(token) - 1;
            if (index >= 0 && index < available.length) return available[index];
            console.log(`There is no ${token} in the list — pick 1 to ${available.length}.`);
            continue;
        }

        // A name, or enough of one: `gift create` then `cl` is the clipboard.
        const matched = available.filter((trigger) => trigger.name.startsWith(token));
        if (matched.length === 1) return matched[0];
        if (matched.length > 1) {
            console.log(`'${token}' matches ${matched.map((t) => t.name).join(' and ')} — type more of the name.`);
        } else {
            console.log(`No trigger called '${token}'.`);
        }
    }
}

// -------------------------------------------------------------------- list ---

function listHooks(file) {
    const { config, missing } = readConfig(file);
    if (missing) {
        console.error(`gift list: no ${show(file)}`);
        console.error('Run `gift create` to write one.');
        return 1;
    }

    const hooks = config.hooks;
    if (hooks.length === 0) {
        console.log(`${show(file)} configures no hooks.`);
        console.log('Run `gift create` to add one.');
        return 0;
    }

    console.log(`${show(file)}`);
    const numberWidth = String(hooks.length).length;
    hooks.forEach((hook, index) => {
        console.log('');
        console.log(`  ${String(index + 1).padStart(numberWidth)}  ${hook.name || `hook-${index + 1}`}`);
        printRows(describe(hook), `  ${' '.repeat(numberWidth)}    `);
    });

    // Counted by type: which triggers are in use is the thing worth knowing at
    // a glance, and the endpoint only matters when something delivers to it.
    const counts = new Map();
    for (const hook of hooks) {
        const type = hookRecord.typeOf(hook);
        counts.set(type, (counts.get(type) || 0) + 1);
    }
    const byType = [...counts].map(([type, count]) => `${count} ${type}`).join(', ');

    console.log('');
    console.log(`${hooks.length} hook${hooks.length === 1 ? '' : 's'} — ${byType}.`);
    if (counts.has('github')) {
        const endpoint = [
            `${config.host || DEFAULT_SETTINGS.host}:${config.port || DEFAULT_SETTINGS.port}`,
            config.path || DEFAULT_SETTINGS.path,
        ].join('');
        console.log(`GitHub deliveries are received on ${endpoint}.`);
    }
    return 0;
}

// ------------------------------------------------------------------ create ---

/**
 * A descriptive unused default name for the new hook, out of whatever the
 * trigger called itself: a repository, a URL, a folder.
 */
function defaultName(type, label, taken) {
    let stem = String(label || '')
        .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '');
    stem = stem.split('/').filter(Boolean).pop() || '';
    // `status.json` and `nginx.conf` name the thing watched; the extension is
    // not part of what to call the hook.
    stem = stem.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    stem = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

    const base = stem && stem !== '*' ? `hook-${stem}` : `hook-${type}`;
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
}

async function createHook(file) {
    if (!process.stdin.isTTY) {
        console.error('gift create: a terminal is needed to ask for the hook fields.');
        console.error(`Add the hook to ${show(file)} by hand instead.`);
        return 2;
    }

    const { config, missing } = readConfig(file);
    const taken = new Set(config.hooks.map((hook, index) =>
        String(hook.name || `hook-${index + 1}`)
    ));

    console.log(`Adding a hook to ${show(file)}${missing ? ', which will be created' : ''}.`);
    console.log('First what should trigger it, then what to run when it does.');
    console.log('Enter takes the [default], Ctrl-C stops without writing anything.');
    console.log('');

    const cancelled = () => {
        console.log('Nothing was written.');
        return 130;
    };

    const trigger = await pickTrigger();
    if (trigger === null) return cancelled();
    console.log('');

    // Everything about *what* fires the hook belongs to the trigger. It may
    // also stop outright — the GitHub trigger does, when it was asked to create
    // a webhook it cannot create — which is a stop rather than a warning: a
    // hook that looks configured and never fires is worse than no hook.
    let asked;
    try {
        asked = await trigger.ask({ askText, askYesNo, resolveTyped, show });
    } catch (err) {
        console.log('');
        console.error(`gift create: ${err.message}`);
        return 2;
    }
    if (asked === null) return cancelled();
    console.log('');

    const name = await askText('Hook name — the label it appears under in the log', {
        fallback: defaultName(trigger.name, asked.label, taken),
        validate: (value) => {
            if (!VALID_HOOK_NAME.test(value)) return 'Letters, digits, dot, dash and underscore only.';
            if (taken.has(value)) return `A hook named '${value}' already exists — choose a unique name.`;
            return null;
        },
    });
    if (name === null) return cancelled();

    // Absolute only. A relative path would be resolved against wherever the user
    // happens to be standing, which is not what the hook would run months later.
    const runAnswer = await askText('Script to run — an absolute path to a .sh', {
        validate: (value) => {
            if (!value) return 'A script is needed; it is what the hook runs.';
            if (!path.isAbsolute(expandHome(value))) {
                return 'That path must be absolute, so the hook runs the same script wherever the server was started.';
            }
            if (!value.endsWith('.sh')) return 'The handler is a bash script — the path must end in .sh.';
            return null;
        },
    });
    if (runAnswer === null) return cancelled();
    const run = resolveTyped(runAnswer);
    if (fs.existsSync(run)) {
        try {
            fs.accessSync(run, fs.constants.X_OK);
        } catch {
            console.log(`  warning: ${run} is not executable.`);
            const makeExecutable = await askYesNo('Make it executable now?', false);
            if (makeExecutable === null) return cancelled();
            if (makeExecutable) {
                try {
                    fs.chmodSync(run, fs.statSync(run).mode | 0o111);
                    console.log(`  Made ${run} executable.`);
                } catch (err) {
                    console.error(`  warning: could not make ${run} executable: ${err.message}`);
                }
            }
        }
    } else {
        for (const note of scriptNotes(run)) console.log(`  note: ${note}`);
    }

    const cwdAnswer = await askText('Working directory the script runs in', {
        fallback: path.dirname(run),
    });
    if (cwdAnswer === null) return cancelled();
    const cwd = resolveTyped(cwdAnswer);
    if (!isDirectory(cwd)) console.log(`  note: no directory at ${cwd} yet`);

    // Everything not asked about takes the common answer — no arguments, not
    // detached, on. Field order matches hooks.example.json, so hand-written and
    // generated hooks read the same way.
    const hook = {
        name,
        trigger: asked.trigger,
        run,
        args: [],
        cwd,
        detach: false,
        enabled: true,
    };

    config.hooks.push(hook);
    writeConfig(file, config);

    // Anything the trigger has to do elsewhere — telling GitHub about the
    // webhook — happens now the hook is safely on disk, so a failure out there
    // leaves a hook that can be pointed at a hand-made webhook rather than
    // nothing at all.
    let result = null;
    if (typeof asked.after === 'function') {
        try {
            result = asked.after(hook);
        } catch (err) {
            result = { ok: false, lines: [], warnings: [err.message] };
        }
    }

    console.log('');
    console.log(`Added '${name}' to ${show(file)}.`);
    if (result) {
        for (const line of result.lines) console.log(line);
        for (const warning of result.warnings) console.error(`warning: ${warning}`);
    }
    console.log('');
    console.log(`  ${name}`);
    printRows(describe(hook), '    ');
    console.log('');
    for (const note of (trigger.afterNotes ? trigger.afterNotes(hook) : [])) console.log(note);
    console.log(`Edit ${show(file)} for anything else — see \`gift help ${trigger.name}-trigger\` for the fields.`);
    console.log('');

    const restartResult = restartServer();
    if (!restartResult.ok) {
        console.error(`gift create: the hook was saved, but the server could not be restarted: ${restartResult.message}`);
    }
    return (result && !result.ok) || !restartResult.ok ? 1 : 0;
}

// ------------------------------------------------------------------ delete ---

/** Show the hooks numbered and read a choice; null if the user backs out. */
async function pickHook(hooks) {
    const label = (hook, index) => String(hook.name || `hook-${index + 1}`);
    const numberWidth = String(hooks.length).length;
    const nameWidth = Math.max(...hooks.map((hook, index) => label(hook, index).length));
    const typeWidth = Math.max(...hooks.map((hook) => hookRecord.typeOf(hook).length));

    console.log('hooks:');
    hooks.forEach((hook, index) => {
        const number = String(index + 1).padStart(numberWidth);
        const type = hookRecord.typeOf(hook).padEnd(typeWidth);
        console.log(`  ${number}  ${label(hook, index).padEnd(nameWidth)}  ${type}  ${hookRecord.line(hook)}`);
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
            console.log(`'${token}' matches more than one hook — use its list position.`);
        } else {
            console.log(`No hook called '${token}'.`);
        }
    }
}

async function deleteHook(file, options, positionals) {
    const { config, missing } = readConfig(file);
    if (missing) {
        console.error(`gift delete: no ${show(file)}`);
        return 1;
    }
    if (config.hooks.length === 0) {
        console.error(`gift delete: ${show(file)} configures no hooks.`);
        return 1;
    }

    let index;
    if (positionals.length > 0) {
        const token = positionals[0];
        const result = resolveHook(config.hooks, token);
        if (result.status === 'ambiguous') {
            console.error(`gift delete: '${token}' matches more than one hook:`);
            for (const match of result.matches) console.error(`  ${match}`);
            console.error("Use the hook's list position to pick one.");
            return 2;
        }
        if (result.status === 'out-of-range') {
            console.error(`gift delete: there is no hook ${token} — ${show(file)} has ${config.hooks.length}.`);
            return 2;
        }
        if (result.status !== 'ok') {
            console.error(`gift delete: no hook called '${token}' in ${show(file)}`);
            console.error('Run `gift status` to see the configured hooks.');
            return 2;
        }
        index = result.index;
    } else {
        if (!process.stdin.isTTY) {
            console.error('gift delete: a hook name or a terminal is needed.');
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
            console.error('gift delete: nothing to ask on — pass --yes to delete without confirming.');
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
    // The webhook on GitHub's side, if this was one, is left alone: gift did
    // not necessarily create it, and deleting someone else's webhook because a
    // local hook was tidied away is not a thing to do without being asked.
    if (hookRecord.typeOf(hook) === 'github' && hook.trigger && hook.trigger.repo && hook.trigger.repo !== '*') {
        console.log(`The webhook on ${hook.trigger.repo} is untouched — remove it in Settings > Webhooks if it is now unused.`);
    }
    console.log('');

    const restartResult = restartServer();
    if (!restartResult.ok) {
        console.error(`gift delete: the hook was deleted, but the server could not be restarted: ${restartResult.message}`);
        return 1;
    }
    return 0;
}

// ---------------------------------------------------------------- dispatch ---

function createUsage() {
    console.log('usage: gift create [--config=FILE]');
    console.log('');
    console.log('Create a hook. The first question is what should trigger it:');
    console.log('');
    for (const trigger of triggers.list()) {
        console.log(`  ${trigger.title.padEnd(10)}  ${trigger.summary}`);
    }
    console.log('');
    console.log('The questions that follow are the trigger\'s own — a repository and its');
    console.log('branches, a URL and how often to poll, a folder and a pattern — and then');
    console.log('three that are the same for every type: the hook name, the bash script to');
    console.log('run and the working directory it runs in.');
    console.log('If the script exists but is not executable, create offers to make it so.');
    console.log('');
    console.log('The rest takes the common answer — no arguments, not detached, on. Edit');
    console.log('hooks.json to change them; `gift help <type>-trigger` lists every field.');
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: hooks.json)');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('The server is restarted automatically after the hook is created.');
}

function listUsage() {
    console.log('usage: gift list [--config=FILE]');
    console.log('');
    console.log('List the configured hooks: what triggers each one, and what it runs.');
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: hooks.json)');
    console.log('  -h, --help      Show this help');
}

function deleteUsage() {
    console.log('usage: gift delete [name] [options]');
    console.log('');
    console.log('Delete a hook by name, unique name prefix, or list position.');
    console.log('For hooks with the same name, use the list position.');
    console.log('With no name, choose from a menu.');
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: hooks.json)');
    console.log('  -y, --yes       Delete without asking for confirmation');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('The server is restarted automatically after the hook is deleted.');
    console.log('A GitHub webhook the hook was delivered by is left in place.');
}

function parseArgs(argv, command) {
    const options = { yes: false, help: false };
    const positionals = [];

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '-y' || arg === '--yes') {
            if (command !== 'delete') throw new Error(`unknown option '${arg}' (try: gift create --help)`);
            options.yes = true;
        } else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}' (try: gift ${command} --help)`);
        else positionals.push(arg);
    }
    return { options, positionals };
}

async function createMain(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv, 'create');
    } catch (err) {
        console.error(`gift create: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        createUsage();
        return 0;
    }
    if (positionals.length > 0) {
        console.error(`gift create: '${positionals[0]}' is not expected — create takes no arguments`);
        return 2;
    }

    try {
        return await createHook(configFile(options));
    } catch (err) {
        console.error(`gift create: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

async function listMain(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv, 'list');
    } catch (err) {
        console.error(`gift list: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        listUsage();
        return 0;
    }
    if (positionals.length > 0) {
        console.error(`gift list: '${positionals[0]}' is not expected — list takes no arguments`);
        return 2;
    }

    try {
        return listHooks(configFile(options));
    } catch (err) {
        console.error(`gift list: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

async function deleteMain(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv, 'delete');
    } catch (err) {
        console.error(`gift delete: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        deleteUsage();
        return 0;
    }
    if (positionals.length > 1) {
        console.error(`gift delete: '${positionals[1]}' is not expected — pass at most one hook name`);
        return 2;
    }

    try {
        return await deleteHook(configFile(options), options, positionals);
    } catch (err) {
        console.error(`gift delete: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

module.exports = {
    createMain,
    createUsage,
    deleteMain,
    deleteUsage,
    listMain,
    listUsage,
    restartServer,
    // Configuration and path helpers shared with `gift log` and `gift status`.
    readConfig,
    writeConfig,
    configFile,
    describe,
    printRows,
    show,
    expandHome,
    resolveTyped,
    defaultName,
    // The gh integration moved into the GitHub trigger; re-exported here so
    // anything that reached for it by this name still finds it.
    createGitHubWebhook: gh.createGitHubWebhook,
    readGitHubWebhooks: gh.readGitHubWebhooks,
    verifyGitHubWebhook: gh.verifyGitHubWebhook,
    ghAuthProblem: gh.ghAuthProblem,
    webhookUrlProblem: gh.webhookUrlProblem,
};
