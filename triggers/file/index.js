// The file trigger — run a script when a file or folder changes.
//
//     { "type": "file", "path": "/etc/myapp", "pattern": "*.yml",
//       "events": ["add", "change"], "recursive": true }
//
// One run per settled batch of changes rather than one per file: saving a file
// is one thing that happened, and so is a checkout that rewrote four hundred of
// them. The script is told which file it was through GIFT_FILE, and given the
// whole list in GIFT_FILES_FILE when there was more than one.
//
// What is already on disk when the server starts is never a change — the first
// snapshot is the baseline, not a batch of four hundred additions.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { forTrigger } = require('../../utils/log.js');
const watcher = require('./watch.js');

const log = forTrigger('file');

const EVENTS = ['add', 'change', 'delete'];
const DEFAULT_EVENTS = ['add', 'change'];
const DEFAULT_DEBOUNCE_MS = 500;

// ----------------------------------------------------------------- contract ---

function normalize(trigger) {
    if (!trigger.path) throw new Error('has no "path" to watch');
    const target = String(trigger.path);
    if (!path.isAbsolute(target)) {
        throw new Error(`has a "path" that is not absolute — '${trigger.path}'. A relative path would mean whatever folder the server happened to start in.`);
    }

    const events = Array.isArray(trigger.events) && trigger.events.length
        ? trigger.events.map((event) => String(event).toLowerCase())
        : DEFAULT_EVENTS;
    for (const event of events) {
        if (!EVENTS.includes(event)) {
            throw new Error(`has an unknown file event '${event}' — try one of: ${EVENTS.join(', ')}`);
        }
    }

    const debounce = trigger.debounce === undefined ? DEFAULT_DEBOUNCE_MS : Number(trigger.debounce);
    if (!Number.isFinite(debounce) || debounce < 0) {
        throw new Error(`has a "debounce" of ${trigger.debounce} — it must be a number of milliseconds`);
    }

    const pattern = trigger.pattern ? String(trigger.pattern) : '';
    if (pattern) {
        try {
            watcher.globToRegExp(pattern);
        } catch (err) {
            throw new Error(`has a "pattern" that will not compile — ${err.message}`);
        }
    }

    return {
        path: path.normalize(target),
        events,
        // Only meaningful for a folder, and harmless on a file.
        recursive: trigger.recursive !== false,
        pattern,
        debounce: Math.round(debounce),
        poll: trigger.poll === undefined
            ? Number(process.env.GIFT_FILE_POLL) || watcher.DEFAULT_POLL_MS
            : Math.round(Number(trigger.poll)),
    };
}

function describe(trigger) {
    const rows = [['path', trigger.path]];
    if (trigger.pattern) rows.push(['pattern', trigger.pattern]);
    rows.push(['on', trigger.events.join(', ')]);
    rows.push(['recursive', trigger.recursive ? 'yes' : 'no']);
    if (trigger.debounce !== DEFAULT_DEBOUNCE_MS) rows.push(['debounce', `${trigger.debounce} ms`]);
    return rows;
}

function line(trigger) {
    return `${trigger.path}${trigger.pattern ? `/${trigger.pattern}` : ''}  ${trigger.events.join('|')}`;
}

async function ask({ askText, askYesNo, resolveTyped }) {
    console.log('A file or folder is watched; a change to it runs the script.');
    console.log('');

    const answer = await askText('File or folder to watch — an absolute path', {
        validate: (value) => {
            if (!value) return 'A path is needed; it is what the hook watches.';
            if (!path.isAbsolute(resolveTyped(value))) return 'That path must be absolute.';
            return null;
        },
    });
    if (answer === null) return null;
    const target = resolveTyped(answer);

    let isDirectory = false;
    try {
        isDirectory = fs.statSync(target).isDirectory();
    } catch {
        console.log(`  note: nothing at ${target} yet — it will be watched for when it appears`);
    }

    let pattern = '';
    let recursive = true;
    if (isDirectory) {
        const patternAnswer = await askText('Only files matching — *.yml, **/*.js, blank for all', { fallback: '' });
        if (patternAnswer === null) return null;
        pattern = patternAnswer;

        const sub = await askYesNo('Watch subfolders too?', true);
        if (sub === null) return null;
        recursive = sub;
    }

    const eventsAnswer = await askText('On which changes — add, change, delete', {
        fallback: DEFAULT_EVENTS.join(', '),
        validate: (value) => {
            const events = value.split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase());
            if (events.length === 0) return `Name at least one of: ${EVENTS.join(', ')}.`;
            const unknown = events.find((event) => !EVENTS.includes(event));
            return unknown ? `'${unknown}' is not one of: ${EVENTS.join(', ')}.` : null;
        },
    });
    if (eventsAnswer === null) return null;

    return {
        trigger: {
            type: 'file',
            path: target,
            pattern,
            events: eventsAnswer.split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase()),
            recursive,
            debounce: Number(process.env.GIFT_FILE_DEBOUNCE) || DEFAULT_DEBOUNCE_MS,
        },
        label: target,
    };
}

function afterNotes() {
    return [];
}

// -------------------------------------------------------------------- watch ---

/** `3 files` / `config.yml` — what the dashboard's line says happened. */
function title(root, changes) {
    if (changes.length === 1) return path.join(root, changes[0].file);
    const kinds = [...new Set(changes.map((change) => change.event))].join('/');
    return `${changes.length} files ${kinds}d under ${root}`;
}

/**
 * One watcher per hook. Two hooks on the same folder do watch it twice, which
 * is the honest cost of letting them filter and debounce differently — and a
 * second fs.watch on a folder is cheap next to a second snapshot of it.
 */
function start({ hooks, runtime }) {
    const watchers = hooks.map((hook) => {
        const trigger = hook.trigger;

        const handle = watcher.watch(
            trigger.path,
            {
                recursive: trigger.recursive,
                debounce: trigger.debounce,
                pattern: trigger.pattern,
                poll: trigger.poll,
            },
            (changes) => {
                // Filtered here rather than in the watcher: the snapshot has to
                // see every file to stay a true baseline, or a delete the hook
                // does not care about would show up as an add when it returns.
                const wanted = changes.filter((change) => trigger.events.includes(change.event));
                if (wanted.length === 0) return;

                const first = wanted[0];
                const listing = wanted.map((change) => `${change.event}\t${path.join(trigger.path, change.file)}`).join('\n');

                runtime.dispatch([hook], {
                    trigger: 'file',
                    kind: wanted.length === 1 ? first.event : 'changed',
                    title: title(trigger.path, wanted),
                    detail: `${wanted.length} file${wanted.length === 1 ? '' : 's'}`,
                    env: {
                        GIFT_PATH: trigger.path,
                        GIFT_FILE: path.join(trigger.path, first.file),
                        GIFT_FILE_NAME: path.basename(first.file),
                        GIFT_FILE_EVENT: first.event,
                        GIFT_FILE_COUNT: String(wanted.length),
                    },
                    files: { GIFT_FILES_FILE: { data: `${listing}\n`, suffix: '.tsv' } },
                });
            },
        );

        log('info', `watching ${trigger.path}`, {
            hook: hook.name,
            pattern: trigger.pattern || undefined,
            on: trigger.events.join('|'),
            mode: handle.mode,
        });
        if (handle.warning) log('warn', handle.warning, { hook: hook.name });

        return handle;
    });

    return {
        stop() {
            for (const handle of watchers) handle.stop();
        },
    };
}

module.exports = {
    name: 'file',
    title: 'File',
    summary: 'Watch a file or folder and run a script when it changes.',
    prompt: 'a file or folder is written to',
    EVENTS,
    normalize,
    describe,
    line,
    ask,
    afterNotes,
    start,
};
