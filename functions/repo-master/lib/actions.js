// What pressing enter does: go to the chosen repository's folder, open it in an
// editor or an agent, or commit and push the lot.
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
// standing in it. That one is asked for in order to be somewhere else, and it is
// the last thing repo-master does: leaving the shell leaves the table too,
// rather than putting it back up in front of somebody on their way out.
//
// `commit & push` is the exception to all of it: every chosen repository is a
// project of its own there, each committed with the same message and pushed,
// and nothing borrows the terminal — git is asked directly, and the table stays
// up to report on it. It runs through commit() below rather than run(), because
// it wants a message first.
'use strict';

const { spawn } = require('node:child_process');

const gitLib = require('./git.js');
const { limiter } = require('./util.js');

/** How many repositories are committed and pushed at once. */
const COMMIT_CONCURRENCY = 4;

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
            // Somewhere else is the whole point, so there is nothing to come
            // back to: leaving this shell ends the session. The tools below keep
            // the table, because opening one is a thing you do between looks at
            // it rather than instead of them.
            last: true,
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
        {
            id: 'commit',
            label: 'commit & push',
            kind: 'commit',
            // Nothing is committed until there is something to call it: the
            // message is asked for in a box of its own first.
            prompt: {
                title: 'Commit message',
                footer: 'enter commit & push · esc back',
            },
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
 * @param {() => void} hooks.resume Bring it back — a no-op for a `last` action,
 *   which the caller ends the session on rather than returning to the table.
 * @returns {Promise<string|null>} A message to show, or null when there is nothing to say.
 */
async function run(action, repos, { suspend, resume }) {
    const [main, ...extra] = repos;
    if (!main) return null;
    if (action.kind === 'commit') return 'commit & push is run with a message — see commit()';

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

/**
 * Commit and push every chosen repository, with the one message between them.
 *
 * Each repository stands on its own here, rather than one leading and the rest
 * following: a commit belongs to a repository, and there is no main project to
 * make of the others. They are worked on a few at a time, because a push is
 * mostly waiting on a network, and a repository that fails takes none of the
 * rest down with it.
 *
 * @param {object[]} repos Rows to commit.
 * @param {string} message The commit message.
 * @param {(update: {repo: object, state: string, text: string}) => void} [onUpdate]
 *   Called as each repository moves — 'working', then 'done', 'skipped' or 'failed'.
 * @returns {Promise<Array<{repo: object, state: string, text: string}>>} The last
 *   word on each repository, in the order they were given.
 */
async function commit(repos, message, onUpdate = () => {}) {
    const gate = limiter(COMMIT_CONCURRENCY);

    return Promise.all(
        repos.map((repo) =>
            gate(async () => {
                const say = (state, text) => {
                    const update = { repo, state, text };
                    onUpdate(update);
                    return update;
                };

                say('working', 'starting…');
                let result;
                try {
                    result = await gitLib.commitAndPush(repo.dir, message, repo.nested, (step) =>
                        say('working', `${step}…`),
                    );
                } catch (failure) {
                    result = { ok: false, committed: false, text: failure.message || String(failure) };
                }

                const state = !result.ok ? 'failed' : result.committed ? 'done' : 'skipped';
                return say(state, result.text);
            }),
        ),
    );
}

module.exports = { actions, run, commit, addDirArgs };
