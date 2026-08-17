// The folders the table is not to bother with, written down the way git writes
// them. A folder of everything anybody ever cloned holds a good deal that is
// nobody's work — an archive of finished projects, somebody else's source read
// once, a scratch folder — and a table listing all of it is a table read past
// rather than read.
//
// A `.giftignore` in the watched folder is the answer — or a `.gitignore`, where
// there is no `.giftignore` — in the syntax already known: one folder to a line,
// `#` for a comment, `!` to let one back in, `*` and `**` where a name is a shape
// rather than a name. What it rules out is not scanned and not listed, and neither
// is anything inside it — a folder left out takes its repositories with it,
// exactly as git's does.
//
//     archive/           the finished ones
//     vendor-*           anything cloned to be read
//     /tmp               only the one at the top
//     !archive/gift      except this one
//
// Patterns are matched against the path relative to the watched folder, so a
// name with no slash in it — `archive` — means a folder of that name at any
// depth, and one with a slash — `/tmp`, `public/notes` — is tied to the top.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const { expandHome } = require('./util.js');

// The file this is all read from, unless `ignore_file` names another. gift's own
// name is looked for first and git's is the fallback, so a folder may leave its
// `.gitignore` to git and keep what the table skips in a `.giftignore` of its own.
const DEFAULT_FILES = ['.giftignore', '.gitignore'];

/** The name the help and header call the default by. */
const FILE = DEFAULT_FILES[0];

/** One character of a pattern, as a regular expression means it literally. */
function literal(character) {
    return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A glob as a regular expression. `*` stops at a slash and `**` does not, which
 * is the whole of the difference between a name and a path in git's syntax;
 * `?` is one character of a name, and `[abc]` a choice of one.
 */
function translate(pattern) {
    let out = '';

    for (let i = 0; i < pattern.length; i++) {
        const character = pattern[i];

        if (character === '\\' && i + 1 < pattern.length) {
            out += literal(pattern[++i]); // an escaped character is that character
        } else if (character === '*') {
            if (pattern[i + 1] === '*') {
                i++;
                if (pattern[i + 1] === '/') {
                    i++;
                    out += '(?:.*/)?'; // `**/` is any number of folders, none included
                } else {
                    out += '.*';
                }
            } else {
                out += '[^/]*';
            }
        } else if (character === '?') {
            out += '[^/]';
        } else if (character === '[') {
            const close = pattern.indexOf(']', i + 1);
            if (close === -1) {
                out += '\\['; // an unclosed bracket is a bracket
            } else {
                const body = pattern.slice(i + 1, close);
                out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
                i = close;
            }
        } else {
            out += literal(character);
        }
    }

    return out;
}

/**
 * One line of the file as a rule, or null where the line is a comment, a blank,
 * or nothing at all once the syntax is taken off it.
 */
function compile(line) {
    let text = line.replace(/\s+$/, ''); // trailing spaces are not part of a name
    if (!text || text.startsWith('#')) return null;

    const negated = text.startsWith('!');
    if (negated) text = text.slice(1);
    text = text.replace(/^\\([!#])/, '$1'); // \! and \# are the characters themselves
    if (text.endsWith('/')) text = text.slice(0, -1); // everything here is a folder anyway

    // A slash anywhere ties the pattern to the watched folder; without one it is
    // a name, and a name matches at whatever depth it turns up.
    const anchored = text.includes('/');
    if (text.startsWith('/')) text = text.slice(1);
    if (!text) return null;

    return {
        negated,
        anchored,
        regex: new RegExp(`^${translate(text)}$`),
        // The pattern one folder at a time, for working out whether a `!` rule
        // has anything to say about what is inside a folder — see `reopens`.
        segments: text.split('/'),
    };
}

/**
 * Does this rule speak about this path? An anchored one is read against the
 * whole path and nothing else; an unanchored one against the path and every
 * tail of it, which is how `archive` reaches `work/old/archive`.
 */
function matches(rule, relPath) {
    if (rule.regex.test(relPath)) return true;
    if (rule.anchored) return false;

    let rest = relPath;
    for (let cut = rest.indexOf('/'); cut !== -1; cut = rest.indexOf('/')) {
        rest = rest.slice(cut + 1);
        if (rule.regex.test(rest)) return true;
    }
    return false;
}

/**
 * A `!` rule, read as a question about folders rather than about paths: is
 * there anything inside this folder it could still put back?
 *
 * git answers no to that question always — a folder it never walks into has
 * nothing in it to re-include — but `archive/` and then `!archive/gift` is what
 * anybody writes who wants all of an archive left out bar the one project they
 * still work on, and honouring it costs one folder walked.
 */
function opener(rule) {
    // A name with no slash in it matches at any depth, so it may turn up inside
    // anything; so may anything past a `**`.
    const anywhere = !rule.anchored || rule.segments.includes('**');
    return {
        anywhere,
        segments: anywhere ? [] : rule.segments.map((segment) => new RegExp(`^${translate(segment)}$`)),
    };
}

/** A matcher that lets everything through, for when there is no file to read. */
function nothing(file) {
    return { file, found: false, rules: 0, decide: () => null, reopens: () => false };
}

/**
 * The ignore file of a watched folder, compiled. `file` may be a name — read
 * inside the folder — or an absolute path; an empty one is nobody asking for
 * this at all.
 *
 * The default is a short list read in order — `.giftignore` first, then
 * `.gitignore` — so the file may be called either, and the first one that is
 * there wins. A name given outright is read as itself and nothing is tried in
 * its place.
 *
 * A file that is not there is not a mistake and not a warning: most folders
 * want every repository in them listed, and the feature is the file existing.
 *
 * @returns {Promise<{file: string, found: boolean, rules: number,
 *   decide: (relPath: string) => 'ignore' | 'keep' | null}>}
 *   `decide` gives the verdict of the last rule to speak about the path —
 *   `keep` where that rule was a `!` one — and null where none did.
 */
async function load(root, file = FILE) {
    const name = expandHome(String(file || '').trim());
    if (!name) return nothing('');

    const candidates = name === FILE ? DEFAULT_FILES : [name];

    let last = nothing(path.join(root, candidates[candidates.length - 1]));
    for (const candidate of candidates) {
        const loaded = await loadFile(root, candidate);
        if (loaded.found) return loaded;
        last = loaded;
    }
    return last;
}

/** Read and compile one ignore file, or `nothing` where it is not there. */
async function loadFile(root, name) {
    const target = path.isAbsolute(name) ? name : path.join(root, name);

    let text;
    try {
        text = await fsp.readFile(target, 'utf8');
    } catch {
        return nothing(target); // no file, or none that can be read
    }

    const rules = text.split(/\r?\n/).map(compile).filter(Boolean);
    if (rules.length === 0) return nothing(target);

    const openers = rules.filter((rule) => rule.negated).map(opener);

    return {
        file: target,
        found: true,
        rules: rules.length,
        // Last match wins, as it does in git: the order of the lines is the
        // order the answers are given in, so a `!` line puts back what a line
        // above it took away.
        decide(relPath) {
            let verdict = null;
            for (const rule of rules) {
                if (matches(rule, relPath)) verdict = rule.negated ? 'keep' : 'ignore';
            }
            return verdict;
        },

        /**
         * Is a folder that was ruled out still worth walking into, because a `!`
         * rule names something under it? Everything found in there stays unlisted
         * bar what that rule puts back.
         */
        reopens(relPath) {
            if (openers.length === 0) return false;

            const parts = relPath.split('/');
            return openers.some((each) => {
                if (each.anywhere) return true;
                // A rule no deeper than the folder itself has nothing inside it to say.
                if (each.segments.length <= parts.length) return false;
                return parts.every((part, index) => each.segments[index].test(part));
            });
        },
    };
}

module.exports = { FILE, load };
