// Noticing that a repository changed.
//
// A recursive fs.watch is the cheap way to hear about edits the moment they
// happen — it is backed by FSEvents on macOS and by ReadDirectoryChangesW on
// Windows. Where recursive watching is unavailable or refused (an older Linux,
// too many inotify watches, a network filesystem), the repository falls back to
// being asked on a timer instead.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** How long the edits keep arriving before we run git once for all of them. */
const DEBOUNCE_MS = 300;

/**
 * Inside .git, only these matter: everything else is git's own bookkeeping, and
 * reacting to it would mean refreshing in circles.
 */
const GIT_PATHS = /^\.git[\\/](HEAD|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD|index|refs[\\/])/;

/** Editors and build tools write these constantly, and none of them is a change. */
const NOISE = /(^|[\\/])(node_modules|\.DS_Store|[^\\/]*\.(swp|swx|tmp)|4913)([\\/]|$)|\.lock$|~$/;

function interesting(filename) {
    if (!filename) return true; // no name given — assume it counts
    const relative = String(filename);
    // .git/index.lock and friends appear and vanish around every git command,
    // and the real change lands right after them anyway.
    if (relative.endsWith('.lock')) return false;
    if (relative.startsWith('.git/') || relative.startsWith('.git\\') || relative === '.git') {
        return GIT_PATHS.test(relative);
    }
    return !NOISE.test(relative);
}

/**
 * Watch every repository and call `onChange(repo)` when one of them moves,
 * no more than once per debounce window per repository.
 *
 * @param {object[]} rows Repository rows; each needs a `dir`.
 * @param {(repo: object) => void} onChange
 * @returns {{close: () => void, fallbacks: string[]}} `fallbacks` names the
 *   repositories that could not be watched and are polled instead.
 */
function watchAll(rows, onChange, pollSeconds) {
    const watchers = [];
    const timers = new Map();
    const fallbacks = [];

    const schedule = (repo) => {
        clearTimeout(timers.get(repo.dir));
        timers.set(
            repo.dir,
            setTimeout(() => {
                timers.delete(repo.dir);
                onChange(repo);
            }, DEBOUNCE_MS),
        );
    };

    for (const repo of rows) {
        try {
            const watcher = fs.watch(repo.dir, { recursive: true, persistent: true }, (_event, filename) => {
                if (interesting(filename)) schedule(repo);
            });
            // A watcher that dies later (the folder was moved, the limit was
            // hit) must not take the whole app down with it.
            watcher.on('error', () => {});
            watchers.push(() => watcher.close());
        } catch {
            fallbacks.push(repo.dir);
            const timer = setInterval(() => onChange(repo), Math.max(1000, pollSeconds * 1000));
            watchers.push(() => clearInterval(timer));
        }
    }

    return {
        close() {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
            for (const close of watchers) {
                try {
                    close();
                } catch {
                    /* already gone */
                }
            }
        },
        fallbacks,
    };
}

module.exports = { watchAll, interesting, DEBOUNCE_MS };
