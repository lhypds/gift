// The webhooks server as the CLI drives it.
//
// The server is not one of the functions/ folders — it is a service that happens
// to be driven from this CLI — so `serve`, `restart` and `stop` are named here
// rather than discovered. All three run a script from the project root, and
// configure themselves from gift's own settings rather than a function's.
//
// They hand the process to PM2 rather than running the server in the foreground;
// `node serve.js` is still the way to run it attached, with --dry-run
// and the other server flags.
//
// `serve` and `restart` differ in what they do before PM2: `serve` pulls,
// installs and rebuilds the dashboard first, so it needs the network and takes a
// while; `restart` only puts the process back on the code already on disk. That
// is the same script `gift create` and `gift delete` bounce the server with.
//
// Two commands reach for these: the dispatcher, which runs them when they are
// typed, and `gift update`, which restarts a running server on the code it just
// pulled. Naming them once keeps both using the same start path.
'use strict';

const path = require('node:path');

const { ROOT } = require('../functions.js');

const SERVER_DIR = ROOT;

const SERVE = {
    name: 'serve',
    description: 'Pull, rebuild the dashboard, and (re)start the webhooks server under PM2.',
    dir: SERVER_DIR,
    entry: path.join(SERVER_DIR, 'restart.sh'),
};

const RESTART = {
    name: 'restart',
    description: '(Re)start the webhooks server under PM2, without pulling or rebuilding.',
    dir: SERVER_DIR,
    entry: path.join(SERVER_DIR, 'start.sh'),
};

const STOP = {
    name: 'stop',
    description: 'Stop the webhooks server running under PM2.',
    dir: SERVER_DIR,
    entry: path.join(SERVER_DIR, 'stop.sh'),
};

// Named entries that run a script instead of being answered by the CLI itself.
const SERVICE = { serve: SERVE, restart: RESTART, stop: STOP };

module.exports = { SERVE, RESTART, STOP, SERVICE, SERVER_DIR };
