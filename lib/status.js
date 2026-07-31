// `gift status` — is the webhooks server running, and answering?
//
//   gift status
//
// Three questions answered in one place: what PM2 says about the process, what
// the server says for itself when asked (`GET /health`), and what it is set up to
// serve — the endpoint, the hooks, the log. Nothing is started or stopped here;
// `gift serve` and `gift stop` do that.
//
// The verdict is the health check, not PM2: a server that answers is up, however
// it was started, and a PM2 entry that says `online` while nothing answers is the
// interesting case rather than a pass. The exit code follows the same rule — 0
// when the server answers, 1 when it does not — so a monitor can run
// `gift status --json` and read either.
//
// Settings are resolved the way server.js resolves them, so both ends agree on
// which address, config file and log are being talked about.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const functions = require('./functions.js');
const { readConfig, configFile, show, expandHome } = require('./hook.js');
const { version } = require('./version.js');

const WEBHOOK_DIR = path.join(functions.ROOT, 'webhooks');

const DEFAULTS = { host: '127.0.0.1', port: 3999, path: '/hooks/github' };
const DEFAULT_LOG = 'hooks.log';
const DEFAULT_PM2_NAME = 'gift-webhooks';
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';

// Values of the `log` setting that mean "console only, write no file".
const LOG_OFF = ['off', 'none', 'no', 'false', ''];

// ---------------------------------------------------------------- formatting ---

/** A rough duration — the scale that matters, not the seconds inside a day. */
function since(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;

    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function bytes(count) {
    if (!Number.isFinite(count)) return '';
    if (count < 1024) return `${count} B`;

    const units = ['KB', 'MB', 'GB'];
    let value = count / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** An address as it goes into a URL — an IPv6 host needs its brackets. */
function authority(host, port) {
    return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

// ------------------------------------------------------------------ settings ---

/**
 * Where the server is, according to the same sources it reads itself:
 * the environment first, then hooks.json, then the built-in defaults.
 */
function settingsFrom(options) {
    const file = configFile(options);

    let config = {};
    let missing = false;
    let unreadable = null;
    try {
        const read = readConfig(file);
        config = read.config;
        missing = read.missing;
    } catch (err) {
        // A config that does not parse is worth saying out loud — it is also why
        // the server would refuse to start — but the address is still knowable.
        unreadable = err.message;
    }

    const host = process.env.GIFT_SERVE_HOST || config.host || DEFAULTS.host;
    const port = Number(
        process.env.GIFT_SERVE_PORT || process.env.PORT || config.port || DEFAULTS.port,
    );
    let endpoint = String(process.env.GIFT_SERVE_PATH || config.path || DEFAULTS.path);
    if (!endpoint.startsWith('/')) endpoint = `/${endpoint}`;

    const setting = process.env.GIFT_SERVE_LOG ?? config.log ?? DEFAULT_LOG;
    const off = LOG_OFF.includes(String(setting).trim().toLowerCase());

    return {
        host,
        port,
        path: endpoint,
        config: { file, missing, unreadable },
        hooks: Array.isArray(config.hooks) ? config.hooks : [],
        log: off ? null : path.resolve(WEBHOOK_DIR, expandHome(String(setting))),
    };
}

/** The log file as it stands: how big, and how long since the server wrote it. */
function logState(logPath) {
    if (!logPath) return { off: true };
    try {
        const stat = fs.statSync(logPath);
        return { path: logPath, bytes: stat.size, modified: stat.mtime };
    } catch {
        return { path: logPath, missing: true };
    }
}

/**
 * Hook secrets that are not set. The server refuses to start without one, so an
 * empty variable here is usually the answer to "why is it not running".
 */
function missingSecrets(hooks) {
    const names = new Set(hooks.map((hook) => String(hook.secretEnv || DEFAULT_SECRET_ENV)));
    if (names.size === 0) names.add(DEFAULT_SECRET_ENV);
    return [...names].filter((name) => !process.env[name]);
}

/**
 * The secrets that are set, each as the fingerprint the server logs — the first
 * bytes of its SHA-256, which is not the secret and cannot be turned back into
 * it.
 *
 * This is the value in webhooks/.env as gift reads it now. The server prints the
 * same fingerprint for what it is actually running on, at startup and on every
 * 401, so the two together answer the question a rotated secret raises: whether
 * the process ever picked the new value up. A variable already in the
 * environment wins over .env, so they can differ.
 */
function secretFingerprints(hooks) {
    const names = new Set(hooks.map((hook) => String(hook.secretEnv || DEFAULT_SECRET_ENV)));
    if (names.size === 0) names.add(DEFAULT_SECRET_ENV);
    return [...names]
        .filter((name) => process.env[name])
        .map((name) => ({
            name,
            fingerprint: crypto.createHash('sha256').update(process.env[name]).digest('hex').slice(0, 8),
        }));
}

// ----------------------------------------------------------------------- pm2 ---

/**
 * The list out of `pm2 jlist`. PM2 sometimes prints a notice before the JSON, so
 * the whole of stdout may not parse: the list begins at the first line that opens
 * an array, which a `[PM2][WARN] ...` notice does not — it opens with a word.
 *
 * @returns {Array|null}
 */
function parseList(text) {
    const lines = text.split('\n');

    // Whole lines, rather than the first `[` and the last `]` in the text: a
    // notice on either side of the list has brackets of its own — `[PM2]` — and
    // slicing between them cuts in the middle of one.
    const opens = [];
    const closes = [];
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '[' || trimmed === '[]' || trimmed.startsWith('[{')) opens.push(index);
        if (trimmed.endsWith(']')) closes.push(index);
    });

    for (const start of opens) {
        // From the last close backwards, so a list holding nested arrays is taken
        // whole rather than cut at the first `]` inside it.
        for (let i = closes.length - 1; i >= 0; i -= 1) {
            if (closes[i] < start) break;
            try {
                const value = JSON.parse(lines.slice(start, closes[i] + 1).join('\n'));
                if (Array.isArray(value)) return value;
            } catch {
                /* not the list — try the next pair of lines it could span */
            }
        }
    }
    return null;
}

/**
 * What PM2 has under this name. `pm2 jlist` is the machine-readable listing; a
 * stopped process stays in it, which is how `stopped` is told from `never
 * started`. PM2 not being installed is a state of its own — the server may well
 * be running under systemd, or attached in a terminal.
 *
 * @returns {{state: string, [key: string]: any}}
 */
function pm2State(name) {
    const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

    if (result.error) {
        if (result.error.code === 'ENOENT') return { state: 'no-pm2' };
        return { state: 'unreadable', message: result.error.message };
    }
    if (result.status !== 0) {
        const said = String(result.stderr || '').trim().split('\n')[0];
        return { state: 'unreadable', message: said || `pm2 jlist exited ${result.status}` };
    }

    const list = parseList(String(result.stdout || ''));
    if (!list) return { state: 'unreadable', message: 'pm2 jlist did not print a JSON list' };

    const apps = list.filter((app) => app && app.name === name);
    if (apps.length === 0) return { state: 'missing' };

    const app = apps[0];
    const env = app.pm2_env || {};
    const monit = app.monit || {};
    const online = env.status === 'online';

    return {
        state: env.status || 'unknown',
        pid: app.pid || undefined,
        // pm_uptime is when the current run started; it lingers on a stopped
        // process, where it would read as an uptime that is still growing.
        uptimeMs: online && env.pm_uptime ? Date.now() - env.pm_uptime : undefined,
        restarts: Number.isFinite(env.restart_time) ? env.restart_time : undefined,
        unstableRestarts: env.unstable_restarts || undefined,
        cpu: Number.isFinite(monit.cpu) ? monit.cpu : undefined,
        memory: Number.isFinite(monit.memory) ? monit.memory : undefined,
        instances: apps.length > 1 ? apps.length : undefined,
    };
}

// -------------------------------------------------------------------- health ---

/** Explain a failed connection in terms of what was tried. */
function connectionProblem(err, host, port) {
    switch (err.code) {
        case 'ECONNREFUSED':
            return `nothing listening on ${authority(host, port)}`;
        case 'ETIMEDOUT':
            // The operating system gave up before the deadline below did.
            return `the connection to ${authority(host, port)} timed out`;
        case 'EHOSTUNREACH':
        case 'ENETUNREACH':
            return `${host} cannot be reached from here`;
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return `${host} could not be resolved`;
        case 'ECONNRESET':
            return `${authority(host, port)} closed the connection without answering`;
        default:
            return err.message;
    }
}

/**
 * Ask the server how it is: `GET /health`, which answers `ok` and is the one
 * request the server does not log, so asking leaves the log alone.
 *
 * A wildcard bind is not an address to connect to — the loopback interface it
 * covers is.
 */
function health(host, port, timeoutMs) {
    const target = host === '0.0.0.0' || host === '*' ? '127.0.0.1' : host === '::' ? '::1' : host;

    return new Promise((resolve) => {
        const startedAt = Date.now();
        const asked = `http://${authority(target, port)}/health`;
        let timedOut = false;
        let deadline;

        const done = (result) => {
            clearTimeout(deadline);
            resolve({ ...result, ms: Date.now() - startedAt, asked });
        };

        const req = http.request(
            {
                hostname: target,
                port,
                path: '/health',
                method: 'GET',
                headers: { 'user-agent': `gift/${version()}`, connection: 'close' },
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                // The answer is two characters; a proxy in the way could send a
                // page instead, and none of it needs keeping.
                res.on('data', (chunk) => {
                    if (body.length < 200) body += chunk;
                });
                res.on('end', () => {
                    const text = body.trim();
                    done({ ok: res.statusCode === 200 && text === 'ok', status: res.statusCode, body: text });
                });
            },
        );

        // A timer over the whole exchange, rather than req.setTimeout: that one
        // only starts counting once the socket is connected, so an address that
        // swallows the connection instead of refusing it would be waited on for
        // as long as the operating system takes to give up — five seconds or
        // more, from a command whose answer is meant to be quick.
        deadline = setTimeout(() => {
            timedOut = true;
            req.destroy();
        }, timeoutMs);

        req.on('error', (err) => {
            done({
                ok: false,
                error: timedOut ? `no answer within ${timeoutMs} ms` : connectionProblem(err, target, port),
            });
        });

        req.end();
    });
}

// --------------------------------------------------------------------- probe ---

/**
 * Is the server up, without a word printed? `gift update` asks before restarting:
 * a server that was running is put back on the new code, and one that was not is
 * left alone rather than started behind the user's back.
 *
 * `up` is answering-or-meant-to-be: PM2 calling the process online while nothing
 * answers is still a server that was running, and the one to restart.
 *
 * @returns {Promise<{up: boolean, answering: boolean, pm2: object, health: object}>}
 */
async function probe(options = {}) {
    const settings = settingsFrom(options);
    const pm2 = pm2State(process.env.PM2_NAME || DEFAULT_PM2_NAME);
    const result = await health(settings.host, settings.port, options.timeout || DEFAULT_TIMEOUT_MS);

    return { up: result.ok || pm2.state === 'online', answering: result.ok, pm2, health: result };
}

// -------------------------------------------------------------------- report ---

/** The one word at the top: what someone running this wants to know first. */
function headline(state) {
    if (state.health.ok) return 'running';
    // Something answered, so the port is not idle — an older gift, or a proxy or
    // another service sitting where this one is expected.
    if (state.health.status) return `answering ${state.health.status} on /health rather than ok`;
    if (state.pm2.state === 'online') return 'not answering, though PM2 says the process is online';
    if (state.pm2.state === 'stopped') return 'stopped';
    if (state.pm2.state === 'errored') return 'errored — PM2 could not keep it running';
    return 'not running';
}

function pm2Row(pm2, name) {
    switch (pm2.state) {
        case 'no-pm2':
            return 'pm2 is not installed, so there is no process to report';
        case 'unreadable':
            return `could not be read — ${pm2.message}`;
        case 'missing':
            return `no '${name}' process — it has not been started under PM2`;
        default: {
            const parts = [`'${name}' ${pm2.state}`];
            if (pm2.instances) parts.push(`${pm2.instances} instances`);
            if (pm2.pid) parts.push(`pid ${pm2.pid}`);
            const up = since(pm2.uptimeMs);
            if (up) parts.push(`up ${up}`);
            if (Number.isFinite(pm2.restarts)) {
                parts.push(`${pm2.restarts} restart${pm2.restarts === 1 ? '' : 's'}`);
            }
            // A stopped process reports zero, which is not worth a column.
            if (pm2.memory) parts.push(bytes(pm2.memory));
            return parts.join(', ');
        }
    }
}

function healthRow(result) {
    if (result.ok) return `ok in ${result.ms} ms — GET ${result.asked}`;
    if (result.error) return `${result.error} — GET ${result.asked}`;
    return `answered ${result.status}${result.body ? ` '${result.body}'` : ''} — GET ${result.asked}`;
}

function hooksRow(hooks, config) {
    if (config.unreadable) return `unknown — ${config.unreadable}`;
    if (config.missing) return `none — no ${show(config.file)} yet`;
    if (hooks.length === 0) return `none configured in ${show(config.file)}`;

    const names = hooks.map((hook, index) => String(hook.name || `hook-${index + 1}`));
    const shown = names.slice(0, 6);
    const rest = names.length - shown.length;
    return `${names.length} — ${shown.join(', ')}${rest ? `, +${rest} more` : ''}`;
}

function logRow(log) {
    if (log.off) return 'off — the server logs to the console only';
    if (log.missing) return `${show(log.path)} — no file yet`;

    const age = since(Date.now() - log.modified.getTime());
    return `${show(log.path)} — ${bytes(log.bytes)}, written ${age ? `${age} ago` : 'just now'}`;
}

function printReport(state) {
    const rows = [
        ['process', pm2Row(state.pm2, state.pm2Name)],
        ['endpoint', `http://${authority(state.settings.host, state.settings.port)}${state.settings.path}`],
        ['health', healthRow(state.health)],
        ['hooks', hooksRow(state.settings.hooks, state.settings.config)],
        ['log', logRow(state.log)],
    ];
    // The secret is what a 401 is usually about, so the fingerprint of the value
    // in .env belongs in the same picture as the endpoint serving it: the log
    // prints the same fingerprint for the value the server is running on, and a
    // mismatch between the two is a process that never picked up a rotation.
    for (const secret of state.secrets) {
        rows.push([
            'secret',
            `${secret.name}:${secret.fingerprint} in webhooks/.env — the server logs the fingerprint it runs on`,
        ]);
    }
    // Only worth raising when the server is down: it is the usual reason one
    // will not start, and beside a server that is already answering it would only
    // contradict what the health row just said. (A running server may well have
    // its secret from somewhere gift does not read — a systemd EnvironmentFile.)
    if (!state.health.ok) {
        for (const secret of state.missingSecrets) {
            rows.push(['note', `${secret} is not set in webhooks/.env — the server will not start without a secret`]);
        }
    }

    console.log(`gift webhooks server: ${headline(state)}`);
    console.log('');
    const width = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
        console.log(`  ${label.padEnd(width)}  ${value}`);
    }
    console.log('');

    if (state.health.ok) {
        console.log('`gift log` follows what it writes; `gift stop` stops it.');
        return;
    }
    if (state.pm2.state === 'no-pm2') {
        console.log('`gift serve` starts the server under PM2 — install it with `npm i -g pm2`.');
        return;
    }
    console.log('Start it with `gift serve`, then `gift log` for what it says.');
}

/** The same picture as a value, for `--json`. */
function asJson(state) {
    return {
        running: state.health.ok,
        pm2: { name: state.pm2Name, ...state.pm2 },
        endpoint: {
            host: state.settings.host,
            port: state.settings.port,
            path: state.settings.path,
            url: `http://${authority(state.settings.host, state.settings.port)}${state.settings.path}`,
        },
        health: state.health,
        config: {
            file: state.settings.config.file,
            missing: state.settings.config.missing || undefined,
            error: state.settings.config.unreadable || undefined,
            hooks: state.settings.hooks.map((hook, index) => ({
                name: String(hook.name || `hook-${index + 1}`),
                repo: hook.repo || '*',
                events: Array.isArray(hook.events) && hook.events.length ? hook.events : ['push'],
            })),
        },
        log: state.log.off
            ? { off: true }
            : {
                path: state.log.path,
                bytes: state.log.bytes,
                modified: state.log.modified ? state.log.modified.toISOString() : undefined,
                missing: state.log.missing || undefined,
            },
        missingSecrets: state.missingSecrets,
        secrets: state.secrets,
        version: version(),
    };
}

// ------------------------------------------------------------------ dispatch ---

function usage() {
    console.log('usage: gift status');
    console.log('');
    console.log('Report the webhooks server: what PM2 says about the process, what the');
    console.log('server answers on GET /health, and what it is set up to serve — the');
    console.log('endpoint, the hooks, the log, and a fingerprint of the secret in .env');
    console.log('to compare with the one the server logs. Nothing is started or stopped.');
    console.log('');
    console.log('options:');
    console.log('  --json          Print the report as JSON, for a script');
    console.log(`  --timeout=SEC   How long to wait for the health check (default: ${DEFAULT_TIMEOUT_MS / 1000})`);
    console.log('  --config=FILE   Hook configuration file (default: webhooks/hooks.json)');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('The exit code is 0 when the server answers and 1 when it does not, so');
    console.log('`gift status >/dev/null && echo up` works in a script. A process PM2 calls');
    console.log('online that answers nothing is reported as not answering, not as up.');
}

function parseArgs(argv) {
    const options = { help: false, json: false, timeout: DEFAULT_TIMEOUT_MS };

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '--json') options.json = true;
        else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('--timeout=')) {
            const seconds = Number(arg.slice(10));
            if (!Number.isFinite(seconds) || seconds <= 0) {
                throw new Error(`'${arg.slice(10)}' is not a number of seconds`);
            }
            options.timeout = Math.round(seconds * 1000);
        } else if (arg.startsWith('-')) {
            throw new Error(`unknown option '${arg}' (try: gift status --help)`);
        } else throw new Error(`'${arg}' is not expected — status takes no arguments`);
    }
    return options;
}

async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        console.error(`gift status: ${err.message}`);
        return 2;
    }

    if (options.help) {
        usage();
        return 0;
    }

    try {
        const settings = settingsFrom(options);
        const pm2Name = process.env.PM2_NAME || DEFAULT_PM2_NAME;

        const state = {
            pm2Name,
            pm2: pm2State(pm2Name),
            settings,
            log: logState(settings.log),
            missingSecrets: missingSecrets(settings.hooks),
            secrets: secretFingerprints(settings.hooks),
            health: await health(settings.host, settings.port, options.timeout),
        };

        if (options.json) console.log(JSON.stringify(asJson(state), null, 2));
        else printReport(state);

        return state.health.ok ? 0 : 1;
    } catch (err) {
        console.error(`gift status: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

module.exports = { main, usage, probe, since, bytes, headline };
