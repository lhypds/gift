// Minimal .env loader (no dependencies). Values already present in the real
// environment always win, so `GIFT_REPOS=... gift list-weekly-prs` overrides
// the file.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../functions.js');

function parse(text) {
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eq = withoutExport.indexOf('=');
        if (eq <= 0) continue;

        const key = withoutExport.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        let value = withoutExport.slice(eq + 1).trim();
        const quoted =
            (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
            (value.startsWith("'") && value.endsWith("'") && value.length > 1);
        if (quoted) {
            value = value.slice(1, -1);
        } else {
            const hash = value.indexOf(' #');
            if (hash >= 0) value = value.slice(0, hash).trim(); // trailing comment
        }
        values[key] = value;
    }
    return values;
}

/** Load one .env file into process.env without overwriting existing variables. */
function load(file = path.join(ROOT, '.env')) {
    if (!fs.existsSync(file)) return {};

    let values;
    try {
        values = parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }

    for (const [key, value] of Object.entries(values)) {
        if (process.env[key] === undefined) process.env[key] = value;
    }
    return values;
}

/**
 * Load the configuration for one run: the function's own `.env` first, then the
 * shared one at ROOT. Neither overwrites a variable that is already set, so
 * precedence reads real environment > functions/<name>/.env > ROOT/.env.
 *
 * Settings only one function reads belong in that function's folder; ROOT/.env
 * is for what is shared, or for a value the user wants to apply everywhere.
 *
 * @param {string} [functionDir] Folder of the function about to run, if any.
 */
function loadFor(functionDir) {
    const own = functionDir ? load(path.join(functionDir, '.env')) : {};
    const shared = load();
    return { ...shared, ...own };
}

module.exports = { loadFor };
