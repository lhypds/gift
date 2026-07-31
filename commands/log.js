// `gift log` — the tail of the webhook server's log, followed as it is written.
//
//   gift log [lines]
//
// The last 10 lines, and then whatever the server appends next: `tail -F` keeps
// the window open until Ctrl-C, and reopens the file when a rotation replaces it,
// so a `gift log` left running in a terminal does not go quiet at 5 MB.
// `--no-follow` prints the window and stops, for a pipe or a script.
//
// The file read is the one the server writes to: `--log=FILE`, then
// GIFT_SERVE_LOG, then `log` in webhooks/hooks.json — the same order the server
// resolves it in, so both ends agree on which file is the log.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// hooks.json is the hook command's file; `log` is one setting in it, so the
// reading and the path helpers are shared rather than written twice.
const { readConfig, configFile, show, expandHome } = require('./hook.js');
const { WEBHOOK_DIR } = require('../utils/service.js');

const DEFAULT_LOG = 'hooks.log';
const DEFAULT_LINES = 10;

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

/**
 * Which file to read and how much of it.
 *
 * @returns {{logPath: string, count: number} | {code: number}}
 */
function target(options, positionals) {
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
        return { code: 1 };
    }

    const requested = options.lines ?? positionals[0];
    const count = requested === undefined ? DEFAULT_LINES : Number(requested);
    if (!Number.isInteger(count) || count <= 0) {
        console.error(`gift log: '${requested}' is not a number of lines`);
        return { code: 2 };
    }

    return { logPath: path.resolve(WEBHOOK_DIR, expandHome(String(setting))), count };
}

/**
 * Right after a rotation the live file holds only a few lines; the rest of the
 * window is still in hooks.log.1, so fill from there.
 */
function fromRotated(logPath, deficit) {
    if (deficit <= 0) return [];
    const rotated = tail(`${logPath}.1`, deficit);
    return rotated ? rotated.lines : [];
}

/** `--no-follow` — the window as it stands, and nothing after it. */
function printWindow(logPath, count) {
    const current = tail(logPath, count);
    if (!current) {
        console.error(`gift log: no log at ${show(logPath)} yet.`);
        console.error('The server writes it from the moment it starts — `gift serve`.');
        return 1;
    }

    const older = fromRotated(logPath, count - current.lines.length);
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

/**
 * The window, and then every line the server appends, until Ctrl-C.
 *
 * `tail -F` does the watching: it also reopens the file by name, so the rotation
 * at 5 MB is followed into the new hooks.log instead of holding the old inode
 * open. The window itself is left to `tail -n` rather than read here, so nothing
 * appended between the two can fall through the gap; only the lines still in
 * hooks.log.1 are printed first, which the live file cannot supply.
 */
function follow(logPath, count) {
    const current = tail(logPath, count);
    if (current) {
        const older = fromRotated(logPath, count - current.lines.length);
        console.error(
            older.length
                ? `${show(logPath)} — last ${count} lines and everything after, ${older.length} of them from ${path.basename(logPath)}.1 (Ctrl-C to stop)`
                : `${show(logPath)} — last ${Math.min(count, current.total)} of ${current.total} lines and everything after (Ctrl-C to stop)`
        );
        for (const line of older) console.log(line);
    } else {
        // Not there yet — `tail -F` waits for it, which is what someone running
        // this before `gift serve` wants.
        console.error(`${show(logPath)} — waiting for the server to write it (Ctrl-C to stop)`);
    }

    const child = spawn('tail', ['-F', '-n', String(count), logPath], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    // Ctrl-C already reaches the child through the process group; forwarding
    // covers a `kill` aimed at gift itself, and keeps us alive long enough to
    // report how the child ended rather than dying mid-line.
    const forward = (signal) => () => {
        if (child.exitCode === null && !child.killed) {
            try {
                child.kill(signal);
            } catch {
                /* already gone */
            }
        }
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    return new Promise((resolve) => {
        const done = (code) => {
            process.off('SIGINT', onInt);
            process.off('SIGTERM', onTerm);
            resolve(code);
        };

        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                console.error('gift log: tail: not found, so the log cannot be followed.');
                console.error('`gift log --no-follow` prints the window without it.');
                done(1);
                return;
            }
            console.error(`gift log: ${err.message}`);
            done(1);
        });

        // Ctrl-C is how this command is meant to end, so it is not a failure.
        child.on('close', (code, signal) => done(signal === 'SIGINT' ? 130 : code === null ? 1 : code));
    });
}

// ---------------------------------------------------------------- dispatch ---

function usage() {
    console.log('usage: gift log [lines]');
    console.log('');
    console.log(`Print the last ${DEFAULT_LINES} lines of the webhook server's log — or as many`);
    console.log('as are asked for, `gift log 20` — and then keep printing what the server');
    console.log('appends, until Ctrl-C. A rotation at 5 MB is followed into the new file.');
    console.log('');
    console.log('options:');
    console.log('  --no-follow     Print the lines and stop, for a pipe or a script');
    console.log('  --log=FILE      Log file to read (default: the one in hooks.json)');
    console.log(`  --lines=N       How many lines to start with (default: ${DEFAULT_LINES})`);
    console.log('  --config=FILE   Hook configuration file (default: webhooks/hooks.json)');
    console.log('  -f, --follow    Keep watching — the default, so this is never needed');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('Only the log goes to stdout — the one-line header goes to stderr, so');
    console.log('`gift log --no-follow > deliveries.txt` holds the log alone.');
}

function parseArgs(argv) {
    const options = { help: false, follow: true };
    const positionals = [];

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '-f' || arg === '--follow') options.follow = true;
        else if (arg === '--no-follow') options.follow = false;
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
        const where = target(options, positionals);
        if (where.code !== undefined) return where.code;
        return options.follow ? follow(where.logPath, where.count) : printWindow(where.logPath, where.count);
    } catch (err) {
        console.error(`gift log: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

module.exports = { main, usage, DEFAULT_LINES };
