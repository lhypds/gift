#!/usr/bin/env node
// gift serve — the hooks server.
//
// One process watching four kinds of thing. A hook says what has to happen
// (its `trigger`) and what to run when it does (a bash script), and this is
// what sits between them: it reads hooks.json, hands each hook to the trigger
// that owns its type, and gives all of them the same way to run a script, the
// same log and the same dashboard.
//
//     github      an HTTP endpoint receiving GitHub webhook deliveries
//     clipboard   the clipboard, read on a timer
//     website     a URL, polled
//     file        a file or folder, watched
//
// The triggers live in triggers/, one folder each, and nothing here knows what
// any of them do — adding a fifth is dropping a folder in beside them.
//
// Configuration: hooks.json (see hooks.example.json).
// Activity log:  hooks.log (--log=FILE, or --no-log for console only).
// Request log:   server.log (one line for every HTTP request).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
    log, openLog, openRequestLog, openErrorLog, openHookLogs,
    appendRequestLog, appendErrorLog,
    logFile, requestLogFile, errorLogFile, formatFields, stamp,
} = require('./utils/log.js');
const hookRecord = require('./utils/hook.js');
const triggers = require('./triggers/index.js');
const { createRuntime } = require('./triggers/runtime.js');
const github = require('./triggers/github/index.js');

const HERE = __dirname;
const WEB_DIST = path.join(HERE, 'web', 'dist');
const DEFAULT_CONFIG = path.join(HERE, 'hooks.json');
const EXAMPLE_CONFIG = path.join(HERE, 'hooks.example.json');
const DEFAULT_LOG = path.join(HERE, 'hooks.log');
const DEFAULT_REQUEST_LOG = path.join(HERE, 'server.log');
// One folder per hook, holding that hook's saved responses and its error log.
const DEFAULT_HOOK_LOG_DIR = path.join(HERE, 'logs', 'hooks');
// The errors that belong to no hook, beside those folders — and deliberately
// not configurable: the whole point of it is to have somewhere to write when
// the config is the thing that is broken.
const DEFAULT_ERROR_LOG = path.join(DEFAULT_HOOK_LOG_DIR, 'error.log');
const DEFAULT_EVENTS_FILE = path.join(HERE, 'events.json');

const DEFAULTS = {
    host: '127.0.0.1',
    port: 3999,
    path: github.DEFAULT_PATH,
};

// ------------------------------------------------------------------- args ---

function usage() {
    console.log(`usage: gift serve [options]

Watch for the triggers configured in hooks.json and run their scripts.

options:
  --config=FILE    Hook configuration file (default: hooks.json)
  --host=HOST      Interface to bind (default: ${DEFAULTS.host})
  --port=PORT      Port to listen on (default: ${DEFAULTS.port})
  --path=PATH      GitHub webhook endpoint path (default: ${DEFAULTS.path})
  --log=FILE       Log file to append to (default: hooks.log)
  --no-log         Log to the console only, writing no file
  --only=TYPE      Start only this trigger type — repeatable, for debugging
  --dry-run        Notice events and match hooks, but never run a script
  -h, --help       Show this help

trigger types: ${triggers.names().join(', ')}

environment (from config.json, or the real environment, which wins):
  GITHUB_WEBHOOK_SECRET   Secret configured on the GitHub webhook
  GIFT_SERVE_HOST         Default for --host
  PORT                    Default for --port (GIFT_SERVE_PORT overrides it)
  GIFT_SERVE_PATH         Default for --path
  GIFT_SERVE_LOG          Default for --log ('off' for no file)

Dashboard:    GET http://HOST:PORT/
Health check: GET http://HOST:PORT/health`);
}

function parseArgs(argv) {
    const options = { dryRun: false, help: false, only: [] };
    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
        else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('--host=')) options.host = arg.slice(7);
        else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
        else if (arg.startsWith('--path=')) options.path = arg.slice(7);
        else if (arg.startsWith('--log=')) options.log = arg.slice(6);
        else if (arg.startsWith('--only=')) options.only.push(arg.slice(7));
        else if (arg === '--no-log') options.log = 'off';
        else throw new Error(`unknown option '${arg}' (try: gift serve --help)`);
    }
    if (options.port !== undefined && !Number.isInteger(options.port)) {
        throw new Error('--port must be an integer');
    }
    for (const only of options.only) {
        if (!triggers.get(only)) {
            throw new Error(`--only=${only} is not a trigger type (try: ${triggers.names().join(', ')})`);
        }
    }
    return options;
}

// ----------------------------------------------------------------- config ---

/**
 * hooks.json, with every hook read into the shape the rest of the server uses.
 * A hook that cannot be read stops the server: a deploy that half-loads its
 * configuration and runs anyway is worse than one that refuses to start.
 */
function loadConfig(file) {
    if (!fs.existsSync(file)) return { hooks: [], missing: true };

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`${file}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error(`${file}: expected a JSON object`);

    const hooks = (parsed.hooks || []).map((hook, index) => {
        try {
            return hookRecord.normalize(hook, index);
        } catch (err) {
            throw new Error(`${file}: ${err.message}`);
        }
    });

    return { ...parsed, hooks };
}

/** The hooks of one type, in the order they are written. */
function hooksOfType(hooks, type) {
    return hooks.filter((hook) => hook.trigger.type === type);
}

// ------------------------------------------------------------------ server ---

/** A one-line access log entry for every request, however it ends. */
function accessLogMiddleware(req, res, next) {
    const startedAt = Date.now();
    const pathName = req.path;
    const from = req.socket.remoteAddress;
    let logged = false;
    const recordRequest = (status) => {
        if (logged) return;
        logged = true;
        const level = status === 'aborted' || status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        const extra = formatFields({
            method: req.method,
            path: pathName,
            status,
            from,
            bytes: req.headers['content-length'],
            event: req.headers['x-github-event'],
            delivery: req.headers['x-github-delivery'],
            agent: req.headers['user-agent'],
            ms: Date.now() - startedAt,
        });
        appendRequestLog(`${stamp()}  ${level.padEnd(5)}  request  ${extra}\n`);
    };
    res.on('finish', () => recordRequest(res.statusCode));
    res.on('close', () => {
        if (!res.writableFinished) recordRequest('aborted');
    });
    next();
}

// Same-origin only: the React bundle and its GET /api/status calls are all
// this server's own scripts, nothing from anywhere else.
const CSP = `default-src 'self'; base-uri 'none'; frame-ancestors 'none'`;

function securityHeaders(req, res, next) {
    res.setHeader('content-security-policy', CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    next();
}

function sendText(res, status, body) {
    res.status(status).set('content-type', 'text/plain; charset=utf-8').send(body);
}

/** Keep credential material out of the dashboard's otherwise-readable config. */
function redactHooksJson(text) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.hooks)) {
        for (const hook of parsed.hooks) {
            if (!hook || !hook.trigger || hook.trigger.credentials === undefined) continue;
            hook.trigger.credentials = '[redacted — edit hooks.json on disk]';
        }
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
}

// --------------------------------------------------------------- dashboard ---
//
// The read-only data behind GET /api/status. web/dist (built by `pnpm run
// build`) is the React app that renders it; this hands over plain data, not
// HTML, so nothing here needs escaping — React does that on its own.

function dashboardData(config, runtime) {
    const hooks = (Array.isArray(config.hooks) ? config.hooks : []).map((hook, index) => {
        const type = hookRecord.typeOf(hook);
        const module_ = triggers.get(type);
        return {
            name: hook.name || `hook-${index + 1}`,
            trigger: type,
            title: module_ ? module_.title : type,
            summary: hookRecord.line(hook),
            run: hook.run || 'Not configured',
            enabled: hook.enabled !== false,
        };
    });

    const events = runtime.events.map((event) => {
        const receivedAt = new Date(event.receivedAt);
        const validTime = !Number.isNaN(receivedAt.getTime());

        return {
            id: event.id || 'No id',
            trigger: event.trigger || 'unknown',
            event: event.kind || event.trigger || 'Unknown',
            // A label, and a link when the trigger could resolve one — a
            // repository on GitHub, the URL a website hook polls. A clipboard
            // or a file has nothing to link to, and gets the label alone.
            source: event.link || { label: event.title || '—', href: null, title: null },
            timestamp: validTime ? receivedAt.toISOString() : null,
            outcome: event.outcome || 'Receiving',
            tone: event.tone || 'neutral',
            detail: event.detail || null,
            runs: Array.isArray(event.runs)
                ? event.runs.map((run) => ({
                    hook: run.hook,
                    startedAt: run.startedAt || null,
                    ms: typeof run.ms === 'number' ? run.ms : null,
                    exit: typeof run.exit === 'number' ? run.exit : null,
                    signal: run.signal || null,
                    error: run.error || null,
                    output: run.output || '',
                }))
                : [],
        };
    });

    return { hooks, events };
}

/**
 * Build the express app and mount whatever HTTP routes the triggers want.
 *
 * Order matters and is the whole reason this is one function: the dashboard and
 * the API answer first, then each trigger's own routes, then a 404 for
 * everything left. A trigger mounted after the catch-all would never be reached.
 *
 * @returns {{app: object, mounted: Map<string, object>}}
 */
function createApp(config, options, runtime) {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.use(accessLogMiddleware);

    app.get('/health', (req, res) => {
        sendText(res, 200, 'ok');
    });

    app.get('/api/status', (req, res) => {
        res.set('cache-control', 'no-store');
        runtime.prune();
        res.json(dashboardData(config, runtime));
    });

    // Read fresh so the panel reflects edits made without restarting. Website
    // credentials are deliberately redacted: this endpoint is for inspecting
    // hook structure, not moving cookies and access tokens into a browser.
    app.get('/api/hooks.json', (req, res) => {
        res.set('cache-control', 'no-store');
        fs.readFile(options.configFile, 'utf8', (err, data) => {
            if (err) {
                sendText(res, 404, `${path.basename(options.configFile)} not found`);
                return;
            }
            try {
                res.set('content-type', 'application/json; charset=utf-8').send(redactHooksJson(data));
            } catch {
                sendText(res, 500, `${path.basename(options.configFile)} is not valid JSON`);
            }
        });
    });

    // The built React app. index.html stays uncached — it names the current
    // hashed asset files, and those change on every build.
    app.use(express.static(WEB_DIST, {
        setHeaders(res, filePath) {
            if (path.basename(filePath) === 'index.html') res.setHeader('cache-control', 'no-store');
        },
    }));

    // Whatever a trigger wants to answer. Only the ones with hooks are mounted:
    // an endpoint listening for a trigger nobody configured is a surface with
    // no purpose.
    const mounted = new Map();
    for (const trigger of triggers.list()) {
        if (typeof trigger.mount !== 'function') continue;
        if (options.only.length && !options.only.includes(trigger.name)) continue;

        const hooks = hooksOfType(config.hooks, trigger.name);
        if (hooks.length === 0) continue;

        const result = trigger.mount({ hooks, runtime, options, express });
        if (result && result.middleware) app.use(result.middleware);
        mounted.set(trigger.name, result || {});
    }

    // Whatever falls through everything above: not a trigger's, not a static
    // file, not the API. A plain 404.
    app.use((req, res) => {
        log('warn', 'request to an unknown path', {
            status: 404,
            method: req.method,
            path: req.path,
            from: req.socket.remoteAddress,
            agent: req.headers['user-agent'],
        });
        sendText(res, 404, 'Not found');
    });

    return { app, mounted };
}

/**
 * Start every trigger that has hooks. A trigger that throws on the way up takes
 * itself out and leaves the others running: a clipboard tool that is not
 * installed is no reason for the webhook endpoint to stop answering.
 *
 * @returns {Array<{name: string, stop(): void}>}
 */
function startTriggers(config, options, runtime, mounted) {
    const started = [];

    for (const trigger of triggers.list()) {
        if (options.only.length && !options.only.includes(trigger.name)) continue;

        const hooks = hooksOfType(config.hooks, trigger.name).filter((hook) => hook.enabled);
        const configured = hooksOfType(config.hooks, trigger.name).length;
        if (configured > hooks.length) {
            log('info', `${configured - hooks.length} ${trigger.name} hook(s) are turned off`, {
                trigger: trigger.name,
            });
        }
        if (hooks.length === 0) continue;

        try {
            const handle = trigger.start({
                hooks,
                runtime,
                options,
                ...(mounted.get(trigger.name) || {}),
            });
            started.push({ name: trigger.name, stop: handle && handle.stop ? () => handle.stop() : () => {} });
        } catch (err) {
            log('error', `the ${trigger.name} trigger could not start: ${err.message}`, {
                hooks: hooks.map((hook) => hook.name).join('|'),
            });
        }
    }

    return started;
}

// -------------------------------------------------------------------- main ---

/**
 * A refusal to start. Said plainly on the terminal, where somebody typing
 * `gift serve` is watching, and written to error.log, where somebody wondering
 * why PM2 keeps restarting a server that logs nothing will look.
 */
function refuseToStart(message) {
    console.error(`gift serve: ${message}`);
    appendErrorLog(`${stamp()}  error  ${message}\n`);
}

function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        console.error(`gift serve: ${err.message}`);
        return 2;
    }

    if (options.help) {
        usage();
        return 0;
    }

    // `gift serve` already loaded the settings; do it here too so that
    // `node serve.js` and a systemd unit behave the same way.
    try {
        require('./utils/config.js').loadFor();
    } catch {
        /* running outside the repo — rely on the real environment */
    }

    // Before the config is read, because a config that cannot be read is the
    // failure most in need of somewhere to be written down. hooks.log cannot
    // take it: which file that is comes out of the config that just failed.
    openErrorLog(DEFAULT_ERROR_LOG);
    openHookLogs(DEFAULT_HOOK_LOG_DIR);

    const configFile = path.resolve(options.config || process.env.GIFT_SERVE_CONFIG || DEFAULT_CONFIG);
    let config;
    try {
        config = loadConfig(configFile);
    } catch (err) {
        refuseToStart(err.message);
        return 1;
    }

    const settings = {
        host: options.host || process.env.GIFT_SERVE_HOST || config.host || DEFAULTS.host,
        port: Number(
            options.port || process.env.GIFT_SERVE_PORT || process.env.PORT || config.port || DEFAULTS.port,
        ),
        path: options.path || process.env.GIFT_SERVE_PATH || config.path || DEFAULTS.path,
        // Blank falls through to the next source: an empty GIFT_SERVE_LOG means
        // "unset", not "no log".
        log: options.log || process.env.GIFT_SERVE_LOG || config.log || DEFAULT_LOG,
        dryRun: options.dryRun,
        only: options.only,
        configFile,
        eventsFile: DEFAULT_EVENTS_FILE,
        responseLogDir: DEFAULT_HOOK_LOG_DIR,
    };
    if (!settings.path.startsWith('/')) settings.path = `/${settings.path}`;

    // Turning the file off takes saying so — 'off' (--no-log passes it). Any
    // other value is a file, resolved against this folder when it is relative.
    const off = ['off', 'none', 'no', 'false'];
    openLog(off.includes(String(settings.log).trim().toLowerCase())
        ? null
        : path.resolve(HERE, settings.log));
    openRequestLog(DEFAULT_REQUEST_LOG);

    if (config.missing) {
        log('warn', `no ${path.basename(configFile)} found — nothing is being watched`, {
            hint: `cp ${path.relative(process.cwd(), EXAMPLE_CONFIG)} ${path.relative(process.cwd(), configFile)}`,
        });
    }

    if (!fs.existsSync(WEB_DIST)) {
        log('warn', `${path.relative(HERE, WEB_DIST)} not found — the dashboard will 404 until it is built`, {
            hint: 'pnpm run build',
        });
    }

    for (const hook of config.hooks) {
        try {
            fs.accessSync(hook.run, fs.constants.X_OK);
        } catch {
            log('warn', 'hook script is missing or not executable', { hook: hook.name, run: hook.run });
        }
    }

    const runtime = createRuntime(settings);
    const { app, mounted } = createApp(config, settings, runtime);
    let started = [];

    const server = app.listen(settings.port, settings.host, () => {
        log('info', `gift hooks listening on http://${settings.host}:${settings.port}`);
        log('info', `health check: http://${settings.host}:${settings.port}/health`);
        log('info', `config ${configFile}`);
        log('info', logFile.path ? `log ${logFile.path}` : 'log console only (--no-log)');
        log('info', `request log ${requestLogFile.path}`);
        if (errorLogFile.path) {
            log('info', `error log ${errorLogFile.path}, and ${path.join(DEFAULT_HOOK_LOG_DIR, '<hook>', 'error.log')}`);
        }
        log('info', `events ${settings.eventsFile}`);
        if (settings.dryRun) log('warn', 'dry run — hook scripts will not be executed');
        if (settings.only.length) log('warn', `only the ${settings.only.join(', ')} trigger(s) will start`);

        if (config.hooks.length === 0) {
            log('info', 'no hooks configured — `gift create` adds one');
        }
        for (const hook of config.hooks) {
            log('info', `hook ${hook.name}`, {
                trigger: hook.trigger.type,
                watches: hookRecord.line(hook),
                run: hook.run,
                enabled: hook.enabled ? undefined : 'no',
            });
        }

        // Started once the port is actually open, so a second gift losing the
        // EADDRINUSE race does not spend a moment watching the same clipboard.
        started = startTriggers(config, settings, runtime, mounted);
        if (started.length === 0 && config.hooks.length > 0) {
            log('warn', 'no trigger is watching anything — every configured hook is off, or its trigger failed to start');
        }
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log('error', `port ${settings.port} is already in use`);
        } else {
            log('error', `server error: ${err.message}`);
        }
        process.exitCode = 1;
    });

    const shutdown = (signal) => {
        log('info', `${signal} received, shutting down`);
        for (const trigger of started) {
            try {
                trigger.stop();
            } catch (err) {
                log('warn', `the ${trigger.name} trigger did not stop cleanly: ${err.message}`);
            }
        }
        server.close(() => process.exit(0));
        // Don't wait forever on keep-alive connections.
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return 0;
}

if (require.main === module) {
    const code = main(process.argv.slice(2));
    if (code !== 0) process.exitCode = code;
}

module.exports = {
    createApp,
    startTriggers,
    loadConfig,
    hooksOfType,
    dashboardData,
    redactHooksJson,
    openLog,
    openRequestLog,
    main,
    // The GitHub trigger's internals were once this file's, and `gift status`
    // and the tests still reach for them by these names.
    verifySignature: github.receiver.verifySignature,
    signatureCandidates: github.receiver.signatureCandidates,
    explainSignatureFailure: github.receiver.explainSignatureFailure,
    fingerprint: github.receiver.fingerprint,
    collectSecrets: github.receiver.collectSecrets,
    matches: github.receiver.matches,
};
