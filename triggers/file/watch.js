// Watching a file or a folder, and saying precisely what changed.
//
// `fs.watch` alone is not enough to build a hook on. It reports 'rename' for a
// file appearing *and* for one disappearing, it reports 'change' more than once
// for a single save, and its recursive mode is not available everywhere. What it
// is good at is being told quickly that *something* happened.
//
// So it is used as the doorbell, not the answer: a notification starts a short
// debounce, and when that settles the tree is walked and compared against the
// snapshot taken last time. The difference between the two is what actually
// happened — this file added, that one changed, this one gone — which is what a
// script can be given. Where fs.watch cannot be used at all, the same walk runs
// on a timer instead, and everything downstream is identical.
//
// The walk is bounded: a watch aimed at a home directory should degrade into a
// complaint, not into a server that never finishes a scan.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 20000;
const DEFAULT_POLL_MS = 2000;

/** `*.yml`, `**​/*.test.js` — a path pattern, not a regular expression. */
function globToRegExp(pattern) {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '*') {
            if (pattern[i + 1] === '*') {
                // `**/` crosses folders; a bare `**` is every character left.
                if (pattern[i + 2] === '/') {
                    source += '(?:.*/)?';
                    i += 2;
                } else {
                    source += '.*';
                    i += 1;
                }
            } else {
                source += '[^/]*';
            }
        } else if (char === '?') source += '[^/]';
        else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
}

/**
 * Walk `root`, returning path → "mtime:size" for every file under it.
 * Directories are not entries of their own: a folder's mtime changes for
 * reasons its contents did not, and the files inside already say what happened.
 */
function snapshot(root, { recursive, matches }) {
    const entries = new Map();
    let truncated = false;

    const walk = (dir, prefix) => {
        if (truncated) return;
        let listing;
        try {
            listing = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // vanished mid-walk, or not ours to read
        }

        for (const entry of listing) {
            if (truncated) return;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (recursive) walk(full, relative);
                continue;
            }
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            if (matches && !matches(relative)) continue;

            if (entries.size >= MAX_ENTRIES) {
                truncated = true;
                return;
            }
            try {
                const stat = fs.statSync(full);
                entries.set(relative, `${stat.mtimeMs}:${stat.size}`);
            } catch {
                /* vanished between the listing and the stat */
            }
        }
    };

    let stat;
    try {
        stat = fs.statSync(root);
    } catch {
        return { entries, truncated, missing: true };
    }

    if (stat.isDirectory()) walk(root, '');
    else entries.set(path.basename(root), `${stat.mtimeMs}:${stat.size}`);

    return { entries, truncated, missing: false };
}

/** What changed between two snapshots, as add / change / delete. */
function diff(before, after) {
    const changes = [];
    for (const [file, state] of after) {
        const was = before.get(file);
        if (was === undefined) changes.push({ file, event: 'add' });
        else if (was !== state) changes.push({ file, event: 'change' });
    }
    for (const file of before.keys()) {
        if (!after.has(file)) changes.push({ file, event: 'delete' });
    }
    return changes;
}

/**
 * Watch `root` and call `onChanges(changes)` with a settled batch.
 *
 * A batch, not one call per file: a `git checkout` touching four hundred files
 * is one thing that happened, and four hundred hook runs is not a useful way to
 * describe it.
 *
 * @returns {{stop(): void, mode: string, warning: string|null}}
 */
function watch(root, options, onChanges) {
    const { recursive = false, debounce = 500, pattern = '', poll = DEFAULT_POLL_MS } = options;
    const matches = pattern ? (file) => globToRegExp(pattern).test(file) || globToRegExp(pattern).test(path.basename(file)) : null;
    const shape = { recursive, matches };

    let current = snapshot(root, shape);
    let warning = current.truncated
        ? `more than ${MAX_ENTRIES} files under ${root} — only the first ${MAX_ENTRIES} are watched`
        : null;

    let stopped = false;
    let settle = null;

    const compare = () => {
        if (stopped) return;
        const next = snapshot(root, shape);
        const changes = diff(current.entries, next.entries);
        current = next;
        if (changes.length) onChanges(changes);
    };

    // Every notification restarts the timer, so a save that arrives as three
    // events is one comparison, and a long copy is compared once it is over
    // rather than halfway through.
    const nudge = () => {
        if (stopped) return;
        clearTimeout(settle);
        settle = setTimeout(compare, debounce);
        settle.unref?.();
    };

    let watcher = null;
    let poller = null;
    let mode = 'fs.watch';

    try {
        watcher = fs.watch(root, { recursive, persistent: false }, nudge);
        watcher.on('error', (err) => {
            // A watched folder that is deleted takes its watcher with it. Fall
            // back to the timer rather than going quiet, so the hook still
            // notices when it comes back.
            if (stopped) return;
            warning = `fs.watch stopped: ${err.message} — polling instead`;
            watcher = null;
            mode = 'polling';
            poller = setInterval(compare, poll);
            poller.unref?.();
        });
    } catch (err) {
        // Recursive fs.watch is not available on every platform and Node, and
        // a missing path cannot be watched at all — both are the timer's job.
        mode = 'polling';
        warning = warning || `${err.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
            ? 'recursive watching is not available on this platform'
            : err.message} — polling every ${poll} ms instead`;
        poller = setInterval(compare, poll);
        poller.unref?.();
    }

    return {
        mode,
        warning,
        stop() {
            stopped = true;
            clearTimeout(settle);
            clearInterval(poller);
            watcher?.close();
        },
    };
}

module.exports = { watch, snapshot, diff, globToRegExp, MAX_ENTRIES, DEFAULT_POLL_MS };
