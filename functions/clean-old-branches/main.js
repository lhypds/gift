#!/usr/bin/env node
// clean-old-branches — delete the local branches the remote does not have.
//
// A branch whose pull request was merged is deleted on GitHub and lives on here,
// one more name in `git branch` for every piece of work finished. This asks the
// remote which branches it has and deletes every local branch that is not among
// them, once it has listed them and been told to.
//
// The remote is asked with `git ls-remote` rather than read from the
// remote-tracking refs: those are only as fresh as the last fetch, and hold only
// what the fetch refspec names — a single-branch clone has one of them, and
// would read every other branch as gone.
'use strict';

const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const NAME = 'clean-old-branches';

const HEADS = 'refs/heads/';

/** Asking a remote waits on the network, and one that never answers should not hang the terminal. */
const NETWORK_TIMEOUT_MS = 60 * 1000;

const GIT_MISSING = 'git is not installed';

/**
 * One line per local branch, its fields NUL-separated: the full ref name (a short
 * one can be ambiguous with a tag), the commit it is on, the remote and branch it
 * tracks, and the worktree it is checked out in.
 */
const LOCAL_FORMAT = ['%(refname)', '%(objectname:short)', '%(upstream:remotename)', '%(upstream:remoteref)', '%(worktreepath)'].join('%00');

function usage() {
    console.log(`Usage: gift clean-old-branches [options]

Delete every local branch in the current repository that is not on the remote:
the ones whose remote branch was deleted after a merge, and the ones that were
never pushed. The list is shown first, and nothing is deleted until you say so.

The remote is asked which branches it has, so nothing needs fetching first. A
branch is on the remote when a branch of the same name is there, or the branch
it tracks is. A branch checked out here or in another worktree is kept.

Options:
  -r, --remote NAME    The remote to compare with   (default: origin, or the only remote)
  -y, --yes            Delete without asking
  -n, --dry-run        List what would be deleted, without deleting it
  -h, --help           Show this help

Examples:
  gift clean-old-branches
  gift clean-old-branches --dry-run
  gift clean-old-branches --remote upstream --yes

Branches are deleted with \`git branch -D\`, so unmerged work goes with them.
Each one's last commit is printed as it goes, and \`git branch <name> <commit>\`
brings a branch back.`);
}

/** The reverse of a leading `~`, so a repository reads as ~/code/app rather than /Users/me/code/app. */
function shortenHome(value) {
    const home = os.homedir();
    if (value === home) return '~';
    if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1)}`;
    return value;
}

function pad(text, columns) {
    return text + ' '.repeat(Math.max(0, columns - text.length));
}

function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

function parseArgs(argv, env = {}) {
    const options = {
        remote: env.GIFT_CLEAN_BRANCHES_REMOTE || '',
        yes: false,
        dryRun: false,
        help: false,
        error: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];

        if (argument === '-h' || argument === '--help') options.help = true;
        else if (argument === '-y' || argument === '--yes') options.yes = true;
        else if (argument === '-n' || argument === '--dry-run') options.dryRun = true;
        else if (argument === '-r' || argument === '--remote') {
            const next = argv[++i];
            if (next === undefined) options.error = `${argument} needs a value`;
            else options.remote = next;
        } else if (argument.startsWith('--remote=')) options.remote = argument.slice(9);
        else if (argument.startsWith('-')) options.error = `unknown option: ${argument}`;
        else options.error = `unexpected argument: ${argument} — it works on the repository you are in`;
    }

    return options;
}

/** Run a git command in the repository, with its output kept. */
function git(args, { cwd, timeout = 0 } = {}) {
    return new Promise((resolve) => {
        // A remote wanting a password over HTTPS fails rather than waits for one
        // nobody is being shown the prompt for.
        const child = spawn('git', args, {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => {
            out += chunk;
        });
        child.stderr.on('data', (chunk) => {
            err += chunk;
        });

        const timer = timeout
            ? setTimeout(() => {
                  child.kill('SIGKILL');
                  err += '\ntimed out';
              }, timeout)
            : null;

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ ok: false, out, err: error.code === 'ENOENT' ? GIT_MISSING : error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, out, err });
        });
    });
}

/** The first thing git said, which is what went wrong rather than its advice about it. */
function reason(text) {
    const line = String(text)
        .split(/[\r\n]+/)
        .map((each) => each.trim())
        .find(Boolean);
    return (line || '').replace(/^(?:fatal|error): /i, '');
}

/**
 * The remote to compare with: the one asked for, else origin, else the only one
 * there is. Several remotes and no origin is a question with no right guess.
 *
 * @returns {{remote: string} | {error: string}}
 */
function chooseRemote(remotes, wanted) {
    if (wanted) {
        if (remotes.includes(wanted)) return { remote: wanted };
        return {
            error: remotes.length
                ? `no remote called '${wanted}' — this repository has ${remotes.join(', ')}`
                : `no remote called '${wanted}' — this repository has none`,
        };
    }
    if (remotes.includes('origin')) return { remote: 'origin' };
    if (remotes.length === 1) return { remote: remotes[0] };
    if (remotes.length === 0) return { error: 'this repository has no remote to compare its branches with' };
    return { error: `several remotes and none called origin (${remotes.join(', ')}) — say which with --remote` };
}

/** The branch names in `git ls-remote --heads` output. */
function parseRemoteBranches(text) {
    const names = new Set();
    for (const line of String(text).split('\n')) {
        const ref = line.split('\t')[1];
        if (ref && ref.startsWith(HEADS)) names.add(ref.slice(HEADS.length).trim());
    }
    return names;
}

/** The local branches in `git for-each-ref --format=LOCAL_FORMAT` output. */
function parseLocalBranches(text) {
    return String(text)
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [ref, commit = '', upstreamRemote = '', upstreamRef = '', worktree = ''] = line.split('\0');
            return { name: ref.slice(HEADS.length), commit, upstreamRemote, upstreamRef, worktree };
        });
}

/**
 * Sort the local branches the remote does not have into the ones to delete and
 * the ones kept anyway, each with why. A branch the remote does have is in
 * neither: there is nothing to say about it.
 *
 * @param {Array<object>} branches From parseLocalBranches().
 * @param {{remote: string, onRemote: Set<string>, here: string}} context `here`
 *   is the worktree this was run in, so a branch checked out in it reads as such.
 * @returns {{stale: Array<object>, kept: Array<object>}} Each branch with a `why`.
 */
function classify(branches, { remote, onRemote, here }) {
    const stale = [];
    const kept = [];

    for (const branch of branches) {
        const tracked = branch.upstreamRef.startsWith(HEADS) ? branch.upstreamRef.slice(HEADS.length) : '';
        const tracksHere = Boolean(tracked) && branch.upstreamRemote === remote;

        // Pushed under another name and tracking it counts: the work is there.
        if (onRemote.has(branch.name) || (tracksHere && onRemote.has(tracked))) continue;

        // git refuses to delete a branch a worktree is on, so it is not offered.
        if (branch.worktree) {
            const where = branch.worktree === here ? 'checked out here' : `checked out in ${shortenHome(branch.worktree)}`;
            kept.push({ ...branch, why: where });
            continue;
        }

        // `.` is a branch tracking another local branch, which is no remote at
        // all. Any other remote is one that was not asked, so it is not known to
        // be gone from it.
        if (branch.upstreamRemote && branch.upstreamRemote !== '.' && branch.upstreamRemote !== remote) {
            kept.push({ ...branch, why: `tracks ${branch.upstreamRemote}${tracked ? `/${tracked}` : ''}` });
            continue;
        }

        stale.push({ ...branch, why: tracksHere ? `gone from ${remote}` : 'no upstream' });
    }

    return { stale, kept };
}

/**
 * Ask one question and resolve with the answer. Ctrl-C and Ctrl-D answer
 * nothing, and resolve null.
 */
function ask(question, { input = process.stdin, output = process.stdout } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input, output });

        let done = false;
        const finish = (answer) => {
            if (done) return;
            done = true;
            resolve(answer);
        };

        rl.once('SIGINT', () => {
            output.write('\n');
            finish(null);
            rl.close();
        });
        rl.once('close', () => {
            if (!done) output.write('\n');
            finish(null);
        });
        rl.question(question, (answer) => {
            finish(answer);
            rl.close();
        });
    });
}

async function main(argv, { cwd = process.cwd() } = {}) {
    const options = parseArgs(argv, process.env);
    if (options.help) {
        usage();
        return 0;
    }
    if (options.error) {
        console.error(`${NAME}: ${options.error}`);
        console.error('Run `gift clean-old-branches --help` for the options.');
        return 2;
    }

    const inside = await git(['rev-parse', '--git-dir'], { cwd });
    if (!inside.ok) {
        console.error(`${NAME}: ${inside.err === GIT_MISSING ? GIT_MISSING : `${shortenHome(cwd)} is not in a git repository`}`);
        return 2;
    }

    // A bare repository has no top level, and no branch checked out "here".
    const top = await git(['rev-parse', '--show-toplevel'], { cwd });
    const here = top.ok ? top.out.trim() : '';

    const listed = await git(['remote'], { cwd });
    const remotes = listed.out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const chosen = chooseRemote(remotes, options.remote);
    if (chosen.error) {
        console.error(`${NAME}: ${chosen.error}`);
        return 2;
    }
    const { remote } = chosen;

    const local = await git(['for-each-ref', `--format=${LOCAL_FORMAT}`, HEADS], { cwd });
    if (!local.ok) {
        console.error(`${NAME}: could not list the local branches: ${reason(local.err)}`);
        return 1;
    }
    const branches = parseLocalBranches(local.out);

    console.log(`${pad('Repository:', 13)}${shortenHome(here || cwd)}`);

    const asked = await git(['ls-remote', '--heads', remote], { cwd, timeout: NETWORK_TIMEOUT_MS });
    if (!asked.ok) {
        console.error(`${NAME}: could not ask ${remote} for its branches: ${reason(asked.err) || 'git ls-remote failed'}`);
        console.error('Nothing was deleted.');
        return 1;
    }
    const onRemote = parseRemoteBranches(asked.out);
    console.log(`${pad('Remote:', 13)}${remote} — ${plural(onRemote.size, 'branch', 'branches')}`);

    // An empty answer is what a wrong URL, or a repository nothing has been
    // pushed to yet, gives — and taken at its word it deletes every branch.
    if (onRemote.size === 0) {
        console.error(`${NAME}: ${remote} has no branches at all, so every local branch would go.`);
        console.error('Nothing was deleted.');
        return 1;
    }

    const { stale, kept } = classify(branches, { remote, onRemote, here });
    const column = Math.max(0, ...[...stale, ...kept].map((branch) => branch.name.length));

    if (stale.length) {
        console.log('');
        console.log(`Not on ${remote}:`);
        for (const branch of stale) console.log(`  ${pad(branch.name, column)}  ${branch.commit}  ${branch.why}`);
    }
    if (kept.length) {
        console.log('');
        console.log(`Kept, though not on ${remote}:`);
        for (const branch of kept) console.log(`  ${pad(branch.name, column)}  ${branch.why}`);
    }

    console.log('');
    if (stale.length === 0) {
        console.log('Nothing to delete.');
        return 0;
    }
    if (options.dryRun) {
        console.log('Dry run — nothing was deleted.');
        return 0;
    }

    if (!options.yes) {
        // Nobody is asked who cannot answer — a hook, a pipe.
        if (!process.stdin.isTTY) {
            console.error(`${NAME}: there is nobody to ask before deleting — run it with --yes to delete without asking.`);
            return 2;
        }
        const answer = await ask(`Delete ${plural(stale.length, 'branch', 'branches')}? [y/N] `);
        if (answer === null) return 130; // Ctrl-C
        if (!/^y(?:es)?$/i.test(answer.trim())) {
            console.log('Nothing was deleted.');
            return 0;
        }
        console.log('');
    }

    let failed = 0;
    for (const branch of stale) {
        const deleted = await git(['branch', '-D', branch.name], { cwd });
        if (deleted.ok) {
            console.log(`  deleted  ${pad(branch.name, column)}  was ${branch.commit}`);
        } else {
            failed++;
            console.log(`  failed   ${pad(branch.name, column)}  ${reason(deleted.err) || 'git branch -D failed'}`);
        }
    }

    const gone = stale.length - failed;
    console.log('');
    console.log(`${plural(gone, 'branch', 'branches')} deleted${failed ? `, ${failed} failed` : ''}.`);
    if (gone) console.log('To bring one back: git branch <name> <commit>');
    return failed ? 1 : 0;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error) => {
            console.error(`${NAME}: ${error && error.message ? error.message : error}`);
            process.exit(1);
        });
}

module.exports = { main, parseArgs, chooseRemote, parseRemoteBranches, parseLocalBranches, classify };
