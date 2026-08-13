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
// `vim`, `claude` and `codex` are terminals themselves, so they borrow this one —
// the table steps aside and comes back when the tool exits — and the repositories
// after the first are handed to `claude` and `codex` as directories they may also
// work in.
//
// `vim` is handed a file instead, and the file is asked for: a repository opened
// in vim is a file in it being opened, and fzf names one in the borrowed terminal
// before vim starts. Nothing picked opens nothing, and no fzf to pick with opens
// the folder.
//
// `goto folder` is the same borrowing, with a shell as the tool: no process can
// move the shell that started it, so the folder is reached by a shell of its own
// standing in it. That one is asked for in order to be somewhere else, and it is
// the last thing repo-master does: leaving the shell leaves the table too,
// rather than putting it back up in front of somebody on their way out.
//
// The rest borrow nothing. Fetching, pulling, pushing, committing, stashing,
// discarding, adding a worktree and deleting a folder are all the table's own
// work, done to every repository picked with git or the filesystem asked
// directly, and reported on in a box while the table stays up. Each is a
// repository of its own there rather than one leading and the rest following — a
// commit belongs to a repository, and so does a branch — which is why they run
// through the sweeps below rather than through run().
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const gitLib = require('./git.js');
const { limiter } = require('./util.js');

/** How many repositories are worked on at once, where the work waits on a network. */
const REMOTE_CONCURRENCY = 4;

/**
 * The three ways of reaching a remote, behind the f, p and P keys, and how each
 * one's outcome is counted up afterwards.
 */
const SYNC = {
    fetch: { label: 'fetch', busy: 'fetching…', words: { done: 'with new commits', skipped: 'up to date' } },
    pull: { label: 'pull', busy: 'pulling…', words: { done: 'updated', skipped: 'already up to date' } },
    push: { label: 'push', busy: 'pushing…', words: { done: 'pushed', skipped: 'nothing to push' } },
};

/**
 * The two ways of emptying a working tree, behind the s and u keys. They are the
 * same command in every way but the one that matters: a stash keeps what it takes
 * and a discard does not, which is why the box asking about the second is drawn
 * the way the delete box is.
 */
const CLEAR = {
    stash: { label: 'stash', busy: 'stashing…', words: { done: 'stashed', skipped: 'nothing to stash' } },
    discard: {
        label: 'discard changes',
        busy: 'discarding…',
        words: { done: 'discarded', skipped: 'nothing to discard' },
    },
};

/**
 * What the file picker offers, and what it shows of whatever the cursor is on.
 * Both are shell lines rather than programs, because both are a first choice with
 * something behind it: `sh` runs them, so `||` reaches the next answer when the
 * one in front is not installed. `fdfind` and `batcat` are the same two programs
 * under the names Debian gives them, and are tried before giving up on them.
 *
 * fd is asked for the list because it reads `.gitignore` on the way down: what
 * comes back is the repository's own files, without node_modules or a build
 * folder in front of them. Hidden files are asked for — a repository's `.github`
 * and `.gitignore` are files somebody opens — and `.git` itself is not, having
 * nothing in it anybody edits. Where fd is missing, git is asked instead: it
 * knows the same list, minus what nobody has added yet, and it is already here.
 *
 * bat is the preview because a file worth opening is worth recognising first: the
 * colours it would have in an editor, and numbered lines to say where you are.
 * Where it is missing, cat still answers the question a preview asks — is this
 * the file — which is most of what the window is for.
 */
const FD_LIST = '--type f --hidden --exclude .git';
const FILE_LIST = `fd ${FD_LIST} 2>/dev/null || fdfind ${FD_LIST} 2>/dev/null || git ls-files --cached --others --exclude-standard`;
const BAT_VIEW = '--color=always --style=numbers --line-range :500';
const FILE_PREVIEW = `bat ${BAT_VIEW} {} 2>/dev/null || batcat ${BAT_VIEW} {} 2>/dev/null || cat {}`;

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
    // Named once, because the picker in front of it wears the name too: the line
    // you type the filename on says which tool is about to open it.
    const vim = env.GIFT_REPO_MASTER_VIM || 'vim';

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
            id: 'vim',
            key: 'v',
            label: 'open with vim',
            command: vim,
            kind: 'terminal',
            // What somebody opening a repository in vim is after is a file in it,
            // so which file is asked before vim starts rather than looked for
            // afterwards: fzf takes the terminal first, and vim opens what it
            // prints. Backing out of the question opens nothing — the file was
            // the command, and there is no file.
            pick: {
                command: env.GIFT_REPO_MASTER_FZF || 'fzf',
                args: [
                    // The prompt says which tool the name being typed is for, so a
                    // list of files arriving over the table reads as the beginning
                    // of opening one rather than as something of its own.
                    '--prompt',
                    `${vim} `,
                    // And the file itself beside the list, so a name half typed can
                    // be checked against what it turned out to mean before it is
                    // opened. See FILE_PREVIEW.
                    '--preview',
                    FILE_PREVIEW,
                ],
                // What there is to pick from, for whoever has not already said:
                // FZF_DEFAULT_COMMAND is somebody's own answer to the same question
                // and is left alone where they have given one. See FILE_LIST.
                env: { FZF_DEFAULT_COMMAND: env.FZF_DEFAULT_COMMAND || FILE_LIST },
            },
            // Where there is no picker to ask, the folder is the answer vim can
            // still be handed: it opens as a list of what is in it, which is the
            // same question asked the slow way. Vim with no argument at all would
            // open an empty buffer, and the repository is what was asked for.
            args: ['.'],
        },
        {
            id: 'claude',
            key: 'c',
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
        // The number keys in the menu reach nine rows, and these are the last
        // five: every one of them carries a key of its own, so being past the
        // ninth costs them nothing, while `commit & push` above has no other way
        // in. That is what keeps `push` below it rather than beside `pull`, where
        // it belongs — and it reads well enough there: commit and push, or push
        // what was committed elsewhere.
        {
            id: 'push',
            key: 'P',
            label: 'push',
            kind: 'sync',
            sync: 'push',
        },
        {
            id: 'stash',
            key: 's',
            label: 'stash',
            kind: 'clear',
            clear: 'stash',
        },
        {
            id: 'discard',
            key: 'u',
            label: 'discard changes',
            kind: 'clear',
            clear: 'discard',
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

/**
 * Ask which file, in the terminal the table has just stepped out of, and hand
 * back what was picked.
 *
 * The picker draws on the terminal and prints its answer, so the terminal is
 * given to it for reading keys and drawing with while its output is kept here to
 * be read — the shape `vim $(fzf)` has in a shell, and the reason fzf puts its
 * interface on /dev/tty when what it prints is going somewhere other than the
 * screen.
 *
 * Nothing printed means nothing was picked: esc, ctrl-c, or a list narrowed down
 * to no matches. That is an answer and not a failure, which is why it is told
 * apart from the picker not being installed at all — the command has something to
 * fall back on for the second and nothing to open for the first.
 *
 * @param {{command: string, args?: string[], env?: object}} picker
 * @param {string} cwd The main project's folder — what the list is a list of.
 * @returns {Promise<{paths: string[], error: string|null}>}
 */
function choose(picker, cwd) {
    return new Promise((resolve) => {
        const child = spawn(picker.command, picker.args || [], {
            cwd,
            stdio: ['inherit', 'pipe', 'inherit'],
            env: { ...process.env, ...picker.env },
        });

        let printed = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            printed += chunk;
        });
        child.on('error', (error) =>
            resolve({
                paths: [],
                error:
                    error.code === 'ENOENT'
                        ? `${picker.command}: not found in PATH`
                        : `${picker.command}: ${error.message}`,
            }),
        );
        // A line each, and every line a path as the picker was given it — relative
        // to the folder the tool is about to be started in, which is the same
        // folder the list was made in. More than one line is a picker told it may
        // pick more than one thing, and the tool is handed all of them.
        child.on('close', () => resolve({ paths: printed.split(/\r?\n/).filter(Boolean), error: null }));
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
        // A command that asks something first asks it here, with the table already
        // out of the way: the picker and the tool want the same terminal, one
        // after the other, and the table would be redrawn between them for nobody
        // to look at.
        let args = action.args || [];
        let picked = null;
        if (action.pick) {
            picked = await choose(action.pick, main.dir);
            if (!picked.error) {
                if (picked.paths.length === 0) return null;
                args = picked.paths;
            }
        }

        const failure = await runHere(action.command, [...args, ...addDirArgs(action, extra)], main.dir);
        // A missing picker is said once, when the tool it was asked for closes and
        // there is a table to say it on: what opened was the folder rather than the
        // file, and the difference is worth a line.
        return failure || picked?.error || null;
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
 * Reach every chosen repository's remote: hear what is there, take it, or hand
 * over what this machine has been keeping.
 *
 * @param {object[]} repos Rows to reach a remote for.
 * @param {'fetch'|'pull'|'push'} kind
 * @param {(update: {repo: object, state: string, text: string}) => void} [onUpdate]
 * @returns {Promise<Array<{repo: object, state: string, text: string}>>}
 */
async function sync(repos, kind, onUpdate = () => {}) {
    return sweep(repos, onUpdate, async (repo, say) => {
        say('working', SYNC[kind].busy);
        // Fetching and pulling are one call with a flag between them; pushing is
        // the other direction and a function of its own.
        const result = kind === 'push' ? await gitLib.push(repo.dir) : await gitLib.sync(repo.dir, kind === 'pull');
        return say(!result.ok ? 'failed' : result.changed ? 'done' : 'skipped', result.text);
    });
}

/**
 * Empty every chosen repository's working tree: put the changes aside where they
 * can be had back, or throw them away where they cannot.
 *
 * Each repository stands on its own, as it does for a commit — what changed in
 * one is nothing to another — and a repository with nothing in it to clear is
 * skipped rather than failed.
 *
 * @param {object[]} repos Rows to clear.
 * @param {'stash'|'discard'} kind Which of the two, and the only difference: one
 *   keeps what it takes.
 * @param {(update: {repo: object, state: string, text: string}) => void} [onUpdate]
 * @returns {Promise<Array<{repo: object, state: string, text: string}>>}
 */
async function clear(repos, kind, onUpdate = () => {}) {
    return sweep(repos, onUpdate, async (repo, say) => {
        say('working', CLEAR[kind].busy);
        const result =
            kind === 'stash' ? await gitLib.stash(repo.dir, repo.nested) : await gitLib.discard(repo.dir, repo.nested);
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

module.exports = { actions, run, commit, sync, clear, worktrees, worktreePath, remove, addDirArgs, SYNC, CLEAR };
