// `gift config` — open config.json in an editor.
//
// There is one file and it is readable, so there is nothing here worth wrapping
// in a menu: the command creates it if it is not there yet, hands it to $EDITOR,
// and checks on the way out that what came back is still JSON.
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const config = require('../utils/config.js');

/** Editors to fall back on, in the order they are worth trying. */
const FALLBACK_EDITORS = ['vi', 'nano'];

function usage() {
    console.log(`Usage: gift config [--path]

Open gift's configuration in $EDITOR. Everything lives in one file:

    ${config.file()}

gift's own settings are at the top level and each function's are under
functions.<name>:

    {
        "github_webhook_secret": "...",
        "port": 3999,
        "functions": {
            "repo-master": { "repo_root": "/Users/me/projects" }
        }
    }

The file is created the first time with every setting the functions declare, at
its default, so there is a list to work from rather than a blank page. It is
git-ignored and written 0600 — it holds the webhook secret.

  --path    Print the path and exit, without opening anything

A value already in the environment wins over the file, so \`GIFT_REPOS=... gift
list-weekly-prs\` still overrides what is configured.`);
}

/** $VISUAL, then $EDITOR, then whichever plain editor is actually installed. */
function chooseEditor() {
    const named = process.env.VISUAL || process.env.EDITOR;
    if (named) return { command: named, shell: true };

    for (const candidate of FALLBACK_EDITORS) {
        const found = spawnSyncQuiet(candidate);
        if (found) return { command: candidate, shell: false };
    }
    return null;
}

function spawnSyncQuiet(command) {
    const { spawnSync } = require('node:child_process');
    const probe = spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' });
    return probe.status === 0;
}

function open(editor, file) {
    return new Promise((resolve) => {
        const child = spawn(editor.command, [file], { stdio: 'inherit', shell: editor.shell });
        child.on('error', (error) => {
            console.error(`gift config: ${editor.command}: ${error.message}`);
            resolve(1);
        });
        child.on('close', (code) => resolve(code === null ? 1 : code));
    });
}

/** Say so if the editor was closed on something that will not parse. */
function check(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        console.error(`gift config: ${file} could not be read back: ${error.message}`);
        return 1;
    }

    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.error(`gift config: ${file} has to hold a JSON object — gift will ignore it as it is.`);
            return 1;
        }
    } catch (error) {
        console.error(`gift config: ${file} is not valid JSON (${error.message}).`);
        console.error('gift will ignore the file until it parses — run `gift config` again to fix it.');
        return 1;
    }
    return 0;
}

async function main(argv) {
    if (argv.includes('-h') || argv.includes('--help')) {
        usage();
        return 0;
    }

    // Asking where the file is should not bring it into being.
    if (argv.includes('--path')) {
        console.log(config.file());
        return 0;
    }

    const unknown = argv.find((argument) => argument.startsWith('-'));
    if (unknown) {
        console.error(`gift config: unknown option ${unknown}`);
        usage();
        return 2;
    }

    const { file, created } = config.ensure();
    if (created) console.log(`Created ${file}`);

    const editor = chooseEditor();
    if (!editor) {
        console.error('gift config: no editor to open it with — set $EDITOR.');
        console.log(file);
        return 2;
    }

    const code = await open(editor, file);
    if (code !== 0) return code;

    return check(file);
}

module.exports = { main, usage };
