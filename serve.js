#!/usr/bin/env node
// gift serve — a GitHub webhook receiver.
//
// Listens for webhook deliveries, verifies the X-Hub-Signature-256 HMAC against
// the shared secret, and runs a *locally configured* script for the deliveries
// that match. Nothing from the payload is ever used to build a command: hooks
// may only run scripts named in hooks.json, and payload fields reach them as
// environment variables.
//
// Configuration: hooks.json (see hooks.example.json).
// Secret:        GITHUB_WEBHOOK_SECRET in .env or the environment.
// Activity log:  hooks.log (--log=FILE, or --no-log for console only).
// Request log:   server.log (one line for every HTTP request).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const HERE = __dirname;
const WEB_DIR = path.join(HERE, 'web');
const WEB_DIST = path.join(WEB_DIR, 'dist');
const DEFAULT_CONFIG = path.join(HERE, 'hooks.json');
const EXAMPLE_CONFIG = path.join(HERE, 'hooks.example.json');
const DEFAULT_LOG = path.join(HERE, 'hooks.log');
const DEFAULT_REQUEST_LOG = path.join(HERE, 'server.log');
const DEFAULT_DELIVERIES_FILE = path.join(HERE, 'deliveries.json');

// GitHub rejects payloads above 25 MB, so anything larger is not from GitHub.
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const RECENT_DELIVERY_LIMIT = 20;

const DEFAULTS = {
    host: '127.0.0.1',
    port: 3999,
    path: '/hooks/github',
};

// ---------------------------------------------------------------- logging ---
//
// Every line goes to the console and, unless file logging is turned off, is
// appended to hooks.log as well: the delivery that arrived, whether its
// signature verified, which hooks matched, exactly what was executed, whatever
// the script printed, and how it ended. That history survives a restart, which
// is what `pm2 logs` alone does not give you.

// Rotate past this size, keeping one previous file (hooks.log.1).
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const logFile = { path: null, bytes: 0, disabled: false };
const requestLogFile = { path: null, bytes: 0, disabled: false };

function openLogFile(target, file) {
    target.path = file || null;
    target.bytes = 0;
    target.disabled = false;
    if (!target.path) return;

    try {
        fs.mkdirSync(path.dirname(target.path), { recursive: true });
        // Create it here, with a restrictive mode, so no later append can be the
        // call that makes a world-readable log.
        fs.appendFileSync(target.path, '', { mode: 0o600 });
        target.bytes = fs.statSync(target.path).size;
    } catch (err) {
        target.disabled = true;
        console.error(`${stamp()}  warn   cannot open ${target.path}: ${err.message}`);
    }
}

/** Start appending detailed server activity to `file`. */
function openLog(file) {
    openLogFile(logFile, file);
}

/** Start the access log that receives exactly one line per HTTP request. */
function openRequestLog(file = DEFAULT_REQUEST_LOG) {
    openLogFile(requestLogFile, file);
}

function rotateLog(target) {
    // rename() replaces an existing .1, so exactly one old file is kept.
    fs.renameSync(target.path, `${target.path}.1`);
    target.bytes = 0;
}

function appendLogFile(target, line) {
    if (!target.path || target.disabled) return;
    const bytes = Buffer.byteLength(line);
    try {
        if (target.bytes + bytes > LOG_MAX_BYTES) rotateLog(target);
        fs.appendFileSync(target.path, line, { mode: 0o600 });
        target.bytes += bytes;
    } catch (err) {
        // A log that cannot be written must not take the server down with it.
        target.disabled = true;
        console.error(`${stamp()}  warn   log write failed, disabling ${target.path}: ${err.message}`);
    }
}

function appendLog(line) {
    appendLogFile(logFile, line);
}

function appendRequestLog(line) {
    appendLogFile(requestLogFile, line);
}

function stamp() {
    return new Date().toISOString();
}

/** Quote a field value when it would otherwise blur the key=value columns. */
function field(value) {
    const text = String(value);
    return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

function formatFields(fields) {
    return Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${field(value)}`)
        .join(' ');
}

function log(level, message, fields = {}) {
    const extra = formatFields(fields);
    const line = `${stamp()}  ${level.padEnd(5)}  ${message}${extra ? '  ' + extra : ''}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
    appendLog(line + '\n');
}

function logRequest(req, status, pathName, from, startedAt) {
    const level = status === 'aborted' || status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const fields = {
        method: req.method,
        path: pathName,
        status,
        from,
        bytes: req.headers['content-length'],
        event: req.headers['x-github-event'],
        delivery: req.headers['x-github-delivery'],
        agent: req.headers['user-agent'],
        ms: Date.now() - startedAt,
    };
    const extra = formatFields(fields);
    appendRequestLog(`${stamp()}  ${level.padEnd(5)}  request  ${extra}\n`);
}

// ------------------------------------------------------------------- args ---

function usage() {
    console.log(`usage: gift serve [options]

Receive GitHub webhook deliveries and run the scripts configured in hooks.json.

options:
  --config=FILE    Hook configuration file (default: hooks.json)
  --host=HOST      Interface to bind (default: ${DEFAULTS.host})
  --port=PORT      Port to listen on (default: ${DEFAULTS.port})
  --path=PATH      Webhook endpoint path (default: ${DEFAULTS.path})
  --log=FILE       Log file to append to (default: hooks.log)
  --no-log         Log to the console only, writing no file
  --dry-run        Verify and match deliveries, but never run a hook script
  -h, --help       Show this help

environment (from .env, or the real environment, which wins):
  GITHUB_WEBHOOK_SECRET   Secret configured on the GitHub webhook (required)
  GIFT_SERVE_HOST         Default for --host
  PORT                    Default for --port (GIFT_SERVE_PORT overrides it)
  GIFT_SERVE_PATH         Default for --path
  GIFT_SERVE_LOG          Default for --log ('off' for no file)

Status page:  GET http://HOST:PORT/
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
        else if (arg.startsWith('--log=')) options.log = arg.slice(6);
        else if (arg === '--no-log') options.log = 'off';
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

    // Both paths a hook runs with are spelled out in full, and neither is
    // guessed: `run` is an absolute path to a .sh script, `cwd` an absolute
    // directory. A relative path would depend on where the server happens to
    // have been started from, which is not something a deploy should turn on.
    const hooks = (parsed.hooks || []).map((hook, index) => {
        const name = hook.name || `hook-${index + 1}`;
        const bad = (message) => new Error(`${file}: hook '${name}' ${message}`);

        if (!hook.run) throw bad('has no "run" script');
        if (!path.isAbsolute(hook.run)) {
            throw bad(`"run" must be an absolute path, not '${hook.run}'`);
        }
        if (!hook.run.endsWith('.sh')) {
            throw bad(`"run" must be a .sh script, not '${hook.run}'`);
        }
        if (!hook.cwd) throw bad('has no "cwd" working directory');
        if (!path.isAbsolute(hook.cwd)) {
            throw bad(`"cwd" must be an absolute path, not '${hook.cwd}'`);
        }

        return {
            name,
            repo: hook.repo || '*',
            events: hook.events && hook.events.length ? hook.events : ['push'],
            branches: hook.branches || [],
            run: path.normalize(hook.run),
            args: hook.args || [],
            cwd: path.normalize(hook.cwd),
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
 * The signatures in one header. GitHub sends exactly one; Node joins a header
 * that arrived twice into a single comma-separated value, which is what a proxy
 * that sets X-Hub-Signature-256 itself while also passing GitHub's through
 * produces. Matching any one of them still takes the secret, so reading them all
 * rescues an otherwise correct deployment without loosening anything.
 *
 * Lower-cased because hex is compared as text: GitHub sends it lower-case, and a
 * signature that only differs in case is the same signature.
 */
function signatureCandidates(header) {
    return String(header)
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Check the delivery signature against every configured secret.
 * @returns {string[]} names of the env vars whose secret matched.
 */
function verifySignature(rawBody, signatureHeader, secrets) {
    if (!signatureHeader) return [];
    const candidates = signatureCandidates(signatureHeader);

    const matched = [];
    for (const [name, secret] of secrets) {
        const expected = Buffer.from(
            'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
        );
        for (const candidate of candidates) {
            const received = Buffer.from(candidate);
            if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
                matched.push(name);
                break;
            }
        }
    }
    return matched;
}

// ---------------------------------------------------------- why it failed ---
//
// 'invalid signature' on its own leaves three very different problems looking
// identical: a secret that does not match, a body that did not arrive as GitHub
// sent it, and a signature header something in front rewrote. Each has a
// different fix, so the log says which one it was.
//
// All of it goes to the log only. The 401 body stays 'Invalid signature' —
// whoever sent a request that would not verify is the last party to describe it
// to.

/**
 * A short, one-way fingerprint of a secret: the first bytes of its SHA-256.
 * Enough to tell two secrets apart, and to see at a glance whether the running
 * process holds the value that is in .env — which is the question when a secret
 * has been rotated and something stale is still being used.
 *
 * It is not the secret and cannot be turned back into it. The log is written
 * 0600 in the same folder as .env, so this exposes nothing to anyone who could
 * not already read the secret itself.
 */
function fingerprint(secret) {
    return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

function fingerprints(secrets) {
    return [...secrets].map(([name, secret]) => `${name}:${fingerprint(secret)}`).join(' ');
}

/**
 * The ways a secret comes to differ from the one it was pasted from: a newline
 * an editor added, a space that came along with the copy, quotes that were meant
 * to wrap the value in .env rather than be part of it.
 *
 * A delivery signed with one of these names the mistake exactly. None of them is
 * ever accepted — they are compared against only to describe what happened.
 */
function secretVariants(secret) {
    return [
        ['with a trailing newline', `${secret}\n`],
        ['with a trailing space', `${secret} `],
        ['with its whitespace trimmed off', secret.trim()],
        ['wrapped in double quotes', `"${secret}"`],
        ['wrapped in single quotes', `'${secret}'`],
        ['with its surrounding quotes stripped', secret.replace(/^(["'])([\s\S]*)\1$/, '$2')],
    ].filter(([, value]) => value !== secret && value !== '');
}

const WELL_FORMED = /^sha256=[0-9a-f]{64}$/;

/**
 * Why this delivery did not verify, as something to go and change.
 *
 * @returns {{fields: object, notes: string[]}} extra columns for the 401 line,
 *          and the sentences to log under it.
 */
function explainSignatureFailure(rawBody, signatureHeader, secrets, headers = {}) {
    const fields = { bytes: rawBody.length, secrets: fingerprints(secrets) };
    const notes = [];

    // Nothing to check the body against. GitHub signs every delivery once a
    // Secret is set on the webhook, so no header at all means none is set.
    if (!signatureHeader) {
        if (headers['x-hub-signature']) {
            notes.push('the sha1 X-Hub-Signature arrived but the sha256 one did not, so something in front dropped it.');
        } else {
            notes.push('the delivery carried no signature header, so the webhook on GitHub has no Secret set.');
            notes.push('Set it under Settings -> Webhooks -> Edit -> Secret, to the same value as the secret in .env.');
        }
        return { fields, notes };
    }

    const candidates = signatureCandidates(signatureHeader);

    // A body that did not arrive whole cannot verify however right the secret
    // is, and the signature is the only thing that notices.
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared !== rawBody.length) {
        fields.declared = declared;
        notes.push(`the body is ${rawBody.length} bytes against the ${declared} declared, so it did not arrive as GitHub sent it — check whatever proxies to this server.`);
        return { fields, notes };
    }

    const malformed = candidates.filter((candidate) => !WELL_FORMED.test(candidate));
    if (malformed.length) {
        fields.signature = candidates.join(' ');
        notes.push('the signature is not the sha256=<64 hex> that GitHub sends, so it was rewritten on the way here rather than being a secret that does not match.');
        return { fields, notes };
    }
    if (candidates.length > 1) {
        fields.signatures = candidates.length;
        notes.push('the signature header arrived more than once and none of them matched — something in front is adding its own.');
    }

    // Plain equality: verification has already failed, so there is no secret
    // left for a timing difference here to leak.
    const signedWith = (secret) =>
        candidates.includes('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));

    for (const [name, secret] of secrets) {
        for (const [label, variant] of secretVariants(secret)) {
            if (!signedWith(variant)) continue;
            notes.push(`the delivery was signed with the value of ${name} ${label} — the same secret, pasted differently.`);
            notes.push(`Fix the one that has it wrong: the Secret field on GitHub, or ${name} in .env.`);
            return { fields, notes };
        }
    }

    notes.push(`the delivery was signed with a secret this server does not have — the Secret on GitHub is a different value from ${fingerprints(secrets)}.`);
    notes.push('If .env holds the right value, this process is not running on it: `gift status` prints the fingerprint of the file, and a variable already in the environment wins over it. `gift serve` restarts on the file.');
    return { fields, notes };
}

/**
 * The delivery's JSON. A webhook's "Content type" on GitHub is either
 * `application/json`, where the body is the JSON itself, or
 * `application/x-www-form-urlencoded`, where the same JSON arrives as a single
 * `payload` field. Both are accepted, so a webhook configured either way works.
 *
 * The signature covers the raw body whichever it is, and is checked before this
 * runs, so unwrapping the form field here verifies nothing and weakens nothing.
 */
function parsePayload(rawBody, contentType) {
    const text = rawBody.toString('utf8');
    if (String(contentType || '').toLowerCase().includes('application/x-www-form-urlencoded')) {
        const field = new URLSearchParams(text).get('payload');
        if (field === null) throw new Error('form body has no "payload" field');
        return JSON.parse(field);
    }
    return JSON.parse(text);
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
        log('info', 'dry run, not executing', {
            hook: hook.name,
            delivery: delivery.id,
            run: hook.run,
            args: hook.args.length ? hook.args.join(' ') : undefined,
        });
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

    // loadConfig guarantees hook.cwd for anything read from a file; the fallback
    // is only reached by a config built in code, as the tests do.
    const cwd = hook.cwd || path.dirname(hook.run);
    const startedAt = Date.now();

    // Arguments come from hooks.json only — never from the payload — and the
    // child is spawned without a shell, so nothing can be injected.
    const child = spawn(hook.run, hook.args, {
        cwd,
        env: childEnv,
        detached: hook.detach,
        stdio: hook.detach ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    });

    // Logged after the spawn so the pid is part of the same line. A script that
    // does not exist fails asynchronously; that shows up as 'hook failed to
    // start' right below, with no pid here.
    log('info', 'running hook', {
        hook: hook.name,
        delivery: delivery.id,
        event: delivery.event,
        repo: delivery.repo,
        branch: branchOf(delivery.ref),
        run: hook.run,
        args: hook.args.length ? hook.args.join(' ') : undefined,
        cwd,
        pid: child.pid,
        detach: hook.detach ? 'yes' : undefined,
        payload: payloadFile,
    });

    if (hook.detach) {
        child.unref();
        child.on('error', (err) => {
            log('error', `hook failed to start: ${err.message}`, {
                hook: hook.name,
                delivery: delivery.id,
                run: hook.run,
            });
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
        log('error', `hook failed to start: ${err.message}`, {
            hook: hook.name,
            delivery: delivery.id,
            run: hook.run,
        });
    });

    child.on('close', (code, signal) => {
        removeQuietly(payloadFile);
        status.running = false;
        const level = code === 0 ? 'info' : 'error';
        log(level, 'hook finished', {
            hook: hook.name,
            delivery: delivery.id,
            exit: signal ? undefined : code,
            signal,
            ms: Date.now() - startedAt,
        });

        const queued = status.pending;
        if (queued) {
            status.pending = null;
            runHook(hook, queued, options);
        }
    });
}

// ------------------------------------------------------------------ server ---
//
// Express replaces the old manual node:http routing, but none of the security-
// relevant logic above (signature verification, hook matching, hook execution,
// logging) changes — only how a request becomes a call into it.

/** A one-line access log entry for every request, however it ends. */
function accessLogMiddleware(req, res, next) {
    const startedAt = Date.now();
    const pathName = req.path;
    const from = req.socket.remoteAddress;
    let logged = false;
    const recordRequest = (status) => {
        if (logged) return;
        logged = true;
        logRequest(req, status, pathName, from, startedAt);
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

// --------------------------------------------------------------- dashboard ---
//
// The read-only data behind GET /api/status. web/dist (built by `pnpm run
// build`) is the React app that renders it; this hands over plain data, not
// HTML, so nothing here needs escaping — React does that on its own.

function repositoryLink(repo, fallback) {
    const value = String(repo || '');
    const parts = value.split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) return { label: fallback, href: null, title: null };

    const href = `https://github.com/${parts.map(encodeURIComponent).join('/')}`;
    return { label: value, href, title: `Open ${value} on GitHub` };
}

function repositoryHooksLink(repo, fallback) {
    const value = String(repo || '');
    const parts = value.split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) return { label: fallback, href: null, title: null };

    const href = `https://github.com/${parts.map(encodeURIComponent).join('/')}/settings/hooks`;
    return { label: value, href, title: `Open webhook settings for ${value}` };
}

// ------------------------------------------------------------ deliveries ---
//
// Recent deliveries live in memory for fast reads, but are mirrored to disk
// so that a restart — `gift update`, `pm2 restart`, a crash — does not wipe
// the dashboard back to empty.

function loadDeliveries(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const deliveriesFileState = { disabled: false };

/** Write through a temporary file, so a crash mid-write cannot truncate it. */
function saveDeliveries(file, deliveries) {
    if (deliveriesFileState.disabled) return;
    const temp = `${file}.tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify(deliveries), { mode: 0o600 });
        fs.renameSync(temp, file);
    } catch (err) {
        deliveriesFileState.disabled = true;
        log('warn', `cannot write ${file}: ${err.message}`, {
            hint: 'recent deliveries will not survive a restart until this is fixed',
        });
    }
}

/** The read-only status behind GET /api/status. */
function dashboardData(config, secrets, options, recentDeliveries = []) {
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    const hookItems = hooks.map((hook, index) => {
        const name = hook.name || `hook-${index + 1}`;
        const repoFallback = hook.repo === '*' || !hook.repo ? 'Any repository' : hook.repo;
        const events = Array.isArray(hook.events) && hook.events.length ? hook.events : ['push'];
        const branches = Array.isArray(hook.branches) && hook.branches.length && !hook.branches.includes('*')
            ? hook.branches.join(', ')
            : 'Any branch';

        return {
            name,
            repo: repositoryHooksLink(hook.repo, repoFallback),
            events: events.join(', '),
            branches,
            run: hook.run || 'Not configured',
        };
    });

    const deliveryItems = recentDeliveries.map((delivery) => {
        const receivedAt = new Date(delivery.receivedAt);
        const validTime = !Number.isNaN(receivedAt.getTime());

        return {
            event: delivery.event || 'Unknown event',
            repo: repositoryLink(delivery.repo, 'Unknown repository'),
            id: delivery.id || 'No delivery ID',
            timestamp: validTime ? receivedAt.toISOString() : null,
            outcome: delivery.outcome || 'Receiving',
            tone: delivery.tone || 'neutral',
            detail: delivery.detail || null,
        };
    });

    return { hooks: hookItems, deliveries: deliveryItems };
}

function createApp(config, secrets, options) {
    const recentDeliveries = options.deliveriesFile ? loadDeliveries(options.deliveriesFile) : [];
    const persistDeliveries = () => {
        if (options.deliveriesFile) saveDeliveries(options.deliveriesFile, recentDeliveries);
    };
    const beginDelivery = (event, id) => {
        const delivery = {
            id,
            event,
            receivedAt: new Date(),
            outcome: 'Receiving',
            tone: 'neutral',
        };
        recentDeliveries.unshift(delivery);
        if (recentDeliveries.length > RECENT_DELIVERY_LIMIT) recentDeliveries.length = RECENT_DELIVERY_LIMIT;
        persistDeliveries();
        return delivery;
    };
    const finishDelivery = (delivery, outcome, detail, repo) => {
        delivery.outcome = outcome;
        delivery.detail = detail;
        delivery.repo = repo || delivery.repo;
        delivery.tone = outcome === 'Accepted' || outcome === 'Ping'
            ? 'ready'
            : outcome === 'Rejected'
                ? 'warning'
                : 'neutral';
        persistDeliveries();
    };

    /** Everything past signature verification: parse, match, run, respond. */
    function handleDelivery(req, res, ctx) {
        const { event, deliveryId, signature, recent, from } = ctx;
        const rawBody = req.body;

        const secretNames = verifySignature(rawBody, signature, secrets);
        if (secretNames.length === 0) {
            finishDelivery(recent, 'Rejected', signature ? 'Invalid signature' : 'Missing signature');
            const why = explainSignatureFailure(rawBody, signature, secrets, req.headers);
            log('warn', signature ? 'invalid signature' : 'missing signature', {
                status: 401,
                delivery: deliveryId,
                event,
                from,
                ...why.fields,
            });
            // Indented under the line above: sentences, which do not belong in
            // its key=value columns.
            for (const note of why.notes) log('warn', `  ${note}`);
            sendText(res, 401, signature ? 'Invalid signature' : 'Missing signature');
            return;
        }

        let payload;
        try {
            payload = parsePayload(rawBody, req.headers['content-type']);
        } catch {
            finishDelivery(recent, 'Rejected', 'Invalid JSON');
            // The content type is logged: a body that will not parse is usually
            // a webhook sending something other than what it says it is.
            log('warn', 'invalid JSON payload', {
                status: 400,
                delivery: deliveryId,
                event,
                type: req.headers['content-type'],
            });
            sendText(res, 400, 'Invalid JSON');
            return;
        }

        const repo = payload.repository && payload.repository.full_name;
        recent.repo = repo;
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
            branch: branchOf(payload.ref),
            action: payload.action,
            commits: Array.isArray(payload.commits) ? payload.commits.length : undefined,
            after: payload.after,
            sender: delivery.sender,
            secret: secretNames.join('|'),
            bytes: rawBody.length,
        });

        // GitHub sends `ping` right after a webhook is created.
        if (event === 'ping') {
            finishDelivery(recent, 'Ping', 'Webhook verified', repo);
            log('info', 'ping answered', { status: 200, delivery: deliveryId });
            sendText(res, 200, 'pong');
            return;
        }

        const triggered = config.hooks.filter((hook) =>
            matches(hook, { event, repo, ref: payload.ref, secretNames })
        );

        if (triggered.length === 0) {
            finishDelivery(recent, 'No match', 'No configured hook matched', repo);
            log('info', 'no hook matched', {
                status: 200,
                event,
                delivery: deliveryId,
                repo,
                configured: config.hooks.length,
            });
            sendText(res, 200, 'No hook matched');
            return;
        }

        log('info', 'hooks matched', {
            status: 202,
            delivery: deliveryId,
            hooks: triggered.map((h) => h.name).join('|'),
        });

        const triggeredNames = triggered.map((hook) => hook.name);
        finishDelivery(recent, 'Accepted', triggeredNames.join(', '), repo);

        // Answer GitHub before doing any work: deliveries time out after 10s.
        sendText(res, 202, `Accepted: ${triggeredNames.join(', ')}`);

        for (const hook of triggered) {
            try {
                runHook(hook, delivery, options);
            } catch (err) {
                log('error', `hook error: ${err.message}`, { hook: hook.name });
            }
        }
    }

    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.use(accessLogMiddleware);

    app.get('/health', (req, res) => {
        sendText(res, 200, 'ok');
    });

    app.get('/api/status', (req, res) => {
        res.set('cache-control', 'no-store');
        res.json(dashboardData(config, secrets, options, recentDeliveries));
    });

    // The raw hooks.json for the dashboard's info panel — read fresh on every
    // request so it reflects edits made without restarting the server.
    app.get('/api/hooks.json', (req, res) => {
        res.set('cache-control', 'no-store');
        fs.readFile(options.configFile, 'utf8', (err, data) => {
            if (err) {
                sendText(res, 404, `${path.basename(options.configFile)} not found`);
                return;
            }
            res.set('content-type', 'application/json; charset=utf-8').send(data);
        });
    });

    // The built React app. index.html stays uncached — it names the current
    // hashed asset files, and those change on every build.
    app.use(express.static(WEB_DIST, {
        setHeaders(res, filePath) {
            if (path.basename(filePath) === 'index.html') res.setHeader('cache-control', 'no-store');
        },
    }));

    const readRawBody = express.raw({ type: '*/*', limit: MAX_BODY_BYTES });

    // A delivery is recognised by its X-GitHub-Event header, not only by the
    // path it arrives on. A Payload URL entered without one — just
    // `http://host:3999` — reaches the server at `/`, and answering that 404
    // wastes a delivery over a detail the signature check does not depend on.
    // The configured path stays the endpoint the docs and proxies use; it is a
    // label rather than a gate, and anything else off it falls through to the
    // 404 catch-all below.
    app.use((req, res, next) => {
        const from = req.socket.remoteAddress;
        const delivered = req.method === 'POST' && req.headers['x-github-event'] !== undefined;

        if (req.path !== options.path && !delivered) return next();

        if (req.path !== options.path) {
            // A line each time: the delivery is handled, but the Payload URL is
            // not the endpoint this server documents, and that is worth fixing.
            log('warn', 'delivery on an unexpected path', {
                path: req.path,
                expected: options.path,
                from,
                hint: `set the webhook Payload URL to end in ${options.path}`,
            });
        }

        if (req.method !== 'POST') {
            log('warn', 'request with the wrong method', { status: 405, method: req.method, from });
            res.set('allow', 'POST');
            sendText(res, 405, 'Method not allowed');
            return;
        }

        const event = req.headers['x-github-event'];
        const deliveryId = req.headers['x-github-delivery'];
        const signature = req.headers['x-hub-signature-256'];
        const recent = beginDelivery(event, deliveryId);

        // Logged before anything can reject it, so even a delivery that fails
        // verification leaves a record of having arrived.
        log('info', 'delivery received', {
            event,
            delivery: deliveryId,
            from,
            bytes: req.headers['content-length'],
            signed: signature ? 'yes' : 'no',
            agent: req.headers['user-agent'],
        });

        readRawBody(req, res, (err) => {
            if (err) {
                if (err.status === 413 || err.type === 'entity.too.large') {
                    finishDelivery(recent, 'Rejected', 'Payload too large');
                    log('warn', 'rejected oversized payload', { status: 413, delivery: deliveryId, from });
                    sendText(res, 413, 'Payload too large');
                } else {
                    finishDelivery(recent, 'Rejected', 'Request read failed');
                    log('warn', `request read failed: ${err.message}`, { status: 400, delivery: deliveryId });
                    sendText(res, 400, 'Bad request');
                }
                return;
            }

            handleDelivery(req, res, { event, deliveryId, signature, recent, from });
        });
    });

    // Whatever falls through everything above: not the webhook, not a static
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

    return app;
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

    // `gift serve` already loaded .env; do it here too so that
    // `node server.js` and a systemd unit behave the same way.
    try {
        require('./utils/env.js').loadFor();
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
        // Blank falls through to the next source, as it does above: an empty
        // GIFT_SERVE_LOG= in .env means "unset", not "no log".
        log: options.log || process.env.GIFT_SERVE_LOG || config.log || DEFAULT_LOG,
        dryRun: options.dryRun,
        configFile,
        deliveriesFile: DEFAULT_DELIVERIES_FILE,
    };
    if (!settings.path.startsWith('/')) settings.path = `/${settings.path}`;

    // Turning the file off takes saying so — 'off' (--no-log passes it). Any
    // other value is a file, resolved against this folder when it is relative.
    const off = ['off', 'none', 'no', 'false'];
    openLog(off.includes(String(settings.log).trim().toLowerCase())
        ? null
        : path.resolve(HERE, settings.log));
    openRequestLog();

    const secrets = collectSecrets(config.hooks);
    if (secrets.size === 0) {
        console.error(`gift serve: no webhook secret configured.

Set GITHUB_WEBHOOK_SECRET in .env (or the environment) to the same
value as the webhook's "Secret" field on GitHub. Generate one with:

    openssl rand -hex 32`);
        return 1;
    }

    if (config.missing) {
        log('warn', `no ${path.basename(configFile)} found — deliveries will be logged only`, {
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
            log('warn', 'hook script is missing or not executable', {
                hook: hook.name,
                run: hook.run,
            });
        }
    }

    const app = createApp({ ...config, path: settings.path }, secrets, settings);

    const server = app.listen(settings.port, settings.host, () => {
        log('info', `gift webhooks listening on http://${settings.host}:${settings.port}${settings.path}`);
        log('info', `health check: http://${settings.host}:${settings.port}/health`);
        log('info', `web: http://${settings.host}:${settings.port}`);
        log('info', `config ${configFile}`);
        log('info', logFile.path ? `log ${logFile.path}` : 'log console only (--no-log)');
        log('info', `request log ${requestLogFile.path}`);
        log('info', `deliveries ${settings.deliveriesFile}`);
        // With the fingerprint of each: after a rotation, this line is what says
        // whether the process is running on the value that is now in .env.
        log('info', `secrets accepted from ${fingerprints(secrets)}`);
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
    verifySignature,
    signatureCandidates,
    explainSignatureFailure,
    fingerprint,
    matches,
    loadConfig,
    collectSecrets,
    dashboardData,
    openLog,
    openRequestLog,
    main,
};
