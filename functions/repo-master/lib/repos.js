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
 * @returns {Promise<string[]>} Absolute repository roots, sorted.
 */
async function discover(root, maxDepth) {
    const found = [];

    async function walk(dir, depth) {
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable folder — nothing to report
        }

        if (entries.some((entry) => entry.name === '.git')) found.push(dir);
        if (depth >= maxDepth) return;

        for (const entry of entries) {
            if (!entry.isDirectory()) continue; // isDirectory() is false for a symlink
            if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
            await walk(path.join(dir, entry.name), depth + 1);
        }
    }

    await walk(root, 0);
    return found.sort();
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

module.exports = { discover, arrange };
