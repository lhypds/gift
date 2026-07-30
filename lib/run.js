// Run a function folder's entry script with the user's arguments.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ROOT } = require('./functions.js');
const { version } = require('./version.js');

/** Pick the interpreter for an entry script. */
function interpreterFor(entry) {
    switch (path.extname(entry)) {
        case '.js':
            return [process.execPath, [entry]];
        case '.sh':
        case '.command':
        case '.bash':
            return ['bash', [entry]];
        default:
            try {
                fs.accessSync(entry, fs.constants.X_OK);
                return [entry, []];
            } catch {
                throw new Error(`don't know how to run ${entry}`);
            }
    }
}

/**
 * Run a function and resolve with its exit code. The child inherits stdio and
 * the user's working directory — functions like `recursively-pull-repos` act on
 * the directory the user is standing in.
 */
function runFunction(fn, args = []) {
    const [file, prefixArgs] = interpreterFor(fn.entry);

    const child = spawn(file, [...prefixArgs, ...args], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
            ...process.env,
            GIFT_ROOT: ROOT,
            GIFT_VERSION: version(),
            GIFT_FUNCTION: fn.name,
            GIFT_FUNCTION_DIR: fn.dir,
            // Launched from the CLI, so scripts skip their double-click pause.
            GIFT_NO_PAUSE: '1',
        },
    });

    // The child owns the terminal. Ctrl-C already reaches it through the
    // process group; forwarding covers `kill -TERM <gift pid>` too, which is
    // how a long-running function like `gift serve` gets stopped by a service
    // manager. Either way we stay alive to report the code it exits with.
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

    const stopForwarding = () => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
    };

    return new Promise((resolve, reject) => {
        child.on('error', (err) => {
            stopForwarding();
            if (err.code === 'ENOENT') {
                reject(new Error(`${file}: not found (needed to run '${fn.name}')`));
                return;
            }
            reject(err);
        });

        child.on('close', (code, signal) => {
            stopForwarding();
            if (signal) {
                resolve(signal === 'SIGINT' ? 130 : 1);
                return;
            }
            resolve(code === null ? 1 : code);
        });
    });
}

module.exports = { runFunction };
