// What every trigger shares: running a hook's command, and recording what
// happened where `gift log` and the dashboard can see it.
//
// A trigger's whole job is to notice something and call `fire`. It never spawns
// anything itself, so the four of them cannot drift apart on the parts that
// matter — one run at a time per hook, a command line and arguments that come
// from hooks.json and never from the thing that fired, output captured into the
// log and the dashboard, temporary files cleaned up afterwards. A fifth trigger
// dropped into triggers/ gets all of that by calling the same two functions.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { log } = require('../utils/log.js');
const command = require('../utils/command.js');

// A hook's `run` is a command line, so something has to read it. bash is what
// the rest of gift already assumes — setup, install and start are all bash —
// and it is what the command was written for.
const SHELL = 'bash';

const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

// Captured per hook run and stored into events.json alongside the event.
// Capped so a chatty script can't grow that file without bound.
const HOOK_OUTPUT_LIMIT = 50 * 1024;

// How much of a trigger's payload goes into an environment variable directly.
// Anything longer is only written to the file beside it: execve has a limit,
// and a clipboard holding a pasted document would otherwise reach it.
const INLINE_LIMIT = 4 * 1024;

// ------------------------------------------------------------------ events ---
//
// Recent events live in memory for fast reads, but are mirrored to disk so
// that a restart — `gift update`, `pm2 restart`, a crash — does not wipe the
// dashboard back to empty.

function loadEvents(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Events are always unshifted onto the front as they arrive, so the array stays
// newest-first — meaning anything past the retention window is a contiguous run
// at the end, not scattered throughout.
function pruneStaleEvents(events, now) {
    const cutoff = now - EVENT_RETENTION_MS;
    let end = events.length;
    while (end > 0 && new Date(events[end - 1].receivedAt).getTime() < cutoff) end--;
    const removed = events.length - end;
    if (removed > 0) events.length = end;
    return removed;
}

// -------------------------------------------------------------- temp files ---

function tempFile(prefix, id, data, suffix) {
    const safeId = String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const file = path.join(
        os.tmpdir(),
        `gift-${prefix}-${safeId || 'unknown'}-${process.pid}-${Date.now()}${suffix || ''}`,
    );
    fs.writeFileSync(file, data, { mode: 0o600 });
    return file;
}

function removeQuietly(file) {
    try {
        fs.unlinkSync(file);
    } catch {
        /* already gone */
    }
}

// ------------------------------------------------------------------ output ---

/**
 * Accumulates a hook run's combined stdout+stderr, in the order each line
 * actually surfaced — the same order that lands in hooks.log — capped so one
 * run can't grow events.json without bound.
 */
function createOutputRecorder(limit = HOOK_OUTPUT_LIMIT) {
    let text = '';
    let truncated = false;
    return {
        append(line) {
            if (truncated) return;
            text += line;
            if (text.length > limit) {
                text = text.slice(0, limit) + '\n… (truncated)';
                truncated = true;
            }
        },
        value() {
            return text;
        },
    };
}

function pipeOutput(stream, hookName, level, recorder) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            log(level, `[${hookName}] ${line}`);
            recorder?.append(`${line}\n`);
        }
    });
    stream.on('end', () => {
        if (buffer.trim()) {
            log(level, `[${hookName}] ${buffer.trim()}`);
            recorder?.append(`${buffer.trim()}\n`);
        }
    });
}

// ----------------------------------------------------------------- runtime ---

/**
 * @param {object} options  the resolved server settings: eventsFile, dryRun.
 */
function createRuntime(options = {}) {
    const events = options.eventsFile ? loadEvents(options.eventsFile) : [];

    const persist = () => {
        if (!options.eventsFile || persist.disabled) return;
        const temp = `${options.eventsFile}.tmp`;
        try {
            // Written through a temporary file, so a crash mid-write cannot
            // truncate it.
            fs.writeFileSync(temp, JSON.stringify(events), { mode: 0o600 });
            fs.renameSync(temp, options.eventsFile);
        } catch (err) {
            persist.disabled = true;
            log('warn', `cannot write ${options.eventsFile}: ${err.message}`, {
                hint: 'recent events will not survive a restart until this is fixed',
            });
        }
    };
    persist.disabled = false;

    if (pruneStaleEvents(events, Date.now()) > 0) persist();

    // One run at a time per hook. An event that arrives mid-run is coalesced
    // into a single follow-up run, so a burst — of pushes, of clipboard
    // changes, of writes to a watched file — never stacks up deployments.
    const running = new Map();
    const stateOf = (hook) => {
        if (!running.has(hook.name)) running.set(hook.name, { running: false, pending: null });
        return running.get(hook.name);
    };

    let counter = 0;
    /** A local id for triggers that have none of their own to quote. */
    const nextId = (type) => `${type}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

    /**
     * Open an entry in the dashboard's list. Called the moment a trigger
     * notices something, before anything can reject it, so even an event that
     * turns out to match nothing leaves a record of having happened.
     */
    function beginEvent({ trigger, kind, id, title, link, source }) {
        const event = {
            id: id || nextId(trigger),
            trigger,
            kind: kind || trigger,
            title: title || '',
            link: link || null,
            source: source || null,
            receivedAt: new Date(),
            outcome: 'Receiving',
            tone: 'neutral',
            runs: [],
        };
        events.unshift(event);
        pruneStaleEvents(events, Date.now());
        persist();
        return event;
    }

    const TONES = { Accepted: 'ready', Ping: 'ready', Rejected: 'warning', Failed: 'warning' };

    function finishEvent(event, outcome, detail, extra = {}) {
        if (!event) return;
        event.outcome = outcome;
        event.detail = detail === undefined ? event.detail : detail;
        Object.assign(event, extra);
        event.tone = TONES[outcome] || 'neutral';
        persist();
    }

    /**
     * Run one hook's command for one event.
     *
     * `event.env` reaches the command as environment variables and
     * `event.files` as files it is handed the path to — never as text pasted
     * into the command, which is hooks.json's alone. A clipboard holding
     * `; rm -rf /` is therefore a string like any other: bash does not re-read
     * what a variable expanded to looking for syntax.
     */
    function fire(hook, event, { env = {}, files = {} } = {}) {
        const status = stateOf(hook);
        if (!hook.detach && status.running) {
            status.pending = { event, env, files };
            log('info', 'hook busy, queued one re-run', { hook: hook.name, event: event.id });
            return;
        }

        if (options.dryRun) {
            log('info', 'dry run, not executing', {
                hook: hook.name,
                event: event.id,
                run: hook.run,
                args: hook.args.length ? hook.args.join(' ') : undefined,
            });
            return;
        }

        // Written per run rather than per event: two hooks firing on the same
        // event each get their own copy, and neither can pull the file out from
        // under the other by finishing first.
        const written = [];
        const fileEnv = {};
        for (const [variable, spec] of Object.entries(files)) {
            const file = tempFile(event.trigger, event.id, spec.data, spec.suffix);
            written.push(file);
            fileEnv[variable] = file;
        }
        const cleanUp = () => written.forEach(removeQuietly);

        const childEnv = {
            ...process.env,
            GIFT_HOOK: hook.name,
            GIFT_TRIGGER: event.trigger,
            GIFT_EVENT: event.kind,
            GIFT_EVENT_ID: event.id,
            GIFT_EVENT_TITLE: event.title || '',
            ...env,
            ...fileEnv,
        };

        const cwd = hook.cwd || command.directory(hook.run) || undefined;
        const startedAt = Date.now();

        // Arguments are handed to bash as positional parameters and referred to
        // from the command, rather than pasted into its text: an argument with
        // a space or a quote in it stays one argument, and `run` stays the only
        // thing bash parses. A command with no arguments is left exactly as
        // written, so a trailing `&` or `#` still means what it says.
        const line = hook.args.length ? `${hook.run} "$@"` : hook.run;

        let child;
        try {
            child = spawn(SHELL, ['-c', line, hook.name, ...hook.args], {
                cwd,
                env: childEnv,
                detached: hook.detach,
                stdio: hook.detach ? 'ignore' : ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            cleanUp();
            const message = err && err.message ? err.message : String(err);
            log('error', `hook failed to start: ${message}`, { hook: hook.name, run: hook.run });
            event.runs.push({
                hook: hook.name,
                startedAt: new Date(startedAt).toISOString(),
                error: message,
            });
            persist();
            return;
        }

        // Logged after the spawn so the pid is part of the same line. Only bash
        // itself missing shows up as 'hook failed to start' below, with no pid
        // here; a command naming a file that is not there is bash's to report,
        // and arrives as exit 127 with its message in the run's output.
        log('info', 'running hook', {
            hook: hook.name,
            trigger: event.trigger,
            event: event.kind,
            id: event.id,
            what: event.title,
            run: hook.run,
            args: hook.args.length ? hook.args.join(' ') : undefined,
            cwd,
            pid: child.pid,
            detach: hook.detach ? 'yes' : undefined,
        });

        if (hook.detach) {
            child.unref();
            child.on('error', (err) => {
                log('error', `hook failed to start: ${err.message}`, { hook: hook.name, run: hook.run });
                cleanUp();
            });
            // The script owns its lifetime now; give it a window to read its files.
            setTimeout(cleanUp, 5 * 60 * 1000).unref();
            return;
        }

        status.running = true;
        const recorder = createOutputRecorder();
        pipeOutput(child.stdout, hook.name, 'info', recorder);
        pipeOutput(child.stderr, hook.name, 'warn', recorder);

        // A child that cannot be spawned emits 'error' and then 'close' as
        // well, which would otherwise be two entries in the dashboard for one
        // run — and the second would say `exit null` where the first said why.
        let done = false;
        const finish = (fields) => {
            if (done) return;
            done = true;
            cleanUp();
            status.running = false;
            event.runs.push({ hook: hook.name, startedAt: new Date(startedAt).toISOString(), ...fields });
            persist();

            const queued = status.pending;
            if (queued) {
                status.pending = null;
                fire(hook, queued.event, { env: queued.env, files: queued.files });
            }
        };

        child.on('error', (err) => {
            log('error', `hook failed to start: ${err.message}`, { hook: hook.name, run: hook.run });
            finish({ error: err.message });
        });

        child.on('close', (code, signal) => {
            if (!done) {
                log(code === 0 ? 'info' : 'error', 'hook finished', {
                    hook: hook.name,
                    event: event.id,
                    exit: signal ? undefined : code,
                    signal,
                    ms: Date.now() - startedAt,
                });
            }
            finish({
                exit: signal ? null : code,
                signal: signal || null,
                ms: Date.now() - startedAt,
                output: recorder.value(),
            });
        });
    }

    /**
     * The common shape of a trigger that watches one thing and runs its hooks
     * when it changes: open the event, fire every hook, close the event. Three
     * of the four do exactly this; GitHub does not, because a delivery has to
     * be verified and matched before it is known which hooks it is for.
     */
    function dispatch(hooks, { trigger, kind, id, title, link, detail, env, files }) {
        const event = beginEvent({ trigger, kind, id, title, link });
        if (hooks.length === 0) {
            finishEvent(event, 'No match', 'No hook is watching this');
            return event;
        }
        finishEvent(event, 'Accepted', detail || hooks.map((h) => h.name).join(', '));
        for (const hook of hooks) {
            try {
                fire(hook, event, { env, files });
            } catch (err) {
                log('error', `hook error: ${err.message}`, { hook: hook.name });
            }
        }
        return event;
    }

    return {
        events,
        persist,
        prune: () => {
            if (pruneStaleEvents(events, Date.now()) > 0) persist();
        },
        beginEvent,
        finishEvent,
        fire,
        dispatch,
        options,
    };
}

module.exports = {
    createRuntime,
    createOutputRecorder,
    pruneStaleEvents,
    loadEvents,
    tempFile,
    removeQuietly,
    EVENT_RETENTION_MS,
    HOOK_OUTPUT_LIMIT,
    INLINE_LIMIT,
};
