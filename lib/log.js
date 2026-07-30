// `gift log` — the tail of the webhook server's log.
//
//   gift log [lines]
//
// The file read is the one the server writes to: `--log=FILE`, then
// GIFT_SERVE_LOG, then `log` in webhooks/hooks.json — the same order the server
// resolves it in, so both ends agree on which file is the log.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const functions = require('./functions.js');
// hooks.json is the hook command's file; `log` is one setting in it, so the
// reading and the path helpers are shared rather than written twice.
const { readConfig, configFile, show, expandHome } = require('./hook.js');

const WEBHOOK_DIR = path.join(functions.ROOT, 'webhooks');

const DEFAULT_LOG = 'hooks.log';
const DEFAULT_LINES = 100;

// Values of the `log` setting that mean "console only, write no file".
const LOG_OFF = ['off', 'none', 'no', 'false', ''];

/** The last `count` lines of a file, or null if it is not there. */
function tail(file, count) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.slice(-count), total: lines.length };
}

function printLog(options, positionals) {
    // The log setting lives beside the hooks; the environment and the flag
    // override it, the same order the server resolves it in.
    let config = {};
    try {
        config = readConfig(configFile(options)).config;
    } catch {
        /* an unreadable config still has a default log path */
    }

    const setting = options.log ?? process.env.GIFT_SERVE_LOG ?? config.log ?? DEFAULT_LOG;
    if (LOG_OFF.includes(String(setting).trim().toLowerCase())) {
        console.error('gift log: file logging is off, so there is no log to print.');
        console.error('Set GIFT_SERVE_LOG (or "log" in hooks.json) to a file to keep one.');
        return 1;
    }

    const requested = options.lines ?? positionals[0];
    const count = requested === undefined ? DEFAULT_LINES : Number(requested);
    if (!Number.isInteger(count) || count <= 0) {
        console.error(`gift log: '${requested}' is not a number of lines`);
        return 2;
    }

    const logPath = path.resolve(WEBHOOK_DIR, expandHome(String(setting)));
    const current = tail(logPath, count);
    if (!current) {
        console.error(`gift log: no log at ${show(logPath)} yet.`);
        console.error('The server writes it from the moment it starts — `gift serve`.');
        return 1;
    }

    // Right after a rotation the live file holds only a few lines; the rest of
    // the window is still in hooks.log.1, so fill from there.
    let older = [];
    if (current.lines.length < count) {
        const rotated = tail(`${logPath}.1`, count - current.lines.length);
        if (rotated) older = rotated.lines;
    }

    const lines = [...older, ...current.lines];
    // The header goes to stderr, so `gift log > file` holds the log alone.
    console.error(
        older.length
            ? `${show(logPath)} — last ${lines.length} lines, ${older.length} of them from ${path.basename(logPath)}.1`
            : `${show(logPath)} — last ${lines.length} of ${current.total} lines`
    );
    for (const line of lines) console.log(line);
    return 0;
}

// ---------------------------------------------------------------- dispatch ---

function usage() {
    console.log('usage: gift log [lines]');
    console.log('');
    console.log(`Print the last ${DEFAULT_LINES} lines of the webhook server's log,`);
    console.log('or as many as are asked for: `gift log 20`.');
    console.log('');
    console.log('options:');
    console.log('  --log=FILE      Log file to read (default: the one in hooks.json)');
    console.log(`  --lines=N       How many lines to print (default: ${DEFAULT_LINES})`);
    console.log('  --config=FILE   Hook configuration file (default: webhooks/hooks.json)');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('Only the log goes to stdout — the one-line header goes to stderr, so');
    console.log('`gift log > deliveries.txt` holds the log alone.');
}

function parseArgs(argv) {
    const options = { help: false };
    const positionals = [];

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('--log=')) options.log = arg.slice(6);
        else if (arg.startsWith('--lines=')) options.lines = arg.slice(8);
        else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}' (try: gift log --help)`);
        else positionals.push(arg);
    }
    return { options, positionals };
}

function main(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    } catch (err) {
        console.error(`gift log: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        usage();
        return 0;
    }

    try {
        return printLog(options, positionals);
    } catch (err) {
        console.error(`gift log: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

module.exports = { main, usage, tail, DEFAULT_LINES };
