// What pressing enter does: go to the chosen repository's folder, or open it in
// an editor or an agent.
//
// A selection has a shape. The repository picked first is the main project, and
// the ones picked after it come along with it. VS Code opens the main project —
// a window is a window, and the extra repositories were not asked for. `claude`
// and `codex` are terminals themselves, so they borrow this one — the table
// steps aside and comes back when the tool exits — and the repositories after
// the first are handed to them as directories they may also work in.
//
// `goto folder` is the same borrowing, with a shell as the tool: no process can
// move the shell that started it, so the folder is reached by a shell of its own
// standing in it. Leaving that shell brings the table back.
'use strict';

const { spawn } = require('node:child_process');

/** The commands, and how each one wants to be started. */
function actions(env) {
    return [
        {
            id: 'folder',
            label: 'goto folder',
            // Someone's login shell is the one that knows their prompt and
            // aliases; `sh` is only there so the row still works without one.
            command: env.GIFT_REPO_MASTER_SHELL || env.SHELL || 'sh',
            kind: 'terminal',
        },
        {
            id: 'vscode',
            label: 'open with vscode',
            command: env.GIFT_REPO_MASTER_VSCODE || 'code',
            kind: 'windowed',
        },
        {
            id: 'claude',
            label: 'open with claude code',
            command: env.GIFT_REPO_MASTER_CLAUDE || 'claude',
            kind: 'terminal',
            addDir: env.GIFT_REPO_MASTER_CLAUDE_ADD_DIR ?? '--add-dir',
        },
        {
            id: 'codex',
            label: 'open with codex',
            command: env.GIFT_REPO_MASTER_CODEX || 'codex',
            kind: 'terminal',
            addDir: env.GIFT_REPO_MASTER_CODEX_ADD_DIR ?? '--add-dir',
        },
    ];
}

/**
 * How to tell a tool about the repositories after the main one: the flag once
 * per directory, which both a repeatable and a variadic option accept. An empty
 * `addDir` means this tool cannot be told, and they are left out.
 */
function addDirArgs(action, repos) {
    if (!action.addDir) return [];
    return repos.flatMap((repo) => [action.addDir, repo.dir]);
}

/** Launch and forget: the program opens its own window. */
function launch(command, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
        child.on('error', (error) => {
            resolve(error.code === 'ENOENT' ? `${command}: not found in PATH` : `${command}: ${error.message}`);
        });
        child.on('spawn', () => {
            child.unref();
            resolve(null);
        });
    });
}

/** Run in this terminal and wait for it to finish. The caller hides the table first. */
function runHere(command, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit' });
        child.on('error', (error) => {
            resolve(error.code === 'ENOENT' ? `${command}: not found in PATH` : `${command}: ${error.message}`);
        });
        child.on('close', () => resolve(null));
    });
}

/**
 * Run one action against the chosen repositories.
 *
 * @param {object} action One of actions().
 * @param {object[]} repos Rows to act on, main project first.
 * @param {object} hooks
 * @param {() => void} hooks.suspend Hide the table; the terminal is about to be borrowed.
 * @param {() => void} hooks.resume Bring it back.
 * @returns {Promise<string|null>} A message to show, or null when there is nothing to say.
 */
async function run(action, repos, { suspend, resume }) {
    const [main, ...extra] = repos;
    if (!main) return null;

    if (action.kind === 'windowed') {
        const error = await launch(action.command, [main.dir], main.dir);
        if (error) return error;
        // Name the others' absence, so a window holding one repository out of
        // three does not look like the other two failed to open.
        return extra.length === 0
            ? `${action.label}: ${main.name}`
            : `${action.label}: ${main.name} (main of ${repos.length})`;
    }

    suspend();
    try {
        return await runHere(action.command, addDirArgs(action, extra), main.dir);
    } finally {
        resume();
    }
}

module.exports = { actions, run, addDirArgs };
