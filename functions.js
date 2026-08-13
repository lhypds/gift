// Function discovery. Every folder in functions/ that holds an entry script is a
// `gift` function, and the folder name is the function name.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

/**
 * Entry script names accepted inside a function folder, most specific first.
 * Folder names are hyphenated; a script may spell its own name with underscores
 * (`weekly-prs/weekly_prs.sh`), so both spellings are accepted.
 */
function entryCandidates(name) {
    const underscored = name.replace(/-/g, '_');
    const hyphenated = name.replace(/_/g, '-');
    const names = [
        'main.sh',
        'main.js',
        `${name}.sh`,
        `${name}.js`,
        `${underscored}.sh`,
        `${underscored}.js`,
        `${hyphenated}.sh`,
        `${hyphenated}.js`,
    ];
    return [...new Set(names)];
}

function findEntry(dir, name) {
    for (const candidate of entryCandidates(name)) {
        const entry = path.join(dir, candidate);
        if (fs.existsSync(entry) && fs.statSync(entry).isFile()) return entry;
    }

    // Fall back to a lone shell script in the folder.
    const shells = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.sh'))
        .map((e) => e.name);
    if (shells.length === 1) return path.join(dir, shells[0]);

    return null;
}

/**
 * One-line summary for `gift help`, taken from the folder's README: the first
 * line of prose after the title and its underline.
 */
function readDescription(dir) {
    for (const file of ['README.txt', 'README.md']) {
        const readme = path.join(dir, file);
        if (!fs.existsSync(readme)) continue;

        let lines;
        try {
            lines = fs.readFileSync(readme, 'utf8').split(/\r?\n/);
        } catch {
            continue;
        }

        const filled = lines.map((l) => l.trim()).filter(Boolean);
        for (let i = 1; i < filled.length; i++) {
            const line = filled[i];
            if (/^[=~^*#-]{3,}$/.test(line)) continue; // title underline
            if (line.startsWith('#')) continue; // markdown heading
            return line;
        }
    }
    return '';
}

/**
 * Functions that come before the rest, in this order, wherever the list is
 * printed: `gift help`, the `gift run` menu, `gift config`. Everything else
 * follows alphabetically. A name in here that no longer names a folder is
 * simply not found, and costs nothing.
 */
const FIRST = ['repo-master'];

/** All function folders in functions/, the featured ones first and the rest by name. */
function list() {
    let entries;
    try {
        entries = fs.readdirSync(FUNCTIONS_DIR, { withFileTypes: true });
    } catch {
        return []; // no functions/ folder at all
    }

    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const dir = path.join(FUNCTIONS_DIR, entry.name);
        const script = findEntry(dir, entry.name);
        if (!script) continue;

        found.push({
            name: entry.name,
            dir,
            entry: script,
            description: readDescription(dir),
        });
    }
    // Unlisted names sort after every listed one, and against each other by name.
    const rank = (name) => (FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
    return found.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

module.exports = { ROOT, list };
