// gift CLI dispatcher.
//
// Usage: gift <command> [args...]
//
// <command> is the name of a folder in commands/ — or `serve`, which starts the
// webhook server in webhooks/ — or any unique prefix of one. `gift list` runs
// list-weekly-prs, `gift s` runs serve. Everything after the command name is
// forwarded to its entry script untouched.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const commands = require('./commands.js');
const env = require('./env.js');
const { runCommand } = require('./run.js');
const { version } = require('./version.js');

const WEBHOOK_DIR = path.join(commands.ROOT, 'webhooks');

// The webhook server is not one of the commands/ folders — it is a service that
// happens to be started from this CLI — so it is wired up here by name. Its dir
// is webhooks/, which is also where `gift serve` picks up its own .env.
const SERVE = {
    name: 'serve',
    description: 'Start the GitHub webhook server (webhooks/).',
    dir: WEBHOOK_DIR,
    entry: path.join(WEBHOOK_DIR, 'server.js'),
};

// Everything the CLI answers itself, rather than by running a command folder.
const BUILTINS = {
    serve: SERVE.description,
    help: 'Show this help, or a command\'s own documentation.',
    commands: 'List every command name (used by shell completion).',
    completion: 'Print the shell completion script: gift completion zsh|bash.',
    version: 'Show the installed version.',
};

function pad(text, width) {
    return text + ' '.repeat(Math.max(0, width - text.length));
}

function printHelp() {
    const available = commands.list();
    const names = [...available.map((c) => c.name), ...Object.keys(BUILTINS)];
    const width = Math.max(...names.map((n) => n.length), 0);

    console.log('usage: gift <command> [args...]');
    console.log('       gift -h | --help      Show this help.');
    console.log('       gift -v | --version   Show the installed version.');
    console.log('');
    console.log('commands:');
    if (available.length === 0) {
        console.log('  (none found)');
    }
    for (const command of available) {
        console.log(`  ${pad(command.name, width)}  ${command.description}`.trimEnd());
    }
    console.log('');
    console.log('GitHub webhooks server:');
    console.log(`  ${pad('serve', width)}  ${SERVE.description}`);
    console.log('');
    console.log('built-in:');
    for (const [name, description] of Object.entries(BUILTINS)) {
        if (name === 'serve') continue; // listed above, under its own heading
        console.log(`  ${pad(name, width)}  ${description}`);
    }
    console.log('');
    console.log('Run `gift help <command>` for a command\'s full documentation.');
}

/**
 * Resolve a token typed by the user. Built-ins and command folders share one
 * namespace: an exact name wins, otherwise any unique prefix of either does.
 *
 * @returns {{status: 'ok', command: object} | {status: 'unknown'}
 *          | {status: 'ambiguous', matches: string[]}}
 */
function resolveToken(token) {
    if (token === 'serve') return { status: 'ok', command: SERVE };
    if (BUILTINS[token]) return { status: 'ok', builtin: token };

    const folder = commands.resolve(token);
    if (folder.status === 'ok') return { status: 'ok', command: folder.command };

    const builtinMatches = Object.keys(BUILTINS).filter((name) => name.startsWith(token));
    const folderMatches = folder.status === 'ambiguous' ? folder.matches.map((c) => c.name) : [];
    const all = [...folderMatches, ...builtinMatches];

    if (all.length === 0) return { status: 'unknown' };
    if (all.length > 1) return { status: 'ambiguous', matches: all.sort() };

    const only = all[0];
    if (only === 'serve') return { status: 'ok', command: SERVE };
    if (BUILTINS[only]) return { status: 'ok', builtin: only };
    return { status: 'ok', command: commands.resolve(only).command };
}

function printCommandHelp(token) {
    const result = resolveToken(token);
    if (result.status !== 'ok') return reportResolveFailure(token, result);

    if (result.builtin) {
        console.log(`${result.builtin} — ${BUILTINS[result.builtin]}`);
        return 0;
    }

    const { command } = result;
    for (const file of ['README.txt', 'README.md']) {
        const readme = path.join(command.dir, file);
        if (fs.existsSync(readme)) {
            process.stdout.write(fs.readFileSync(readme, 'utf8').replace(/\s*$/, '\n'));
            return 0;
        }
    }

    console.log(`${command.name} — ${command.description || 'no README in this folder'}`);
    console.log(`  runs: ${path.relative(commands.ROOT, command.entry)}`);
    return 0;
}

function reportResolveFailure(token, result) {
    if (result.status === 'ambiguous') {
        console.error(`gift: '${token}' matches more than one command:`);
        for (const match of result.matches) console.error(`  ${match}`);
        console.error('Type more of the name to pick one.');
        return 2;
    }
    console.error(`gift: unknown command '${token}'`);
    console.error('Run `gift help` to see the available commands.');
    return 2;
}

function printCommandNames(args) {
    const describe = args.includes('--describe');
    const entries = [
        ...commands.list().map((c) => [c.name, c.description]),
        ...Object.entries(BUILTINS),
    ].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, description] of entries) {
        if (!describe) {
            console.log(name);
            continue;
        }
        // `name:description` for zsh's _describe; the value must not contain
        // an unescaped colon, and descriptions read better on one line.
        console.log(`${name}:${String(description).replace(/:/g, '\\:').replace(/\s+/g, ' ')}`);
    }
    return 0;
}

function printCompletion(shell) {
    const files = { zsh: '_gift', bash: 'gift.bash' };
    const file = files[shell];
    if (!file) {
        console.error(`gift: no completion script for '${shell || ''}' (expected zsh or bash)`);
        return 2;
    }
    process.stdout.write(fs.readFileSync(path.join(commands.ROOT, 'completions', file), 'utf8'));
    return 0;
}

function runBuiltin(name, rest) {
    switch (name) {
        case 'help':
            if (rest.length === 0 || rest[0].startsWith('-')) {
                printHelp();
                return 0;
            }
            return printCommandHelp(rest[0]);
        case 'version':
            console.log(version());
            return 0;
        case 'commands':
            return printCommandNames(rest);
        case 'completion':
            return printCompletion(rest[0]);
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

    // Config is loaded once the command is known, so it can bring its own .env.
    if (result.builtin) {
        env.loadFor();
        return runBuiltin(result.builtin, rest);
    }

    env.loadFor(result.command.dir);
    return runCommand(result.command, rest);
}

module.exports = { main, BUILTINS, SERVE, resolveToken };
