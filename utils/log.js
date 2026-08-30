// The server's two logs, shared by everything that writes to them.
//
// hooks.log   the activity log: every event a trigger noticed, which hooks
//             matched, exactly what was executed, whatever the script printed,
//             and how it ended. That history survives a restart, which is what
//             `pm2 logs` alone does not give you.
// server.log  one line per HTTP request, for the GitHub trigger's endpoint and
//             the dashboard.
//
// This lives outside serve.js because the triggers write to the same log: a
// clipboard watcher and a webhook delivery belong in one file, in the order
// they happened, or `gift log` stops being the place to look.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Rotate past this size, keeping one previous file (hooks.log.1).
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const logFile = { path: null, bytes: 0, disabled: false };
const requestLogFile = { path: null, bytes: 0, disabled: false };

function stamp() {
    return new Date().toISOString();
}

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
function openRequestLog(file) {
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
    appendLogFile(logFile, line + '\n');
}

/**
 * A logger that stamps every line with the trigger it came from, so one file
 * holding four kinds of watcher still reads as four separate stories.
 */
function forTrigger(type) {
    return (level, message, fields = {}) => log(level, message, { trigger: type, ...fields });
}

function appendRequestLog(line) {
    appendLogFile(requestLogFile, line);
}

module.exports = {
    LOG_MAX_BYTES,
    logFile,
    requestLogFile,
    openLog,
    openRequestLog,
    log,
    forTrigger,
    appendRequestLog,
    formatFields,
    stamp,
};
