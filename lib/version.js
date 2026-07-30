// The VERSION file is the single source of truth; package.json mirrors it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('./commands.js');

function version() {
    try {
        const value = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
        if (value) return value;
    } catch {
        /* fall through to package.json */
    }
    try {
        return require(path.join(ROOT, 'package.json')).version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

module.exports = { version };
