// `gift update` — pull the latest code into the gift checkout.
//
//   gift update
//
// `git pull --ff-only` in the folder gift is installed from, wherever the user
// happens to be standing. Fast-forward only, so an update never merges and never
// touches local work: if the branch has diverged, git says so and nothing moves.
// Nothing is installed or built afterwards — gift uses only the standard library.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT } = require('./functions.js');
const { version } = require('./version.js');

function main(argv) {
    if (argv.some((arg) => arg === '-h' || arg === '--help')) {
        usage();
        return 0;
    }
    const unknown = argv.find((arg) => arg.startsWith('-'));
    if (unknown) {
        console.error(`gift update: unknown option '${unknown}' (try: gift update --help)`);
        return 2;
    }
    if (argv.length > 0) {
        console.error(`gift update: '${argv[0]}' is not expected — update takes no arguments`);
        return 2;
    }

    // A release tarball has no history to pull from; say so rather than letting
    // git complain about a folder that was never a checkout.
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
        console.error(`gift update: ${ROOT} is not a git checkout, so there is nothing to pull.`);
        console.error('Download the latest release, or clone the repository, to update.');
        return 1;
    }

    const before = version();
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
    if (fs.existsSync(path.join(ROOT, 'webhooks', 'hooks.json'))) {
        console.log('Run `gift serve` to restart the webhooks server on this code.');
    }
    return 0;
}

function usage() {
    console.log('usage: gift update');
    console.log('');
    console.log('Pull the latest gift code — `git pull --ff-only` in the folder gift is');
    console.log(`installed from (${ROOT}).`);
    console.log('');
    console.log('Fast-forward only, so nothing is merged and local work is left alone; a');
    console.log('branch that has diverged is reported instead. There is nothing to install');
    console.log('afterwards. Restart the webhooks server with `gift serve` to pick it up.');
}

module.exports = { main, usage };
