// The webhooks server as the CLI drives it.
//
// The server is not one of the functions/ folders — it is a service that happens
// to be driven from this CLI — so `serve` and `stop` are named here rather than
// discovered. Both run a script from the project root, which is also where they
// pick up their .env.
//
// They hand the process to PM2 rather than running the server in the foreground;
// `node server.js` is still the way to run it attached, with --dry-run
// and the other server flags.
//
// Two commands reach for these: the dispatcher, which runs them when they are
// typed, and `gift update`, which restarts a running server on the code it just
// pulled. Naming them once keeps both meaning the same thing by `serve`.
'use strict';

const path = require('node:path');

const { ROOT } = require('../functions.js');

const SERVER_DIR = ROOT;

const SERVE = {
    name: 'serve',
    description: 'Pull the latest code, then (re)start the webhooks server under PM2.',
    dir: SERVER_DIR,
    entry: path.join(SERVER_DIR, 'restart.sh'),
};

const STOP = {
    name: 'stop',
    description: 'Stop the webhooks server running under PM2.',
    dir: SERVER_DIR,
    entry: path.join(SERVER_DIR, 'stop.sh'),
};

// Named entries that run a script instead of being answered by the CLI itself.
const SERVICE = { serve: SERVE, stop: STOP };

module.exports = { SERVE, STOP, SERVICE, SERVER_DIR };
