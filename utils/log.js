// The server's three logs, shared by everything that writes to them.
//
// hooks.log   the activity log: every event a trigger noticed, which hooks
//             matched, exactly what was executed, whatever the script printed,
//             and how it ended. That history survives a restart, which is what
//             `pm2 logs` alone does not give you.
// server.log  one line per HTTP request, for the GitHub trigger's endpoint and
//             the dashboard.
// error.log   nothing but the error lines, so "did anything go wrong" is a
//             question answered by a file's length rather than by reading a
//             megabyte of ordinary activity. Every line in it is also in
//             hooks.log — except the ones written before hooks.log is open.
//
// There are two of that last one, filed by what the error is about:
//
//     logs/hooks/<hook>/error.log   what went wrong for one hook, beside the
//                                   responses it saved. Written lazily, so a
//                                   hook that has never failed has no file.
//     logs/hooks/error.log          what went wrong for the server itself — a
//                                   config it refused, a port already taken, a
//                                   trigger that would not start.
//
// Beside the first of those, one more file per hook:
//
//     logs/hooks/<hook>/hook.log    one line per request the hook made: when it
//                                   asked, what came back, and whether the
//                                   script ran.
//
// That last file answers the question the other two cannot. A website hook that
// polls every minute and fires twice a month writes nothing to error.log while
// it is working and nothing to hooks.log between the firings, so "is it still
// asking, and is the answer simply the same as yesterday's" had no file to read.
// Its lines are deliberately not copied into hooks.log: a poll that changed
// nothing is exactly what the activity log leaves out, and sixty of them an hour
// per hook would bury what it is for.
//
// The split is not tidiness. A per-hook folder is chosen by hook name, and hook
// names come out of hooks.json, so the one failure most in need of recording —
// a hooks.json that will not parse — has no name to file under. That is why the
// server-level file exists and is opened first, at a fixed path: before this, a
// config the server refused went only to stderr and PM2's log, and `gift log`
// showed a server that had simply stopped saying anything.
//
// This lives outside serve.js because the triggers write to the same logs: a
// clipboard watcher and a webhook delivery belong in one file, in the order
// they happened, or `gift log` stops being the place to look.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../functions.js');

// Rotate past this size, keeping one previous file (hooks.log.1).
const LOG_MAX_BYTES = 5 * 1024 * 1024;

// Where the per-hook folders live. The server opens them through openHookLogs,
// but `gift delete` and `gift status` have to find one with no server running,
// so which folder belongs to which hook is decided here rather than in each.
const HOOK_LOG_DIR = path.join(ROOT, 'logs', 'hooks');

const logFile = { path: null, bytes: 0, disabled: false };
const requestLogFile = { path: null, bytes: 0, disabled: false };
const errorLogFile = { path: null, bytes: 0, disabled: false };

// The folder holding one directory per hook, and the files opened under it so
// far. Both kinds are opened on a hook's first line rather than at startup: a
// folder full of empty error.log files is a folder that teaches you to ignore
// them, and a hook.log is created by the first request whether or not it fired.
let hookLogDir = null;
const hookErrorLogs = new Map();
const hookRequestLogs = new Map();

function stamp() {
    return new Date().toISOString();
}

/** A hook name as a directory name: the same one the saved responses use. */
function safeHookName(name) {
    return String(name || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

/**
 * The folder one hook's logs and saved responses live in. Always inside
 * logs/hooks — the name is sanitized, so a hook called `../../etc` is a folder
 * called `.._.._etc` rather than a path out of here.
 */
function hookLogDirFor(name) {
    return path.join(HOOK_LOG_DIR, safeHookName(name));
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

/**
 * Start the server-level error log. Opened before the config is read, so that
 * the config being unreadable is itself something that gets written down.
 */
function openErrorLog(file) {
    openLogFile(errorLogFile, file);
}

/**
 * Point the per-hook logs at the folder that already holds each hook's saved
 * responses. Nothing is created here; a hook's file is opened the first time
 * that hook has something to put in it.
 */
function openHookLogs(dir) {
    hookLogDir = dir || null;
    hookErrorLogs.clear();
    hookRequestLogs.clear();
}

/** One of a hook's own files, opened on its first line and remembered after. */
function hookFile(opened, name, file) {
    if (!hookLogDir || !name) return null;
    const safe = safeHookName(name);
    let target = opened.get(safe);
    if (!target) {
        target = { path: null, bytes: 0, disabled: false };
        openLogFile(target, path.join(hookLogDir, safe, file));
        opened.set(safe, target);
    }
    return target;
}

/**
 * The error log for one hook. Null when the line names no hook — which is what
 * sends server-level failures to the shared file rather than inventing a folder
 * called 'unknown' for them.
 */
function hookErrorLog(name) {
    return hookFile(hookErrorLogs, name, 'error.log');
}

/** The request log for one hook, beside its errors and its saved responses. */
function hookLog(name) {
    return hookFile(hookRequestLogs, name, 'hook.log');
}

/**
 * One request a hook made, in that hook's own hook.log. `outcome` is the column
 * the file exists for — fired, quiet or failed — so whether the script ran is
 * readable down the left of the file rather than out of the message.
 */
function logHook(name, outcome, message, fields = {}) {
    const target = hookLog(name);
    if (!target) return;
    const extra = formatFields(fields);
    appendLogFile(target, `${stamp()}  ${outcome.padEnd(6)}  ${message}${extra ? '  ' + extra : ''}\n`);
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
    // Errors go to two files. hooks.log keeps them in sequence with what led up
    // to them; the error log is the one you can read all of. Which error log
    // depends on whether the line names a hook — a failing poll belongs beside
    // that hook's responses, a port already in use belongs to the server.
    if (level === 'error') {
        appendLogFile(hookErrorLog(fields.hook) || errorLogFile, line + '\n');
    }
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

/**
 * For the failures that happen before there is a running server to log them —
 * a hooks.json that will not parse, a hook the triggers refuse. Everything
 * after startup reaches error.log through log('error', …) instead.
 */
function appendErrorLog(line) {
    appendLogFile(errorLogFile, line);
}

module.exports = {
    LOG_MAX_BYTES,
    HOOK_LOG_DIR,
    hookLogDirFor,
    logFile,
    requestLogFile,
    errorLogFile,
    openLog,
    openRequestLog,
    openErrorLog,
    openHookLogs,
    hookErrorLog,
    hookLog,
    safeHookName,
    log,
    logHook,
    forTrigger,
    appendRequestLog,
    appendErrorLog,
    formatFields,
    stamp,
};
