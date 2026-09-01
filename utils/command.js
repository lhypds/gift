// One command line, as hooks.json spells a hook's `run` and as bash reads it.
//
//     "run": "/opt/myapp/deploy.sh"
//     "run": "bash /opt/myapp/deploy.sh --quiet"
//     "run": "node /opt/myapp/tools/notify.js"
//     "run": "cd /opt/myapp && git pull && ./deploy.sh"
//
// A hook used to name one executable file and nothing else, which made two
// questions trivial: what to check at startup, and which folder to run in. A
// command line answers neither on its own, so this reads as much of one as can
// be read without running it — the words up to the first control operator, with
// quotes and backslashes resolved the way bash resolves them.
//
// Nothing here expands anything. A word holding `$HOME`, a backtick or a glob
// comes back marked as not literal and every caller skips it: bash decides what
// it means at run time, and a guess made here could only ever be wrong in a
// warning.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** What ends the run of words that can be read: `|`, `&&`, `;`, a redirect. */
const CONTROL = new Set(['|', '&', ';', '<', '>', '(', ')', '\n']);

/** What makes a word something other than what it looks like. */
const EXPANDS = new Set(['$', '`', '*', '?', '[']);

// Checked for on PATH only if it is not one of these. A hook that starts `cd
// /opt/myapp && …` would otherwise be warned about a `cd` that no PATH has ever
// held, because bash never looks for one.
const BUILTINS = new Set([
    '.', ':', '[', 'alias', 'cd', 'command', 'echo', 'eval', 'exec', 'exit', 'export',
    'false', 'for', 'if', 'let', 'local', 'printf', 'pwd', 'read', 'return', 'set',
    'shift', 'source', 'test', 'trap', 'true', 'umask', 'unset', 'until', 'wait', 'while',
]);

/** A leading `~` is a literal character until something expands it. */
function expandHome(target) {
    if (target === '~') return os.homedir();
    return target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
}

/**
 * The words of a command line, as bash would split them, stopping at the first
 * control operator — everything past `&&` is a second command, and which one of
 * them a hook is "really" running is not a question with an answer.
 *
 * @returns {{text: string, literal: boolean}[]}
 *   `literal` is false when bash will turn the word into something else: a
 *   variable, a command substitution, a glob, or an unterminated quote.
 */
function words(command) {
    const found = [];
    let text = null; // null between words, a string inside one
    let literal = true;
    let quote = null;

    const end = () => {
        if (text === null) return;
        found.push({ text, literal });
        text = null;
        literal = true;
    };

    const line = String(command || '');
    for (let i = 0; i < line.length; i++) {
        const c = line[i];

        if (quote === "'") {
            if (c === "'") quote = null;
            else text += c;
            continue;
        }
        if (quote === '"') {
            if (c === '"') {
                quote = null;
            } else if (c === '\\' && '"\\$`'.includes(line[i + 1])) {
                text += line[++i];
            } else {
                if (c === '$' || c === '`') literal = false;
                text += c;
            }
            continue;
        }

        if (c === '\\') {
            // A trailing backslash continues the line; there is no next
            // character to take literally.
            if (i + 1 >= line.length) break;
            text = (text === null ? '' : text) + line[++i];
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            if (text === null) text = '';
            continue;
        }
        if (/\s/.test(c)) {
            end();
            continue;
        }
        // `#` starts a comment only where a word would start.
        if (c === '#' && text === null) break;
        if (CONTROL.has(c)) {
            end();
            return found;
        }
        if (EXPANDS.has(c)) literal = false;
        text = (text === null ? '' : text) + c;
    }

    // An unterminated quote means the line does not say what it appears to;
    // whatever word it opened is not to be trusted.
    if (quote !== null) literal = false;
    end();
    return found;
}

/** Whether a word names a place in the filesystem rather than a PATH lookup. */
function isPath(text) {
    return text.startsWith('/') || text === '~' || text.startsWith('~/') || text.includes('/');
}

/**
 * What the command line runs first — a path, or a name for bash to find on
 * PATH. Null when the line does not begin with a word that can be read: a
 * variable, a subshell, a `FOO=bar` assignment standing in front of the real
 * program.
 */
function program(command) {
    const [first] = words(command);
    if (!first || !first.literal || !first.text) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text)) return null;
    return first.text;
}

/** Every word of the command that names a file, in the order they are written. */
function paths(command) {
    return words(command)
        .filter((word) => word.literal && !word.text.startsWith('-') && isPath(word.text))
        .map((word) => word.text);
}

/**
 * The folder a command runs in when its hook does not say: the folder of the
 * script it runs. The first absolute path that is not the program itself, so
 * `/usr/bin/env python3 /opt/myapp/notify.py` runs in /opt/myapp rather than in
 * /usr/bin — falling back to the program's own folder, which is the whole
 * answer when the command is one script's path and nothing else.
 *
 * @returns {string|null}  an absolute directory, or null when the command names
 *   no absolute path and so says nothing about where it belongs.
 */
function directory(command) {
    const absolute = paths(command).map(expandHome).filter((p) => path.isAbsolute(p));
    if (absolute.length === 0) return null;
    const first = program(command);
    // `cd /opt/myapp && ./deploy.sh` has already said where it runs, and said a
    // folder rather than a file in one.
    if (first === 'cd') return absolute[0];
    const runs = first ? expandHome(first) : null;
    return path.dirname(absolute.find((p) => p !== runs) || absolute[0]);
}

function executable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function onPath(name) {
    return (process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .some((dir) => executable(path.join(dir, name)));
}

/**
 * What is worth saying about a command before it has ever run: the program it
 * starts with, and the file that program is being pointed at. Both are what a
 * hook typically gets wrong once — a script that is not executable, a path with
 * a typo in it — and both are cheap to notice at startup rather than at 3am in
 * the log.
 *
 * Only the program has to be executable. A script handed to an interpreter —
 * `bash deploy.sh` — is read rather than executed, so it is checked for being
 * there and nothing more.
 *
 * @param {string} command  the hook's `run`, as written
 * @param {string} [cwd]  the folder it runs in, for resolving relative paths
 * @returns {string[]}  a note per problem; empty when there is nothing to say
 */
function notes(command, cwd) {
    const first = program(command);
    if (!first) return [];

    const found = [];
    const resolve = (target) => path.resolve(cwd || process.cwd(), expandHome(target));

    // A path with a space in it was one word back when `run` was a path and is
    // two now. The file being right there is proof of what was meant, so say
    // that rather than reporting the half of it bash would go looking for.
    const whole = String(command).trim();
    if (whole !== first && fs.existsSync(resolve(whole))) {
        return [`${whole} is one file, but the command reads as ${words(whole).length} words — quote it`];
    }

    if (isPath(first)) {
        const file = resolve(first);
        if (!fs.existsSync(file)) found.push(`no file at ${file} yet`);
        else if (!executable(file)) found.push(`${file} is not executable — chmod +x it`);
    } else if (!BUILTINS.has(first) && !onPath(first)) {
        found.push(`${first} is not on PATH`);
    }

    // Only the first path after the program — the script it is being pointed
    // at, usually. Later ones are as likely to be where the command writes as
    // where it reads. It may also be a folder, `git -C` being what it is, so
    // the note says nothing about which.
    const script = paths(command).find((p) => p !== first);
    if (script) {
        const target = resolve(script);
        if (!fs.existsSync(target)) found.push(`nothing at ${target} yet`);
    }
    return found;
}

module.exports = {
    expandHome,
    words,
    isPath,
    program,
    paths,
    directory,
    notes,
};
