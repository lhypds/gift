// gift CLI dispatcher.
//
// Usage: gift <function> [args...]
//
// <function> is the name of a folder in functions/ — or `serve`, `stop`, `status`,
// `hook` and `log`, which drive the webhooks server in webhooks/ — or any prefix.
// `gift recur` runs recursively-pull-repos, `gift se` runs serve. Everything
// after the name is forwarded to its entry script untouched. `gift run` asks
// instead: it prints the function list and runs whichever one is picked.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const functions = require('./functions.js');
const env = require('./utils/env.js');
const hook = require('./commands/hook.js');
const log = require('./commands/log.js');
const status = require('./commands/status.js');
const update = require('./commands/update.js');
const { pick } = require('./utils/pick.js');
const { runFunction } = require('./commands/run.js');
// `serve` and `stop` are scripts in webhooks/ rather than function folders, so
// service.js names them; `gift update` restarts a running server through the same
// definitions.
const { SERVE, STOP, SERVICE, WEBHOOK_DIR } = require('./utils/service.js');
const { version } = require('./commands/version.js');

// Everything the CLI answers itself, rather than by running a function folder.
const BUILTINS = {
    serve: SERVE.description,
    stop: STOP.description,
    status: 'Report whether the webhooks server is running and answering.',
    hook: 'List, create and delete the server\'s hooks.',
    log: `Print the last ${log.DEFAULT_LINES} lines of the server log.`,
    run: 'Choose a function from the list and run it.',
    list: 'List every function.',
    update: 'Pull the latest gift code, restarting a running server on it.',
    help: 'Show this help, or a function\'s own documentation.',
    version: 'Show the installed version.',
};

// Listed under the webhooks heading in `gift help` rather than with the rest of
// the built-ins: all five are about the server in webhooks/.
const WEBHOOK_NAMES = ['serve', 'stop', 'status', 'hook', 'log'];

// The built-ins with commands or options of their own, so `gift help <name>`
// has real help to print rather than the one-line description.
const BUILTIN_USAGE = { hook: hook.usage, log: log.usage, status: status.usage, update: update.usage };

function pad(text, width) {
    return text + ' '.repeat(Math.max(0, width - text.length));
}

/** `gift list` — every function and its one-line description, nothing else. */
function printFunctionList() {
    const available = functions.list();
    if (available.length === 0) {
        console.error('gift: no functions found in functions/');
        return 1;
    }

    const width = Math.max(...available.map((f) => f.name.length));
    for (const fn of available) {
        console.log(`${pad(fn.name, width)}  ${fn.description}`.trimEnd());
    }
    return 0;
}

function printHelp() {
    const available = functions.list();
    const names = [...available.map((f) => f.name), ...Object.keys(BUILTINS)];
    const width = Math.max(...names.map((n) => n.length), 0);

    console.log('usage: gift <function> [args...]');
    console.log('       gift list             List every function.');
    console.log('       gift run              Pick a function from the list and run it.');
    console.log('       gift -h | --help      Show this help.');
    console.log('       gift -v | --version   Show the installed version.');
    console.log('');
    console.log('functions:');
    if (available.length === 0) {
        console.log('  (none found)');
    }
    for (const fn of available) {
        console.log(`  ${pad(fn.name, width)}  ${fn.description}`.trimEnd());
    }
    console.log('');
    console.log('GitHub webhooks server:');
    for (const name of WEBHOOK_NAMES) {
        console.log(`  ${pad(name, width)}  ${BUILTINS[name]}`);
    }
    console.log('');
    console.log('built-in:');
    for (const [name, description] of Object.entries(BUILTINS)) {
        if (WEBHOOK_NAMES.includes(name)) continue; // listed above, under their own heading
        console.log(`  ${pad(name, width)}  ${description}`);
    }
    console.log('');
    console.log('Run `gift help <function>` for a function\'s full documentation.');
}

/**
 * Resolve a token typed by the user. Built-ins and function folders share one
 * namespace: an exact name wins, otherwise any unique prefix of either does.
 *
 * @returns {{status: 'ok', fn: object} | {status: 'ok', builtin: string}
 *          | {status: 'unknown'} | {status: 'ambiguous', matches: string[]}}
 */
function resolveToken(token) {
    if (SERVICE[token]) return { status: 'ok', fn: SERVICE[token] };
    if (BUILTINS[token]) return { status: 'ok', builtin: token };

    const available = functions.list();
    const exact = available.find((f) => f.name === token);
    if (exact) return { status: 'ok', fn: exact };

    // No exact name, so gather the prefix matches from both namespaces before
    // deciding. Both have to be counted together: `r` starts the function
    // recursively-pull-repos *and* the built-in run, and is unique in neither.
    const folderMatches = available.filter((f) => f.name.startsWith(token)).map((f) => f.name);
    const builtinMatches = Object.keys(BUILTINS).filter((name) => name.startsWith(token));
    const all = [...folderMatches, ...builtinMatches];

    if (all.length === 0) return { status: 'unknown' };
    if (all.length > 1) return { status: 'ambiguous', matches: all.sort() };

    const only = all[0];
    if (SERVICE[only]) return { status: 'ok', fn: SERVICE[only] };
    if (BUILTINS[only]) return { status: 'ok', builtin: only };
    return { status: 'ok', fn: available.find((f) => f.name === only) };
}

function printFunctionHelp(token) {
    const result = resolveToken(token);
    if (result.status !== 'ok') return reportResolveFailure(token, result);

    if (result.builtin) {
        const usage = BUILTIN_USAGE[result.builtin];
        if (usage) {
            usage();
            return 0;
        }
        console.log(`${result.builtin} — ${BUILTINS[result.builtin]}`);
        return 0;
    }

    const { fn } = result;
    for (const file of ['README.txt', 'README.md']) {
        const readme = path.join(fn.dir, file);
        if (fs.existsSync(readme)) {
            process.stdout.write(fs.readFileSync(readme, 'utf8').replace(/\s*$/, '\n'));
            return 0;
        }
    }

    console.log(`${fn.name} — ${fn.description || 'no README in this folder'}`);
    console.log(`  runs: ${path.relative(functions.ROOT, fn.entry)}`);
    return 0;
}

function reportResolveFailure(token, result) {
    if (result.status === 'ambiguous') {
        console.error(`gift: '${token}' matches more than one function:`);
        for (const match of result.matches) console.error(`  ${match}`);
        console.error('Type more of the name to pick one.');
        return 2;
    }
    console.error(`gift: unknown function '${token}'`);
    console.error('Run `gift help` to see the available functions.');
    return 2;
}

/**
 * `gift run` — pick a function from the list, then run it. Anything typed after
 * `run` is forwarded to whichever function the user picks.
 */
async function runPicked(args) {
    const choice = await pick();

    if (choice.status === 'empty') {
        console.error('gift: no functions found in functions/');
        return 1;
    }
    if (choice.status === 'no-tty') {
        console.error('gift: `gift run` needs a terminal to ask in.');
        console.error('Run `gift <function>` directly, or `gift help` to see the list.');
        return 2;
    }
    if (choice.status !== 'ok') {
        console.log('Nothing to run.');
        return 130;
    }

    console.log('');
    env.loadFor(choice.fn.dir);
    return runFunction(choice.fn, args);
}

async function runBuiltin(name, rest) {
    switch (name) {
        case 'help':
            if (rest.length === 0 || rest[0].startsWith('-')) {
                printHelp();
                return 0;
            }
            return printFunctionHelp(rest[0]);
        case 'hook':
            return hook.main(rest);
        case 'log':
            return log.main(rest);
        case 'status':
            return status.main(rest);
        case 'run':
            return runPicked(rest);
        case 'list':
            return printFunctionList();
        case 'update':
            return update.main(rest);
        case 'version':
            console.log(version());
            return 0;
        default:
            console.error(`gift: '${name}' is not runnable`);
            return 2;
    }
}

async function main(argv) {
    if (argv.length === 0) {
        printHelp();
        return 1;
    }

    const [token, ...rest] = argv;

    if (token === '-v' || token === '--version') {
        console.log(version());
        return 0;
    }
    if (token === '-h' || token === '--help') {
        printHelp();
        return 0;
    }

    const result = resolveToken(token);
    if (result.status !== 'ok') return reportResolveFailure(token, result);

    // Config is loaded once the function is known, so it can bring its own .env.
    // `run` is the exception: it loads for whichever function gets picked. The
    // four below read webhooks/.env, the same settings the server starts with —
    // the address to ask, and PM2_NAME to look the process up under. `update`
    // needs them to find the server it restarts, as `status` does to report it.
    if (result.builtin) {
        if (['hook', 'log', 'status', 'update'].includes(result.builtin)) env.loadFor(WEBHOOK_DIR);
        else if (result.builtin !== 'run') env.loadFor();
        return runBuiltin(result.builtin, rest);
    }

    env.loadFor(result.fn.dir);
    return runFunction(result.fn, rest);
}

module.exports = { main };
