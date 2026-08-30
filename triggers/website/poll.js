// Fetching one page, once.
//
// `fetch` rather than node:http: it follows redirects, decodes the body and
// needs nothing installed. Node 18 is the floor gift asks for and has it.
//
// Two things are guarded here, because the thing being fetched is not gift's
// and cannot be trusted to be reasonable: the response is abandoned after a
// deadline, and only the first few megabytes of it are read. A page that never
// finishes sending must not be able to stall the poll behind it, and one that
// streams forever must not be able to fill memory.
'use strict';

const crypto = require('node:crypto');

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * @returns {Promise<{ok: true, status: number, body: string, truncated: boolean,
 *                     contentType: string, digest: string, ms: number}
 *                  | {ok: false, error: string, ms: number}>}
 */
async function fetchPage(url, { method = 'GET', timeout = 10000, userAgent, headers = {} } = {}) {
    if (typeof fetch !== 'function') {
        return { ok: false, error: 'this Node has no fetch — website hooks need Node 18 or newer', ms: 0 };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method,
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'user-agent': userAgent || 'gift', accept: '*/*', ...headers },
        });

        const body = await readCapped(response, controller);
        return {
            ok: true,
            status: response.status,
            body: body.text,
            truncated: body.truncated,
            contentType: response.headers.get('content-type') || '',
            // What "did it change" is answered with. Comparing digests rather
            // than the bodies keeps a megabyte of HTML out of memory between
            // polls, and out of events.json entirely.
            digest: crypto.createHash('sha256').update(body.text).digest('hex'),
            ms: Date.now() - startedAt,
        };
    } catch (err) {
        const aborted = err.name === 'AbortError' || err.name === 'TimeoutError';
        return {
            ok: false,
            error: aborted ? `no answer within ${timeout} ms` : reason(err),
            ms: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(deadline);
    }
}

/** fetch wraps the real problem in a generic message; the cause names it. */
function reason(err) {
    const cause = err.cause;
    if (cause && cause.code) {
        switch (cause.code) {
            case 'ENOTFOUND': return `${cause.hostname || 'the host'} could not be resolved`;
            case 'ECONNREFUSED': return 'the connection was refused';
            case 'ECONNRESET': return 'the connection was closed without an answer';
            case 'CERT_HAS_EXPIRED': return 'the TLS certificate has expired';
            case 'DEPTH_ZERO_SELF_SIGNED_CERT': return 'the TLS certificate is self-signed';
            default: return cause.message || cause.code;
        }
    }
    return err.message;
}

/** Read the body, giving up at MAX_BODY_BYTES rather than however long it runs. */
async function readCapped(response, controller) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const text = await response.text();
        return text.length > MAX_BODY_BYTES
            ? { text: text.slice(0, MAX_BODY_BYTES), truncated: true }
            : { text, truncated: false };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let truncated = false;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length >= MAX_BODY_BYTES) {
            text = text.slice(0, MAX_BODY_BYTES);
            truncated = true;
            controller.abort();
            break;
        }
    }
    return { text: text + (truncated ? '' : decoder.decode()), truncated };
}

module.exports = { fetchPage, MAX_BODY_BYTES };
