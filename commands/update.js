// `gift update` — pull the latest code into the gift checkout, and put a running
// webhooks server back on it.
//
//   gift update
//   gift update --no-restart
//
// `git pull --ff-only` in the folder gift is installed from, wherever the user
// happens to be standing. Fast-forward only, so an update never merges and never
// touches local work: if the branch has diverged, git says so and nothing moves.
// Nothing is installed or built afterwards — gift uses only the standard library.
//
// The webhooks server is the one thing that does not pick new code up by itself:
// it is a process that started from the old files and keeps running from them. So
// when the pull brought something new and the server is up, `gift serve` runs
// straight after — the same restart that would otherwise be typed next.
//
// Nothing is started that was not already running, and a pull that changed
// nothing leaves the server alone rather than dropping deliveries for a restart
// onto the code it is already on. `gift serve` on its own is still the way to
// restart it deliberately.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const status = require('./status.js');
const { ROOT } = require('../functions.js');
const { SERVE } = require('../utils/service.js');
const { runFunction } = require('./run.js');
const { version } = require('./version.js');

/** The commit the checkout is on, or null when git cannot say. */
function head() {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout).trim() || null;
}

function parseArgs(argv) {
    const options = { help: false, restart: true };

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '--no-restart') options.restart = false;
        else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}' (try: gift update --help)`);
        else throw new Error(`'${arg}' is not expected — update takes no arguments`);
    }
    return options;
}

/**
 * Whether this checkout is one a server runs from. A checkout used for the
 * functions alone has no hooks.json and no interest in anything said about a
 * server, so the lines below are kept for the ones that do.
 */
function hasServer() {
    return fs.existsSync(path.join(ROOT, 'webhooks', 'hooks.json'));
}

function serveHint() {
    if (hasServer()) console.log('Run `gift serve` to restart the webhooks server on this code.');
}

async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        console.error(`gift update: ${err.message}`);
        return 2;
    }

    if (options.help) {
        usage();
        return 0;
    }

    // A release tarball has no history to pull from; say so rather than letting
    // git complain about a folder that was never a checkout.
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
        console.error(`gift update: ${ROOT} is not a git checkout, so there is nothing to pull.`);
        console.error('Download the latest release, or clone the repository, to update.');
        return 1;
    }

    const before = version();
    const commitBefore = head();
    console.log(`Pulling the latest code into ${ROOT}...`);

    const result = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'inherit' });
    if (result.error) {
        if (result.error.code === 'ENOENT') {
            console.error('gift update: git: not found');
            return 1;
        }
        console.error(`gift update: ${result.error.message}`);
        return 1;
    }
    if (result.status !== 0) {
        console.error('');
        console.error('gift update: the pull did not go through.');
        console.error('A fast-forward is refused when the branch has diverged or local files');
        console.error('are in the way — `git status` in the folder above shows which.');
        return result.status === null ? 1 : result.status;
    }

    const after = version();
    console.log(after === before ? `gift ${after}` : `gift ${before} → ${after}`);

    if (!options.restart) {
        serveHint();
        return 0;
    }

    // A commit that git could not name is treated as new: better a restart that
    // was not needed than a server left on code the user thinks it replaced.
    const commitAfter = head();
    if (commitBefore && commitAfter && commitBefore === commitAfter) {
        // Nothing was asked of the server either way, so nothing is claimed about
        // whether it is up — it is simply untouched.
        if (hasServer()) console.log('Nothing new, so the webhooks server was left alone.');
        return 0;
    }

    const state = await status.probe();
    if (!state.up) {
        serveHint();
        return 0;
    }

    console.log('');
    console.log(
        state.answering
            ? 'The webhooks server is answering, so restarting it on this code:'
            : 'PM2 has the webhooks server online, so restarting it on this code:',
    );
    console.log('');

    // `gift serve` — the same restart that would be typed next, pull included.
    // Its exit code becomes this command's: the pull is done either way, and a
    // restart that failed is not an update that went through.
    return runFunction(SERVE, []);
}

function usage() {
    console.log('usage: gift update [--no-restart]');
    console.log('');
    console.log('Pull the latest gift code — `git pull --ff-only` in the folder gift is');
    console.log(`installed from (${ROOT}).`);
    console.log('');
    console.log('Fast-forward only, so nothing is merged and local work is left alone; a');
    console.log('branch that has diverged is reported instead. There is nothing to install');
    console.log('afterwards.');
    console.log('');
    console.log('A running webhooks server is then restarted on the new code, since a');
    console.log('running server keeps its old files until it does. Nothing is started that');
    console.log('was not already running, and a pull that brought nothing new restarts');
    console.log('nothing.');
    console.log('');
    console.log('options:');
    console.log('  --no-restart    Pull only, leaving the server on the code it is running');
    console.log('  -h, --help      Show this help');
}

module.exports = { main, usage };
