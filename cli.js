// gift CLI dispatcher.
//
// Usage: gift <function> [args...]
//
// <function> is the name of a folder in functions/ — or a built-in command such
// as `serve`, `create`, `delete` and `log` — or any unique prefix.
// `gift recur` runs recursively-pull-repos, `gift se` runs serve. Everything
// after the name is forwarded to its entry script untouched. `gift run` asks
// instead: it prints the function list and runs whichever one is picked — or
// takes the answer from the command line, as `gift run 3` does.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const functions = require('./functions.js');
// The configuration in config.json — see utils/config.js for the order things
// are read in.
const settings = require('./utils/config.js');
const configCommand = require('./commands/config.js');
const create = require('./commands/create.js');
const deleteHook = require('./commands/delete.js');
const listHooks = require('./commands/list.js');
const log = require('./commands/log.js');
const status = require('./commands/status.js');
const update = require('./commands/update.js');
const { pick, choose } = require('./utils/pick.js');
const { runFunction } = require('./commands/run.js');
// `serve`, `restart` and `stop` are root scripts rather than function folders, so
// service.js names them; `gift update` restarts a running server through the same
// definitions.
const { SERVE, RESTART, STOP, SERVICE, SERVER_DIR } = require('./utils/service.js');
const { version } = require('./commands/version.js');

// Everything the CLI answers itself, rather than by running a function folder.
const BUILTINS = {
    serve: SERVE.description,
    restart: RESTART.description,
    stop: STOP.description,
    status: 'Report whether the webhooks server is running and answering.',
    list: 'List the configured server hooks.',
    create: 'Create a local hook and, when gh is authenticated, its GitHub webhook.',
    delete: 'Delete a server hook.',
    log: `Print the last ${log.DEFAULT_LINES} lines of the server log.`,
    config: 'Read and change gift\'s settings, and each function\'s.',
    run: 'Choose a helper function from a menu and run it.',
    update: 'Pull the latest gift code, restarting a running server on it.',
    help: 'Show this help, or a function\'s own documentation.',
    version: 'Show the installed version.',
};

// Listed under the webhooks heading in `gift help` rather than with the rest of
// the built-ins: all of them are about the server.
const WEBHOOK_NAMES = ['serve', 'restart', 'stop', 'status', 'list', 'create', 'delete', 'log'];

// The built-ins with commands or options of their own, so `gift help <name>`
// has real help to print rather than the one-line description.
const BUILTIN_USAGE = {
    config: configCommand.usage,
    create: create.usage,
    delete: deleteHook.usage,
    list: listHooks.usage,
    log: log.usage,
    status: status.usage,
    update: update.usage,
};

function pad(text, width) {
    return text + ' '.repeat(Math.max(0, width - text.length));
}

function printHelp() {
    const available = functions.list();
    const names = [...available.map((f) => f.name), ...Object.keys(BUILTINS)];
    const width = Math.max(...names.map((n) => n.length), 0);

    console.log('usage: gift <function> [args...]');
    console.log('       gift list             List configured server hooks.');
    console.log('       gift run [name|no.]   Pick a helper function from a menu, or say which.');
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
 * Read a choice out of `gift run`'s own arguments. The first word after `run` is
 * the menu's answer rather than an argument for the function — a number, a name,
 * or enough of one — so `gift run 3` and `gift run repo` run the third function
 * and repo-master without asking. A flag, and everything after the name, belongs
 * to the function. A word that names nothing here is still an answer, and a
 * wrong one: it is reported and dropped rather than handed on, because a
 * function given a stray `3` to make sense of reads it as a directory.
 *
 * @returns {{fn: object|null, rest: string[], message?: string}}
 */
function fromArguments(args, available) {
    const [token, ...rest] = args;
    if (!token || token.startsWith('-')) return { fn: null, rest: args };

    const choice = choose(token, available);
    if (choice.status === 'ok') return { fn: choice.fn, rest };
    return { fn: null, rest, message: choice.message };
}

/**
 * `gift run` — pick a function from the list, then run it. Anything left after
 * the name or number is forwarded to whichever function runs.
 */
async function runPicked(args) {
    const available = functions.list();
    if (available.length === 0) {
        console.error('gift: no functions found in functions/');
        return 1;
    }

    // Named on the command line, there is nothing to ask, and nothing a
    // terminal is needed for either — `gift run repo-master --once` works in a
    // script the same as `gift repo-master --once` does.
    const asked = fromArguments(args, available);
    if (asked.fn) {
        settings.loadFor(asked.fn.dir);
        return runFunction(asked.fn, asked.rest);
    }
    if (asked.message) console.log(asked.message);

    const choice = await pick();

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
    settings.loadFor(choice.fn.dir);
    return runFunction(choice.fn, asked.rest);
}

async function runBuiltin(name, rest) {
    switch (name) {
        case 'help':
            if (rest.length === 0 || rest[0].startsWith('-')) {
                printHelp();
                return 0;
            }
            return printFunctionHelp(rest[0]);
        case 'config':
            return configCommand.main(rest);
        case 'create':
            return create.main(rest);
        case 'delete':
            return deleteHook.main(rest);
        case 'list':
            return listHooks.main(rest);
        case 'log':
            return log.main(rest);
        case 'status':
            return status.main(rest);
        case 'run':
            return runPicked(rest);
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

    // Settings are loaded once the target is known, so a function brings its
    // own. `run` is one exception — it loads for whichever function gets picked
    // — and `config` is the other: it reports where each value comes from, and
    // loading them first would make every one of them look like the
    // environment's. The five below read gift's own settings, the same ones the
    // server starts with: the address to ask, and PM2_NAME to look the process
    // up under. `update` needs them to find the server it restarts, as `status`
    // does to report it.
    if (result.builtin) {
        if (['create', 'delete', 'list', 'log', 'status', 'update'].includes(result.builtin)) {
            settings.loadFor(SERVER_DIR);
        } else if (!['run', 'config'].includes(result.builtin)) {
            settings.loadFor();
        }
        return runBuiltin(result.builtin, rest);
    }

    settings.loadFor(result.fn.dir);
    return runFunction(result.fn, rest);
}

module.exports = { main };
