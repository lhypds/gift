// Finding the repositories under one folder, and working out which of them sit
// inside which. A submodule and a repository that merely happens to live in
// another repository's folder look the same from here — both hold a .git entry,
// and both get their own indented row.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Folders never worth walking into. Build output and dependency trees hold no
 * repositories of the user's own, and are where a recursive scan goes to die.
 */
const SKIP = new Set([
    'node_modules',
    'bower_components',
    'vendor',
    'dist',
    'build',
    'out',
    'target',
    'coverage',
    'venv',
    '__pycache__',
    'Pods',
    'DerivedData',
]);

/**
 * Every folder holding a .git entry under `root`, deepest ones included: the
 * scan does not stop at the first repository it finds, because submodules and
 * nested checkouts are the whole point.
 *
 * Symlinked folders are left alone — following them invites a cycle.
 *
 * `ignores` is the watched folder's ignore file, compiled — see lib/ignore.js.
 * A folder it rules out is not walked into and never becomes a row, and neither
 * does anything inside it: a folder left out takes its repositories with it. It
 * may also let one of the folders below back in, for the odd checkout kept
 * inside a `vendor` or a `build`.
 *
 * @returns {Promise<{dirs: string[], ignored: number}>} Absolute repository
 *   roots, sorted, and how many folders the ignore file left out — which the
 *   header says, so the table never quietly claims to be the whole folder.
 */
async function discover(root, maxDepth, ignores = null) {
    const found = [];
    let ignored = 0;

    // `hidden` is a folder the ignore file ruled out, walked into all the same
    // because a `!` rule names something under it. Nothing in there is a row
    // until that rule speaks: the folder was left out, and one project being
    // asked for back does not ask for its neighbours.
    async function walk(dir, depth, hidden) {
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable folder — nothing to report
        }

        if (!hidden && entries.some((entry) => entry.name === '.git')) found.push(dir);
        if (depth >= maxDepth) return;

        for (const entry of entries) {
            if (!entry.isDirectory()) continue; // isDirectory() is false for a symlink
            if (entry.name.startsWith('.')) continue;

            const child = path.join(dir, entry.name);
            const relative = path.relative(root, child).split(path.sep).join('/');
            const verdict = ignores ? ignores.decide(relative) : null;

            if (verdict === 'ignore') {
                ignored++;
                if (ignores.reopens(relative)) await walk(child, depth + 1, true);
                continue;
            }
            if (SKIP.has(entry.name) && verdict !== 'keep') continue;

            // A `!` rule puts the folder back on its own terms: it is a row
            // again, and so is whatever it holds.
            if (hidden && verdict !== 'keep') {
                if (ignores.reopens(relative)) await walk(child, depth + 1, true);
                continue;
            }

            await walk(child, depth + 1, false);
        }
    }

    await walk(root, 0, false);
    return { dirs: found.sort(), ignored };
}

/** Is `child` inside `parent`? */
function isInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Arrange discovered repositories into the order the table prints them:
 * top-level repositories alphabetically, each followed by whatever lives
 * inside it, indented one level per step.
 *
 * @returns {Array<{dir: string, relPath: string, depth: number, nested: string[]}>}
 *   `nested` holds the children's absolute paths, so a parent can leave their
 *   changes to their own rows.
 */
function arrange(root, dirs) {
    const parentOf = new Map();
    for (const dir of dirs) {
        // The innermost repository containing this one is its parent.
        let parent = null;
        for (const other of dirs) {
            if (other === dir || !isInside(other, dir)) continue;
            if (!parent || other.length > parent.length) parent = other;
        }
        parentOf.set(dir, parent);
    }

    const childrenOf = new Map(dirs.map((dir) => [dir, []]));
    const roots = [];
    for (const dir of dirs) {
        const parent = parentOf.get(dir);
        if (parent) childrenOf.get(parent).push(dir);
        else roots.push(dir);
    }

    const rows = [];
    const walk = (dir, depth) => {
        const relative = path.relative(root, dir);
        rows.push({
            dir,
            relPath: relative === '' ? '.' : `./${relative}`,
            depth,
            nested: childrenOf.get(dir),
        });
        for (const child of childrenOf.get(dir).sort()) walk(child, depth + 1);
    };
    for (const dir of roots.sort()) walk(dir, 0);

    return rows;
}

/**
 * The rows a search leaves showing: the ones whose name, path or branch holds
 * the query, upper and lower case alike. A folder of fifty repositories is a
 * list nobody reads, and a few letters is the quickest way back to the three
 * that were meant.
 *
 * An empty query is not a search, and gives back the same array rather than a
 * copy of it.
 *
 * @param {object[]} rows
 * @param {string} query
 */
function filter(rows, query) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return rows;

    return rows.filter((row) =>
        [row.name, row.relPath, row.branch].some((field) => String(field || '').toLowerCase().includes(text)),
    );
}

module.exports = { discover, arrange, filter };
