// The clipboard trigger — run a command when what is on the clipboard changes.
//
//     { "type": "clipboard", "match": "^TODO:", "matchType": "regex" }
//
// The clipboard is read on a timer and compared with what was there last time.
// A change that matches fires the hook; a change that does not is ignored, and
// so is the value that was already on the clipboard when the server started —
// that is not a change, and firing on it would mean every restart runs every
// clipboard hook.
//
// What was copied reaches the command as GIFT_CLIPBOARD (and, whole, in the file
// GIFT_CLIPBOARD_FILE). It is never part of a command line: someone who copies
// `; rm -rf /` has copied a string, and gift treats it as one.
'use strict';

const { forTrigger } = require('../../utils/log.js');
const { INLINE_LIMIT } = require('../runtime.js');
const match = require('../match.js');
const clipboard = require('./watch.js');

const log = forTrigger('clipboard');

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 200;

// How much of the clipboard the log and the dashboard quote. Enough to
// recognise what was copied, not enough to paste a document into a log file.
const PREVIEW = 80;

function preview(text) {
    const oneLine = String(text).replace(/\s+/g, ' ').trim();
    return oneLine.length > PREVIEW ? `${oneLine.slice(0, PREVIEW - 1)}…` : oneLine;
}

// ----------------------------------------------------------------- contract ---

function normalize(trigger) {
    const spec = match.normalize(trigger);

    const interval = trigger.interval === undefined ? DEFAULT_INTERVAL_MS : Number(trigger.interval);
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
        throw new Error(`has an "interval" of ${trigger.interval} — it must be at least ${MIN_INTERVAL_MS} ms`);
    }

    return { ...spec, interval: Math.round(interval) };
}

function describe(trigger) {
    return [
        ['match', match.describe(trigger)],
        ['polled', `every ${trigger.interval} ms`],
    ];
}

function line(trigger) {
    // Not prefixed with "clipboard": everywhere this is shown, the trigger type
    // is already in the column beside it.
    return match.describe(trigger);
}

async function ask({ askText, askYesNo }) {
    console.log('The clipboard is read on a timer; a change that matches runs the command.');
    console.log('');

    const everything = await askYesNo('Fire on every clipboard change?', false);
    if (everything === null) return null;

    let spec = { match: '', matchType: 'any' };
    if (!everything) {
        const how = await askText('Match how — contains, exact or regex', {
            fallback: 'contains',
            validate: (value) =>
                ['contains', 'exact', 'regex'].includes(value.toLowerCase())
                    ? null
                    : 'Answer contains, exact or regex.',
        });
        if (how === null) return null;

        const text = await askText(`Text to match — ${how.toLowerCase()}`, {
            validate: (value) => {
                if (!value) return 'Type the text to match, or start again and fire on every change.';
                try {
                    match.normalize({ match: value, matchType: how.toLowerCase() });
                } catch (err) {
                    return err.message.replace(/^has a /, 'That is not a ');
                }
                return null;
            },
        });
        if (text === null) return null;
        spec = { match: text, matchType: how.toLowerCase() };
    }

    const interval = await askText('How often to check, in milliseconds', {
        fallback: String(Number(process.env.GIFT_CLIPBOARD_INTERVAL) || DEFAULT_INTERVAL_MS),
        validate: (value) => {
            const ms = Number(value);
            if (!Number.isFinite(ms)) return 'Type a number of milliseconds.';
            if (ms < MIN_INTERVAL_MS) return `Check no more often than every ${MIN_INTERVAL_MS} ms.`;
            return null;
        },
    });
    if (interval === null) return null;

    return {
        trigger: { type: 'clipboard', ...spec, interval: Math.round(Number(interval)) },
        // The matched text is the closest this trigger has to a name, and is
        // what the default hook name is built from.
        label: spec.match,
    };
}

function afterNotes() {
    const found = clipboard.reader();
    if (found.error) {
        return [
            `warning: ${found.error}`,
            '         The hook is saved, but nothing can read the clipboard until one is installed.',
        ];
    }
    return [];
}

// -------------------------------------------------------------------- watch ---

/**
 * One timer for every clipboard hook, rather than one each: they are all
 * watching the same clipboard, and reading it four times a second to answer
 * four hooks would be four times the work for the same answer. The fastest
 * interval any hook asked for is the one used.
 */
function start({ hooks, runtime }) {
    const found = clipboard.reader();
    if (found.error) {
        log('error', `clipboard hooks will not fire — ${found.error}`, { hooks: hooks.length });
        return { stop() {} };
    }

    const interval = Math.min(...hooks.map((hook) => hook.trigger.interval));
    log('info', `watching the clipboard with ${found.command}`, {
        hooks: hooks.length,
        every: `${interval}ms`,
    });

    // Seeded on the first read so that whatever is already on the clipboard
    // when the server starts counts as "what was there", not as a change.
    let last = null;
    let reading = false;
    let stopped = false;

    const tick = async () => {
        if (reading || stopped) return;
        reading = true;
        try {
            const result = await clipboard.read(found);
            if (stopped) return;
            if (result.error) {
                log('warn', `could not read the clipboard: ${result.error}`);
                return;
            }

            const text = result.text;
            if (last === null) {
                last = text;
                return;
            }
            if (text === last) return;
            last = text;
            // An empty clipboard is a change, but not one worth running
            // anything for — it is what a cleared clipboard looks like.
            if (!text.trim()) return;

            for (const hook of hooks) {
                const found_ = match.test(text, hook.trigger);
                if (!found_) continue;

                runtime.dispatch([hook], {
                    trigger: 'clipboard',
                    kind: 'copied',
                    title: preview(text),
                    detail: hook.name,
                    env: {
                        // Capped: execve has a limit, and a copied document
                        // would reach it. The file below always holds all of it.
                        GIFT_CLIPBOARD: text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) : text,
                        GIFT_CLIPBOARD_BYTES: String(Buffer.byteLength(text)),
                        ...match.env(found_),
                    },
                    files: { GIFT_CLIPBOARD_FILE: { data: text, suffix: '.txt' } },
                });
            }
        } finally {
            reading = false;
        }
    };

    const timer = setInterval(tick, interval);
    timer.unref?.();
    tick();

    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        },
    };
}

module.exports = {
    name: 'clipboard',
    title: 'Clipboard',
    summary: 'Watch the clipboard and run a command when its contents change.',
    prompt: 'something is copied to the clipboard',
    DEFAULT_INTERVAL_MS,
    normalize,
    describe,
    line,
    ask,
    afterNotes,
    start,
};
