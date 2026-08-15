// The VERSION file is the only place the release number lives. package.json
// deliberately carries no "version" field: gift ships as a GitHub release zip
// rather than an npm package, so a second copy would only ever drift.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../functions.js');

function version() {
    try {
        const value = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
        if (value) return value;
    } catch {
        /* an unreadable VERSION falls back to the placeholder below */
    }
    return '0.0.0';
}

module.exports = { version };
