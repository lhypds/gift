// Command discovery. Every folder in commands/ that holds an entry script is a
// `gift` command, and the folder name is the command name.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands');

/**
 * Entry script names accepted inside a command folder, most specific first.
 * Folder names are hyphenated; some scripts spell theirs with underscores
 * (`list-weekly-prs/list_weekly_prs.sh`), so both spellings are accepted.
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

/** All command folders in commands/, sorted by name. */
function list() {
    let entries;
    try {
        entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true });
    } catch {
        return []; // no commands/ folder at all
    }

    const commands = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const dir = path.join(COMMANDS_DIR, entry.name);
        const script = findEntry(dir, entry.name);
        if (!script) continue;

        commands.push({
            name: entry.name,
            dir,
            entry: script,
            description: readDescription(dir),
        });
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a token typed by the user to a command. An exact folder name wins;
 * otherwise any unique prefix does, so `gift list` runs `list-weekly-prs`.
 *
 * @returns {{status: 'ok', command: object}
 *          | {status: 'unknown'}
 *          | {status: 'ambiguous', matches: object[]}}
 */
function resolve(token) {
    const commands = list();

    const exact = commands.find((c) => c.name === token);
    if (exact) return { status: 'ok', command: exact };

    const matches = commands.filter((c) => c.name.startsWith(token));
    if (matches.length === 1) return { status: 'ok', command: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    return { status: 'unknown' };
}

module.exports = { ROOT, COMMANDS_DIR, list, resolve, readDescription };
