#!/usr/bin/env node
// gift serve — a GitHub webhook receiver.
//
// Listens for webhook deliveries, verifies the X-Hub-Signature-256 HMAC against
// the shared secret, and runs a *locally configured* script for the deliveries
// that match. Nothing from the payload is ever used to build a command: hooks
// may only run scripts named in hooks.json, and payload fields reach them as
// environment variables.
//
// Configuration: webhooks/hooks.json (see hooks.example.json).
// Secret:        GITHUB_WEBHOOK_SECRET in webhooks/.env or the environment.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HERE = __dirname;
const DEFAULT_CONFIG = path.join(HERE, 'hooks.json');
const EXAMPLE_CONFIG = path.join(HERE, 'hooks.example.json');

// GitHub rejects payloads above 25 MB, so anything larger is not from GitHub.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const DEFAULTS = {
    host: '127.0.0.1',
    port: 3001,
    path: '/hooks/github',
};

// ---------------------------------------------------------------- logging ---

function stamp() {
    return new Date().toISOString();
}

function log(level, message, fields = {}) {
    const extra = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    const line = `${stamp()}  ${level.padEnd(5)}  ${message}${extra ? '  ' + extra : ''}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
}

// ------------------------------------------------------------------- args ---

function usage() {
    console.log(`usage: gift serve [options]

Receive GitHub webhook deliveries and run the scripts configured in hooks.json.

options:
  --config=FILE    Hook configuration file (default: webhooks/hooks.json)
  --host=HOST      Interface to bind (default: ${DEFAULTS.host})
  --port=PORT      Port to listen on (default: ${DEFAULTS.port})
  --path=PATH      Webhook endpoint path (default: ${DEFAULTS.path})
  --dry-run        Verify and match deliveries, but never run a hook script
  -h, --help       Show this help

environment (from webhooks/.env, or the real environment, which wins):
  GITHUB_WEBHOOK_SECRET   Secret configured on the GitHub webhook (required)
  GIFT_SERVE_HOST         Default for --host
  PORT                    Default for --port (GIFT_SERVE_PORT overrides it)
  GIFT_SERVE_PATH         Default for --path

Health check: GET http://HOST:PORT/health`);
}

function parseArgs(argv) {
    const options = { dryRun: false, help: false };
    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
        else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('--host=')) options.host = arg.slice(7);
        else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
        else if (arg.startsWith('--path=')) options.path = arg.slice(7);
        else throw new Error(`unknown option '${arg}' (try: gift serve --help)`);
    }
    if (options.port !== undefined && !Number.isInteger(options.port)) {
        throw new Error('--port must be an integer');
    }
    return options;
}

// ----------------------------------------------------------------- config ---

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
        const name = hook.name || `hook-${index + 1}`;
        if (!hook.run) throw new Error(`${file}: hook '${name}' has no "run" script`);
        return {
            name,
            repo: hook.repo || '*',
            events: hook.events && hook.events.length ? hook.events : ['push'],
            branches: hook.branches || [],
            run: path.resolve(HERE, hook.run),
            args: hook.args || [],
            cwd: hook.cwd ? path.resolve(HERE, hook.cwd) : undefined,
            detach: Boolean(hook.detach),
            secretEnv: hook.secretEnv || 'GITHUB_WEBHOOK_SECRET',
        };
    });

    return { ...parsed, hooks };
}

/** Every secret the server will accept, keyed by the env var it came from. */
function collectSecrets(hooks) {
    const names = new Set(['GITHUB_WEBHOOK_SECRET', ...hooks.map((h) => h.secretEnv)]);
    const secrets = new Map();
    for (const name of names) {
        const value = process.env[name];
        if (value) secrets.set(name, value);
    }
    return secrets;
}

// ------------------------------------------------------------ verification ---

/**
 * Check the delivery signature against every configured secret.
 * @returns {string[]} names of the env vars whose secret matched.
 */
function verifySignature(rawBody, signatureHeader, secrets) {
    if (!signatureHeader) return [];
    const received = Buffer.from(String(signatureHeader));

    const matched = [];
    for (const [name, secret] of secrets) {
        const expected = Buffer.from(
            'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
        );
        if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
            matched.push(name);
        }
    }
    return matched;
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let done = false;

        req.on('data', (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > limit) {
                done = true;
                req.destroy();
                const err = new Error('payload too large');
                err.code = 'TOO_LARGE';
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!done) resolve(Buffer.concat(chunks));
        });
        req.on('error', (err) => {
            if (!done) reject(err);
        });
    });
}

// ---------------------------------------------------------------- matching ---

function branchOf(ref) {
    return typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice(11) : null;
}

function matches(hook, { event, repo, ref, secretNames }) {
    if (!secretNames.includes(hook.secretEnv)) return false;
    if (!hook.events.includes('*') && !hook.events.includes(event)) return false;
    if (hook.repo !== '*' && String(hook.repo).toLowerCase() !== String(repo || '').toLowerCase()) {
        return false;
    }
    if (hook.branches.length && !hook.branches.includes('*')) {
        const branch = branchOf(ref);
        if (!branch || !hook.branches.includes(branch)) return false;
    }
    return true;
}

// --------------------------------------------------------------- execution ---

// One run at a time per hook. A delivery that arrives mid-run is coalesced into
// a single follow-up run, so a burst of pushes never stacks up deployments.
const state = new Map();

function stateOf(hook) {
    if (!state.has(hook.name)) state.set(hook.name, { running: false, pending: null });
    return state.get(hook.name);
}

function writePayloadFile(delivery, rawBody) {
    const safeId = String(delivery || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
    const file = path.join(os.tmpdir(), `gift-webhook-${safeId || 'unknown'}.json`);
    fs.writeFileSync(file, rawBody, { mode: 0o600 });
    return file;
}

function removeQuietly(file) {
    try {
        fs.unlinkSync(file);
    } catch {
        /* already gone */
    }
}

function pipeOutput(stream, hookName, level) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) log(level, `[${hookName}] ${line}`);
    });
    stream.on('end', () => {
        if (buffer.trim()) log(level, `[${hookName}] ${buffer.trim()}`);
    });
}

function runHook(hook, delivery, options) {
    const status = stateOf(hook);
    if (!hook.detach && status.running) {
        status.pending = delivery;
        log('info', `hook busy, queued one re-run`, { hook: hook.name, delivery: delivery.id });
        return;
    }

    if (options.dryRun) {
        log('info', 'dry run, not executing', { hook: hook.name, run: hook.run });
        return;
    }

    const payloadFile = writePayloadFile(delivery.id, delivery.rawBody);
    const childEnv = {
        ...process.env,
        GIFT_HOOK: hook.name,
        GIFT_EVENT: delivery.event,
        GIFT_DELIVERY: delivery.id || '',
        GIFT_REPO: delivery.repo || '',
        GIFT_REF: delivery.ref || '',
        GIFT_BRANCH: branchOf(delivery.ref) || '',
        GIFT_BEFORE: delivery.before || '',
        GIFT_AFTER: delivery.after || '',
        GIFT_SENDER: delivery.sender || '',
        GIFT_PAYLOAD_FILE: payloadFile,
    };

    log('info', 'running hook', { hook: hook.name, run: hook.run, delivery: delivery.id });

    // Arguments come from hooks.json only — never from the payload — and the
    // child is spawned without a shell, so nothing can be injected.
    const child = spawn(hook.run, hook.args, {
        cwd: hook.cwd || path.dirname(hook.run),
        env: childEnv,
        detached: hook.detach,
        stdio: hook.detach ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });

    if (hook.detach) {
        child.unref();
        child.on('error', (err) => {
            log('error', `hook failed to start: ${err.message}`, { hook: hook.name });
            removeQuietly(payloadFile);
        });
        // The script owns its lifetime now; give it a window to read the payload.
        setTimeout(() => removeQuietly(payloadFile), 5 * 60 * 1000).unref();
        return;
    }

    status.running = true;
    pipeOutput(child.stdout, hook.name, 'info');
    pipeOutput(child.stderr, hook.name, 'warn');

    child.on('error', (err) => {
        log('error', `hook failed to start: ${err.message}`, { hook: hook.name });
    });

    child.on('close', (code, signal) => {
        removeQuietly(payloadFile);
        status.running = false;
        const level = code === 0 ? 'info' : 'error';
        log(level, 'hook finished', { hook: hook.name, code: signal || code });

        const queued = status.pending;
        if (queued) {
            status.pending = null;
            runHook(hook, queued, options);
        }
    });
}

// ------------------------------------------------------------------ server ---

function send(res, status, body) {
    res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function createServer(config, secrets, options) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/health') {
            send(res, 200, 'ok');
            return;
        }

        if (url.pathname !== options.path) {
            send(res, 404, 'Not found');
            return;
        }

        if (req.method !== 'POST') {
            res.setHeader('allow', 'POST');
            send(res, 405, 'Method not allowed');
            return;
        }

        const event = req.headers['x-github-event'];
        const deliveryId = req.headers['x-github-delivery'];
        const signature = req.headers['x-hub-signature-256'];

        let rawBody;
        try {
            rawBody = await readBody(req, MAX_BODY_BYTES);
        } catch (err) {
            if (err.code === 'TOO_LARGE') {
                log('warn', 'rejected oversized payload', { delivery: deliveryId });
                send(res, 413, 'Payload too large');
            } else {
                log('warn', `request read failed: ${err.message}`, { delivery: deliveryId });
                if (!res.headersSent) send(res, 400, 'Bad request');
            }
            return;
        }

        const secretNames = verifySignature(rawBody, signature, secrets);
        if (secretNames.length === 0) {
            log('warn', signature ? 'invalid signature' : 'missing signature', {
                delivery: deliveryId,
                event,
                from: req.socket.remoteAddress,
            });
            send(res, 401, signature ? 'Invalid signature' : 'Missing signature');
            return;
        }

        let payload;
        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
            log('warn', 'invalid JSON payload', { delivery: deliveryId, event });
            send(res, 400, 'Invalid JSON');
            return;
        }

        const repo = payload.repository && payload.repository.full_name;
        const delivery = {
            id: deliveryId,
            event,
            rawBody,
            repo,
            ref: payload.ref,
            before: payload.before,
            after: payload.after,
            sender: payload.sender && payload.sender.login,
        };

        log('info', 'delivery accepted', {
            event,
            delivery: deliveryId,
            repo,
            ref: payload.ref,
            sender: delivery.sender,
        });

        // GitHub sends `ping` right after a webhook is created.
        if (event === 'ping') {
            send(res, 200, 'pong');
            return;
        }

        const triggered = config.hooks.filter((hook) =>
            matches(hook, { event, repo, ref: payload.ref, secretNames })
        );

        if (triggered.length === 0) {
            log('info', 'no hook matched', { event, delivery: deliveryId, repo });
            send(res, 200, 'No hook matched');
            return;
        }

        // Answer GitHub before doing any work: deliveries time out after 10s.
        send(res, 202, `Accepted: ${triggered.map((h) => h.name).join(', ')}`);

        for (const hook of triggered) {
            try {
                runHook(hook, delivery, options);
            } catch (err) {
                log('error', `hook error: ${err.message}`, { hook: hook.name });
            }
        }
    });
}

// -------------------------------------------------------------------- main ---

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

    // `gift serve` already loaded webhooks/.env; do it here too so that
    // `node webhooks/server.js` and a systemd unit behave the same way.
    try {
        require('../lib/env.js').loadFor(HERE);
    } catch {
        /* running outside the repo — rely on the real environment */
    }

    const configFile = path.resolve(options.config || process.env.GIFT_SERVE_CONFIG || DEFAULT_CONFIG);
    let config;
    try {
        config = loadConfig(configFile);
    } catch (err) {
        console.error(`gift serve: ${err.message}`);
        return 1;
    }

    const settings = {
        host: options.host || process.env.GIFT_SERVE_HOST || config.host || DEFAULTS.host,
        port: Number(
            options.port || process.env.GIFT_SERVE_PORT || process.env.PORT || config.port || DEFAULTS.port,
        ),
        path: options.path || process.env.GIFT_SERVE_PATH || config.path || DEFAULTS.path,
        dryRun: options.dryRun,
    };
    if (!settings.path.startsWith('/')) settings.path = `/${settings.path}`;

    const secrets = collectSecrets(config.hooks);
    if (secrets.size === 0) {
        console.error(`gift serve: no webhook secret configured.

Set GITHUB_WEBHOOK_SECRET in webhooks/.env (or the environment) to the same
value as the webhook's "Secret" field on GitHub. Generate one with:

    openssl rand -hex 32`);
        return 1;
    }

    if (config.missing) {
        log('warn', `no ${path.basename(configFile)} found — deliveries will be logged only`, {
            hint: `cp ${path.relative(process.cwd(), EXAMPLE_CONFIG)} ${path.relative(process.cwd(), configFile)}`,
        });
    }

    for (const hook of config.hooks) {
        try {
            fs.accessSync(hook.run, fs.constants.X_OK);
        } catch {
            log('warn', 'hook script is missing or not executable', {
                hook: hook.name,
                run: hook.run,
            });
        }
    }

    const server = createServer({ ...config, path: settings.path }, secrets, settings);

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log('error', `port ${settings.port} is already in use`);
        } else {
            log('error', `server error: ${err.message}`);
        }
        process.exitCode = 1;
    });

    server.listen(settings.port, settings.host, () => {
        log('info', `gift serve listening on http://${settings.host}:${settings.port}${settings.path}`);
        log('info', `health check on http://${settings.host}:${settings.port}/health`);
        log('info', `config ${configFile}`);
        log('info', `secrets accepted from ${[...secrets.keys()].join(', ')}`);
        if (settings.dryRun) log('warn', 'dry run — hook scripts will not be executed');
        if (config.hooks.length === 0) {
            log('info', 'no hooks configured');
        }
        for (const hook of config.hooks) {
            log('info', `hook ${hook.name}`, {
                repo: hook.repo,
                events: hook.events.join('|'),
                branches: hook.branches.length ? hook.branches.join('|') : 'any',
                run: hook.run,
            });
        }
    });

    const shutdown = (signal) => {
        log('info', `${signal} received, shutting down`);
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

module.exports = { createServer, verifySignature, matches, loadConfig, collectSecrets, main };
