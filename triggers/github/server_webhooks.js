// The GitHub trigger's endpoint: the part of the server that receives webhook
// deliveries.
//
// It verifies the X-Hub-Signature-256 HMAC against the shared secret and runs a
// *locally configured* script for the deliveries that match. Nothing from the
// payload is ever used to build a command: hooks may only run scripts named in
// hooks.json, and payload fields reach them as environment variables.
//
// This is an express middleware rather than a server of its own — the root
// serve.js owns the listener, the dashboard and the log, and mounts this on it.
'use strict';

const crypto = require('node:crypto');

const { log } = require('../../utils/log.js');

// GitHub rejects payloads above 25 MB, so anything larger is not from GitHub.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const DEFAULT_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';

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

/** Every secret the server will accept, keyed by the env var it came from. */
function collectSecrets(hooks) {
    const names = new Set([
        DEFAULT_SECRET_ENV,
        ...hooks.map((hook) => (hook.trigger && hook.trigger.secretEnv) || DEFAULT_SECRET_ENV),
    ]);
    const secrets = new Map();
    for (const name of names) {
        const value = process.env[name];
        if (value) secrets.set(name, value);
    }
    return secrets;
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
 * process holds the value that is configured — which is the question when a
 * secret has been rotated and something stale is still being used.
 *
 * It is not the secret and cannot be turned back into it. The log is written
 * 0600, as is the configuration it comes from, so this exposes nothing to anyone
 * who could not already read the secret itself.
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
 * to wrap the value rather than be part of it.
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
            notes.push('Set it under Settings -> Webhooks -> Edit -> Secret, to the same value as the configured secret.');
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
            notes.push(`Fix the one that has it wrong: the Secret field on GitHub, or ${name} in config.json.`);
            return { fields, notes };
        }
    }

    notes.push(`the delivery was signed with a secret this server does not have — the Secret on GitHub is a different value from ${fingerprints(secrets)}.`);
    notes.push('If the configuration holds the right value, this process is not running on it: `gift status` prints the fingerprint of what is configured, and a variable already in the environment wins over it. `gift serve` restarts on it.');
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

/** Whether one hook's trigger wants this delivery. */
function matches(hook, { event, repo, ref, secretNames }) {
    const trigger = hook.trigger || {};
    const secretEnv = trigger.secretEnv || DEFAULT_SECRET_ENV;
    const events = trigger.events && trigger.events.length ? trigger.events : ['push'];
    const branches = trigger.branches || [];

    if (!secretNames.includes(secretEnv)) return false;
    if (!events.includes('*') && !events.includes(event)) return false;
    if (trigger.repo && trigger.repo !== '*'
        && String(trigger.repo).toLowerCase() !== String(repo || '').toLowerCase()) {
        return false;
    }
    if (branches.length && !branches.includes('*')) {
        const branch = branchOf(ref);
        if (!branch || !branches.includes(branch)) return false;
    }
    return true;
}

// ------------------------------------------------------------------- links ---

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

// ---------------------------------------------------------------- receiver ---

function sendText(res, status, body) {
    res.status(status).set('content-type', 'text/plain; charset=utf-8').send(body);
}

/**
 * The express middleware that receives deliveries.
 *
 * @param {object} ctx  { hooks, secrets, runtime, path, express }
 */
function createReceiver({ hooks, secrets, runtime, path: endpoint, express }) {
    const readRawBody = express.raw({ type: '*/*', limit: MAX_BODY_BYTES });

    /** Everything past reading the body: verify, parse, match, run, respond. */
    function handleDelivery(req, res, ctx) {
        const { event, deliveryId, signature, recent, from } = ctx;
        const rawBody = req.body;

        const secretNames = verifySignature(rawBody, signature, secrets);
        if (secretNames.length === 0) {
            runtime.finishEvent(recent, 'Rejected', signature ? 'Invalid signature' : 'Missing signature');
            const why = explainSignatureFailure(rawBody, signature, secrets, req.headers);
            log('warn', signature ? 'invalid signature' : 'missing signature', {
                trigger: 'github',
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
            runtime.finishEvent(recent, 'Rejected', 'Invalid JSON');
            // The content type is logged: a body that will not parse is usually
            // a webhook sending something other than what it says it is.
            log('warn', 'invalid JSON payload', {
                trigger: 'github',
                status: 400,
                delivery: deliveryId,
                event,
                type: req.headers['content-type'],
            });
            sendText(res, 400, 'Invalid JSON');
            return;
        }

        const repo = payload.repository && payload.repository.full_name;
        const branch = branchOf(payload.ref);
        recent.title = repo || 'Unknown repository';
        recent.link = repositoryLink(repo, 'Unknown repository');

        log('info', 'delivery accepted', {
            trigger: 'github',
            event,
            delivery: deliveryId,
            repo,
            ref: payload.ref,
            branch,
            action: payload.action,
            commits: Array.isArray(payload.commits) ? payload.commits.length : undefined,
            after: payload.after,
            sender: payload.sender && payload.sender.login,
            secret: secretNames.join('|'),
            bytes: rawBody.length,
        });

        // GitHub sends `ping` right after a webhook is created.
        if (event === 'ping') {
            runtime.finishEvent(recent, 'Ping', 'Webhook verified');
            log('info', 'ping answered', { trigger: 'github', status: 200, delivery: deliveryId });
            sendText(res, 200, 'pong');
            return;
        }

        const triggered = hooks.filter((hook) =>
            hook.enabled && matches(hook, { event, repo, ref: payload.ref, secretNames })
        );

        if (triggered.length === 0) {
            runtime.finishEvent(recent, 'No match', 'No configured hook matched');
            log('info', 'no hook matched', {
                trigger: 'github',
                status: 200,
                event,
                delivery: deliveryId,
                repo,
                configured: hooks.length,
            });
            sendText(res, 200, 'No hook matched');
            return;
        }

        const names = triggered.map((hook) => hook.name);
        log('info', 'hooks matched', {
            trigger: 'github',
            status: 202,
            delivery: deliveryId,
            hooks: names.join('|'),
        });
        runtime.finishEvent(recent, 'Accepted', names.join(', '));

        // Answer GitHub before doing any work: deliveries time out after 10s.
        sendText(res, 202, `Accepted: ${names.join(', ')}`);

        const env = {
            GIFT_DELIVERY: deliveryId || '',
            GIFT_REPO: repo || '',
            GIFT_REF: payload.ref || '',
            GIFT_BRANCH: branch || '',
            GIFT_BEFORE: payload.before || '',
            GIFT_AFTER: payload.after || '',
            GIFT_SENDER: (payload.sender && payload.sender.login) || '',
        };
        const files = { GIFT_PAYLOAD_FILE: { data: rawBody, suffix: '.json' } };

        for (const hook of triggered) {
            try {
                runtime.fire(hook, recent, { env, files });
            } catch (err) {
                log('error', `hook error: ${err.message}`, { hook: hook.name });
            }
        }
    }

    // A delivery is recognised by its X-GitHub-Event header, not only by the
    // path it arrives on. A Payload URL entered without one — just
    // `http://host:3999` — reaches the server at `/`, and answering that 404
    // wastes a delivery over a detail the signature check does not depend on.
    // The configured path stays the endpoint the docs and proxies use; it is a
    // label rather than a gate, and anything else off it falls through to the
    // 404 catch-all in the root server.
    return function receiver(req, res, next) {
        const from = req.socket.remoteAddress;
        const delivered = req.method === 'POST' && req.headers['x-github-event'] !== undefined;

        if (req.path !== endpoint && !delivered) return next();

        if (req.path !== endpoint) {
            // A line each time: the delivery is handled, but the Payload URL is
            // not the endpoint this server documents, and that is worth fixing.
            log('warn', 'delivery on an unexpected path', {
                trigger: 'github',
                path: req.path,
                expected: endpoint,
                from,
                hint: `set the webhook Payload URL to end in ${endpoint}`,
            });
        }

        if (req.method !== 'POST') {
            log('warn', 'request with the wrong method', {
                trigger: 'github', status: 405, method: req.method, from,
            });
            res.set('allow', 'POST');
            sendText(res, 405, 'Method not allowed');
            return;
        }

        const event = req.headers['x-github-event'];
        const deliveryId = req.headers['x-github-delivery'];
        const signature = req.headers['x-hub-signature-256'];
        const recent = runtime.beginEvent({
            trigger: 'github',
            kind: event || 'delivery',
            id: deliveryId,
            title: 'Unknown repository',
        });

        // Logged before anything can reject it, so even a delivery that fails
        // verification leaves a record of having arrived.
        log('info', 'delivery received', {
            trigger: 'github',
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
                    runtime.finishEvent(recent, 'Rejected', 'Payload too large');
                    log('warn', 'rejected oversized payload', {
                        trigger: 'github', status: 413, delivery: deliveryId, from,
                    });
                    sendText(res, 413, 'Payload too large');
                } else {
                    runtime.finishEvent(recent, 'Rejected', 'Request read failed');
                    log('warn', `request read failed: ${err.message}`, {
                        trigger: 'github', status: 400, delivery: deliveryId,
                    });
                    sendText(res, 400, 'Bad request');
                }
                return;
            }

            handleDelivery(req, res, { event, deliveryId, signature, recent, from });
        });
    };
}

module.exports = {
    DEFAULT_SECRET_ENV,
    MAX_BODY_BYTES,
    createReceiver,
    verifySignature,
    signatureCandidates,
    explainSignatureFailure,
    fingerprint,
    fingerprints,
    collectSecrets,
    matches,
    branchOf,
    parsePayload,
    repositoryLink,
    repositoryHooksLink,
};
