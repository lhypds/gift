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

/**
 * Characters a terminal draws two columns wide — the CJK blocks, Hangul, the
 * fullwidth forms and the emoji — and the ones it draws none for, which hang off
 * the character before them. Everything else is one column.
 *
 * A commit message or a repository name written in Chinese is the usual reason
 * this matters: counted as one column each, a line of it runs through the
 * right-hand border of whatever box it is in and wraps the frame.
 */
const WIDE =
    /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{17000}-\u{18aff}]|[\u{1f300}-\u{1f9ff}]|[\u{20000}-\u{3fffd}]/u;
const ZERO = /[̀-ͯ҃-҉᪰-᫿⃐-⃰︀-️​-‏]/u;

/** How many columns one character takes. */
function charWidth(character) {
    if (ZERO.test(character)) return 0;
    return WIDE.test(character) ? 2 : 1;
}

/** Visible width in columns. */
function width(text) {
    let columns = 0;
    for (const character of String(text)) columns += charWidth(character);
    return columns;
}

function pad(text, columns) {
    return String(text) + ' '.repeat(Math.max(0, columns - width(text)));
}

/** Cut to `columns`, marking what was dropped with an ellipsis. */
function truncate(text, columns) {
    const value = String(text);
    if (width(value) <= columns) return value;
    if (columns <= 0) return '';

    // The ellipsis takes a column of its own, unless there is only the one — a
    // box that narrow has nothing to say either way.
    const room = columns > 1 ? columns - 1 : columns;
    let out = '';
    let used = 0;
    for (const character of value) {
        const size = charWidth(character);
        if (used + size > room) break;
        out += character;
        used += size;
    }
    return columns > 1 ? `${out}…` : out;
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

module.exports = { limiter, expandHome, shortenHome, width, charWidth, pad, truncate, formatRelative };
