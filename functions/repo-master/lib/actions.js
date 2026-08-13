// Everything the table can do to the repositories it is showing: open them
// somewhere, read them, reach their remote, branch them, commit them, or throw
// them away.
//
// There is one list of them and one place to see it — the menu enter opens. The
// commands worth reaching for without it carry a `key`, which the table binds
// and the menu prints beside the row, so the same command is the same command
// however it was started and nobody has to learn two of anything.
//
// A selection has a shape. The repository picked first is the main project, and
// the ones picked after it come along with it. The editor opens the main project
// — a window is a window, and the extra repositories were not asked for.
// `claude` and `codex` are terminals themselves, so they borrow this one — the
// table steps aside and comes back when the tool exits — and the repositories
// after the first are handed to them as directories they may also work in.
//
// `goto folder` is the same borrowing, with a shell as the tool: no process can
// move the shell that started it, so the folder is reached by a shell of its own
// standing in it. That one is asked for in order to be somewhere else, and it is
// the last thing repo-master does: leaving the shell leaves the table too,
// rather than putting it back up in front of somebody on their way out.
//
// The rest borrow nothing. Fetching, pulling, committing, adding a worktree and
// deleting a folder are all the table's own work, done to every repository
// picked with git or the filesystem asked directly, and reported on in a box
// while the table stays up. Each is a repository of its own there rather than
// one leading and the rest following — a commit belongs to a repository, and so
// does a branch — which is why they run through the sweeps below rather than
// through run().
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const gitLib = require('./git.js');
const { limiter } = require('./util.js');

/** How many repositories are worked on at once, where the work waits on a network. */
const REMOTE_CONCURRENCY = 4;

/** The two ways of reaching a remote, behind the f and p keys. */
const SYNC = {
    fetch: { label: 'fetch', busy: 'fetching…' },
    pull: { label: 'pull', busy: 'pulling…' },
};

/**
 * Where a repository's new worktree goes: beside the repository itself, named
 * for it and the branch. A folder of projects is what repo-master watches, so a
 * worktree put there is a row of its own by the next scan — which is the point
 * of making one.
 */
function worktreePath(dir, branch) {
    const slug = branch.replace(/[\\/\s]+/g, '-').replace(/^[.-]+/, '');
    return path.join(path.dirname(dir), `${path.basename(dir)}-${slug || 'worktree'}`);
}

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
            id: 'code',
            key: 'e',
            label: 'open with code',
            // `code` is only the usual answer: cursor, windsurf and the rest take
            // a folder the same way, which is why the setting is not named after
            // any of them. GIFT_REPO_MASTER_VSCODE is what it used to be called.
            command: env.GIFT_REPO_MASTER_CODE || env.GIFT_REPO_MASTER_VSCODE || 'code',
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
            id: 'diff',
            key: 'd',
            label: 'diff',
            kind: 'diff',
        },
        {
            id: 'fetch',
            key: 'f',
            label: 'fetch',
            kind: 'sync',
            sync: 'fetch',
        },
        {
            id: 'pull',
            key: 'p',
            label: 'pull',
            kind: 'sync',
            sync: 'pull',
        },
        {
            id: 'worktree',
            key: 't a',
            label: 'worktree add',
            kind: 'worktree',
            // A worktree is a branch and a folder, and only one of them has to be
            // asked for: the folder is worked out from the branch.
            prompt: {
                title: 'Worktree add',
                footer: 'enter add · esc back',
                empty: 'a branch name first',
            },
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
                empty: 'a message first',
            },
        },
        {
            id: 'delete',
            key: 'D',
            label: 'delete repo folder',
            kind: 'delete',
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
 * Run one job per repository, a few at a time, saying how each is getting on as
 * it goes. Nothing one repository does — refusing, failing, throwing — is
 * allowed to take the others down with it, and the answers come back in the
 * order the repositories were given rather than the order they finished in.
 *
 * @param {object[]} repos
 * @param {(update: {repo: object, state: string, text: string}) => void} onUpdate
 * @param {(repo: object, say: Function) => Promise<object>} work Does one
 *   repository, and returns the `say()` that had the last word on it.
 */
function sweep(repos, onUpdate, work) {
    const gate = limiter(REMOTE_CONCURRENCY);

    return Promise.all(
        repos.map((repo) =>
            gate(async () => {
                const say = (state, text) => {
                    const update = { repo, state, text };
                    onUpdate(update);
                    return update;
                };

                say('working', 'starting…');
                try {
                    return await work(repo, say);
                } catch (failure) {
                    return say('failed', failure.message || String(failure));
                }
            }),
        ),
    );
}

/**
 * Fetch every chosen repository, or pull every one of them.
 *
 * @param {object[]} repos Rows to bring up to date.
 * @param {'fetch'|'pull'} kind
 * @param {(update: {repo: object, state: string, text: string}) => void} [onUpdate]
 * @returns {Promise<Array<{repo: object, state: string, text: string}>>}
 */
async function sync(repos, kind, onUpdate = () => {}) {
    return sweep(repos, onUpdate, async (repo, say) => {
        say('working', SYNC[kind].busy);
        const result = await gitLib.sync(repo.dir, kind === 'pull');
        return say(!result.ok ? 'failed' : result.changed ? 'done' : 'skipped', result.text);
    });
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
    return sweep(repos, onUpdate, async (repo, say) => {
        const result = await gitLib.commitAndPush(repo.dir, message, repo.nested, (step) => say('working', `${step}…`));
        return say(!result.ok ? 'failed' : result.committed ? 'done' : 'skipped', result.text);
    });
}

/**
 * Add a worktree to every chosen repository, all of them on the one branch.
 *
 * Each repository stands on its own, as it does for a commit: a branch belongs
 * to a repository, and one repository's `feature-x` is nothing to another's. The
 * folder each one gets is worked out from its own name.
 *
 * @param {object[]} repos Rows to branch.
 * @param {string} branch The branch to check out in the new worktree.
 * @param {(update: {repo: object, state: string, text: string}) => void} [onUpdate]
 * @returns {Promise<Array<{repo: object, state: string, text: string}>>}
 */
async function worktrees(repos, branch, onUpdate = () => {}) {
    return sweep(repos, onUpdate, async (repo, say) => {
        say('working', 'adding…');
        const result = await gitLib.addWorktree(repo.dir, branch, worktreePath(repo.dir, branch));
        return say(result.ok ? 'done' : 'failed', result.text);
    });
}

/**
 * Delete every chosen repository's folder, and everything in it.
 *
 * This is the one command with nothing to undo it, which is why the table asks
 * before it gets here. What it deletes is a folder and not a repository: a
 * repository living inside another goes with its parent, because it is inside
 * the folder being removed, and the caller says so before asking.
 *
 * @param {object[]} repos Rows to delete.
 * @param {(update: {repo: object, state: string, text: string}) => void} [onUpdate]
 * @returns {Promise<Array<{repo: object, state: string, text: string}>>}
 */
async function remove(repos, onUpdate = () => {}) {
    return sweep(repos, onUpdate, async (repo, say) => {
        // A folder already gone is not a failure: something else deleted it, and
        // the row was on its way out at the next scan anyway.
        try {
            await fsp.stat(repo.dir);
        } catch {
            return say('skipped', 'gone already');
        }

        say('working', 'deleting…');
        await fsp.rm(repo.dir, { recursive: true, force: true });
        return say('done', `deleted ${repo.relPath}`);
    });
}

module.exports = { actions, run, commit, sync, worktrees, worktreePath, remove, addDirArgs, SYNC };
