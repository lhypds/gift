// Small helpers shared by the rest of repo-master: paths, text widths, times,
// and a limiter so a folder full of repositories never forks a hundred gits at
// once.
'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Run at most `max` async jobs at a time. Returns a function that takes a
 * thunk and resolves with its result once a slot is free.
 */
function limiter(max) {
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= max || queue.length === 0) return;
        active++;
        const { thunk, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(thunk)
            .then(resolve, reject)
            .finally(() => {
                active--;
                next();
            });
    };

    return (thunk) =>
        new Promise((resolve, reject) => {
            queue.push({ thunk, resolve, reject });
            next();
        });
}

/** A leading `~` read from the configuration or a flag is literal until expanded. */
function expandHome(value) {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
}

/** The reverse, for the header: /Users/me/projects reads as ~/projects. */
function shortenHome(value) {
    const home = os.homedir();
    if (value === home) return '~';
    if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1)}`;
    return value;
}

/** Visible width in columns, counting a surrogate pair as one character. */
function width(text) {
    return [...String(text)].length;
}

function pad(text, columns) {
    return String(text) + ' '.repeat(Math.max(0, columns - width(text)));
}

/** Cut to `columns`, marking what was dropped with an ellipsis. */
function truncate(text, columns) {
    const characters = [...String(text)];
    if (characters.length <= columns) return String(text);
    if (columns <= 1) return characters.slice(0, Math.max(0, columns)).join('');
    return `${characters.slice(0, columns - 1).join('')}…`;
}

/**
 * How long ago something happened, in the table's own words: `just now`,
 * `1min ago`, `3h ago`, `2d ago`. Null times read as `-`.
 */
function formatRelative(time, now = Date.now()) {
    if (!time) return '-';

    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 45) return 'just now';

    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${Math.max(1, minutes)}min ago`;

    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    return `${Math.round(hours / 24)}d ago`;
}

/** Quote a string for `sh -c`. */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = { limiter, expandHome, shortenHome, width, pad, truncate, formatRelative, shellQuote };
