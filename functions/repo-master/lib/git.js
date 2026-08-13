// What one repository looks like right now: where it points, what changed in
// the working tree, how many lines that is, and when it last moved.
//
// Every call passes --no-optional-locks so that reading a repository never
// rewrites .git/index — otherwise the file watcher would see our own refresh
// and ask for another one, forever.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** Untracked files larger than this are counted as a change but not read. */
const MAX_UNTRACKED_BYTES = 512 * 1024;
/** How many untracked files are read for their line count before we stop. */
const MAX_UNTRACKED_FILES = 300;
/** How many changed files are stat'd to find the "last updated" time. */
const MAX_STAT_FILES = 200;
/** How many lines of a patch the preview keeps; the rest is a note. */
const MAX_DIFF_LINES = 5000;

/** A commit runs the repository's own hooks, which are nobody's business but its. */
const COMMIT_TIMEOUT_MS = 60000;
/** Reaching a remote waits on a network, and sometimes on a large repository. */
const NETWORK_TIMEOUT_MS = 120000;

/** What git says when there was nothing there to commit. None of it is an error. */
const NOTHING_TO_COMMIT = /nothing to commit|nothing added to commit|no changes added to commit/i;

const MAX_BUFFER = 32 * 1024 * 1024;

/** Run git in a directory. Never rejects — failures come back as ok: false. */
function git(dir, args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile(
            'git',
            ['--no-optional-locks', '-C', dir, ...args],
            { maxBuffer: MAX_BUFFER, timeout, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    resolve({ ok: false, stdout: stdout || '', stderr: (stderr || error.message || '').trim() });
                    return;
                }
                resolve({ ok: true, stdout, stderr });
            },
        );
    });
}

/**
 * The owner/repo a remote URL names. Returns null for a repository with no
 * origin, or a URL we cannot make sense of.
 */
function parseRemote(url) {
    const trimmed = url.trim();
    if (!trimmed) return null;

    // git@host:owner/repo.git · ssh://git@host/owner/repo · https://host/owner/repo.git
    const match = trimmed.match(/^(?:[\w.+-]+@|[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?)([^:/]+)[:/]+(.+?)(?:\.git)?\/?$/i);
    if (!match) return null;

    const slug = match[2].replace(/^:\d+\//, ''); // ssh://host:22/owner/repo
    return slug.includes('/') ? slug : null;
}

/**
 * Where a repository keeps its .git. Usually the folder of that name; a
 * submodule or a linked worktree leaves a file pointing at the real one.
 */
async function gitDir(dir) {
    const dot = path.join(dir, '.git');
    try {
        if ((await fsp.stat(dot)).isDirectory()) return dot;
        const pointer = await fsp.readFile(dot, 'utf8');
        const target = pointer.match(/^gitdir:\s*(.+)$/m);
        return target ? path.resolve(dir, target[1].trim()) : null;
    } catch {
        return null;
    }
}

/**
 * origin's URL out of a git config file. Deliberately a plain read of the
 * simplest shape a config takes, rather than a config parser: anything it does
 * not recognise falls back to asking git, which is always right and only slow.
 */
function originUrl(config) {
    let inOrigin = false;
    for (const line of config.split(/\r?\n/)) {
        const text = line.trim();
        if (text.startsWith('[')) {
            inOrigin = /^\[remote\s+"origin"\]$/.test(text);
            continue;
        }
        if (!inOrigin) continue;
        const url = text.match(/^url\s*=\s*(.+)$/i);
        if (url) return url[1].trim();
    }
    return '';
}

/**
 * The parts of a repository that do not change between refreshes.
 *
 * The name is only a label, and the file it is written in is right there:
 * reading it beats `git remote get-url origin`, which costs a whole process to
 * say the same thing. Spawning git is what a sweep of a folder full of
 * repositories actually spends its time on, and this one runs once per row
 * before anything is drawn at all.
 */
async function identify(dir) {
    const home = await gitDir(dir);
    if (home) {
        try {
            const slug = parseRemote(originUrl(await fsp.readFile(path.join(home, 'config'), 'utf8')));
            if (slug) return { name: slug };
        } catch {
            /* unreadable, or not a shape we know — ask git below */
        }
    }

    const remote = await git(dir, ['remote', 'get-url', 'origin']);
    const slug = remote.ok ? parseRemote(remote.stdout) : null;
    return { name: slug || path.basename(dir) };
}

/** The short commit to show where there is no branch name to show instead. */
async function detachedHead(dir) {
    const head = await git(dir, ['rev-parse', '--short', 'HEAD']);
    if (head.ok && head.stdout.trim()) return `(${head.stdout.trim()})`;
    return '-'; // a repository with no commits yet
}

/** The checked-out branch, or the short commit when HEAD is detached. */
async function currentBranch(dir) {
    const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.ok && branch.stdout.trim()) return branch.stdout.trim();

    return detachedHead(dir);
}

/**
 * The branch out of a `--branch` status header, which reads `## main`,
 * `## main...origin/main [ahead 1]`, `## No commits yet on main`, or
 * `## HEAD (no branch)` when HEAD is detached. Null means detached: there is no
 * name in the header to use, and the commit has to be asked for separately.
 */
function branchFromHeader(header) {
    let text = header.slice(3).trim();
    if (text === 'HEAD (no branch)') return null;

    const unborn = text.match(/^No commits yet on (.+)$/);
    if (unborn) text = unborn[1];

    // `...` separates the branch from its upstream, and cannot appear in a ref
    // name; the ahead/behind count that may follow goes with the upstream.
    return text.split('...')[0].replace(/\s*\[.*\]$/, '').trim() || '-';
}

/**
 * Split `git status --porcelain=v1 -z` output. Entries are NUL terminated, and
 * a rename or copy is followed by its original path as a field of its own.
 * Under `--branch` the first record is the branch header instead of an entry;
 * no entry can be mistaken for it, since one always begins with two status
 * letters and a space.
 */
function parsePorcelain(output) {
    const fields = output.split('\0');
    const entries = [];

    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.length < 4) continue;
        if (i === 0 && field.startsWith('## ')) continue;

        const index = field[0];
        const tree = field[1];
        entries.push({ index, tree, path: field.slice(3), untracked: index === '?' && tree === '?' });
        if (index === 'R' || index === 'C') i++; // skip the original path
    }
    return entries;
}

/** Added and deleted line counts from `git diff --numstat`; binaries count as 0. */
function sumNumstat(output) {
    let adds = 0;
    let dels = 0;
    for (const line of output.split('\n')) {
        if (!line) continue;
        const [addField, delField] = line.split('\t');
        adds += Number.parseInt(addField, 10) || 0;
        dels += Number.parseInt(delField, 10) || 0;
    }
    return { adds, dels };
}

/** Lines in a file we have never seen before. Binary and huge files count as 0. */
async function countLines(file) {
    let handle;
    try {
        handle = await fsp.open(file, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_UNTRACKED_BYTES) return 0;

        const buffer = Buffer.alloc(stat.size);
        await handle.read(buffer, 0, stat.size, 0);
        if (buffer.subarray(0, 8192).includes(0)) return 0; // binary

        let lines = 0;
        for (const byte of buffer) if (byte === 0x0a) lines++;
        if (buffer[buffer.length - 1] !== 0x0a) lines++; // no trailing newline
        return lines;
    } catch {
        return 0;
    } finally {
        await handle?.close().catch(() => {});
    }
}

/** Is `child` the same path as, or inside, `parent`? */
function isInside(parent, child) {
    if (child === parent) return true;
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Read the working-tree state of one repository.
 *
 * @param {string} dir Repository root.
 * @param {string[]} [exclude] Absolute paths of repositories nested inside this
 *   one. They have rows of their own, so their changes are not counted twice.
 * @returns {Promise<object>} branch, whether anything changed, the diff size,
 *   the newest change time, and an error string when git refused to answer.
 */
async function inspect(dir, exclude = []) {
    // Starting git is what a sweep costs — the work each one does is nothing
    // beside the process it takes to do it, and a folder of fifty repositories
    // pays that fifty times over, refresh after refresh. So a row asks once and
    // asks for everything: `--branch` puts the branch in the same answer as the
    // working tree, and the patch below is only measured when there is a tracked
    // change to measure, which most repositories most of the time have not got.
    const status = await git(dir, ['status', '--porcelain=v1', '-uall', '-z', '-b', '--ignore-submodules=dirty']);
    if (!status.ok) {
        return { branch: await currentBranch(dir), error: status.stderr.split('\n')[0] || 'git status failed' };
    }

    const header = status.stdout.split('\0', 1)[0];
    // A detached HEAD is the one state the header cannot name, and the one
    // repository in a hundred that is in it can afford to be asked twice.
    const branch = branchFromHeader(header) ?? (await detachedHead(dir));

    const entries = parsePorcelain(status.stdout).filter((entry) => {
        const absolute = path.join(dir, entry.path.replace(/\/$/, ''));
        return !exclude.some((nested) => isInside(nested, absolute));
    });

    let counts = { adds: 0, dels: 0 };
    if (entries.some((entry) => !entry.untracked)) {
        const tracked = await git(dir, ['diff', '--numstat', '--ignore-submodules=dirty', 'HEAD']);
        // An unborn HEAD makes that diff fail; everything staged in such a
        // repository is new, so compare against the index instead.
        if (tracked.ok) {
            counts = sumNumstat(tracked.stdout);
        } else {
            const staged = await git(dir, ['diff', '--numstat', '--cached']);
            if (staged.ok) counts = sumNumstat(staged.stdout);
        }
    }

    const untracked = entries.filter((entry) => entry.untracked && !entry.path.endsWith('/'));
    for (const entry of untracked.slice(0, MAX_UNTRACKED_FILES)) {
        counts.adds += await countLines(path.join(dir, entry.path));
    }

    // "last updated" is the newest change on disk rather than the moment we
    // noticed it, so it survives restarting repo-master.
    let lastChange = null;
    for (const entry of entries.slice(0, MAX_STAT_FILES)) {
        try {
            const stat = await fsp.stat(path.join(dir, entry.path));
            if (stat.mtimeMs > (lastChange || 0)) lastChange = stat.mtimeMs;
        } catch {
            /* deleted, or a nested repository we cannot stat — no time to add */
        }
    }

    return {
        branch,
        hasChanges: entries.length > 0,
        changedFiles: entries.length,
        adds: counts.adds,
        dels: counts.dels,
        lastChange,
        error: null,
    };
}

/**
 * The working-tree changes of one repository, as lines ready to be shown.
 *
 * This is the same ground `inspect` covers, told at length instead of counted:
 * the patch against HEAD, and then the untracked files, which no patch mentions
 * because git has never seen them. Nested repositories are left out of both, the
 * way they are left out of the row.
 *
 * @param {string} dir Repository root.
 * @param {string[]} [exclude] Absolute paths of repositories nested inside it.
 * @returns {Promise<{lines: string[], error: string|null}>}
 */
async function diff(dir, exclude = []) {
    const [tracked, status] = await Promise.all([
        git(dir, ['diff', '--no-color', '--no-ext-diff', '--ignore-submodules=dirty', 'HEAD']),
        git(dir, ['status', '--porcelain=v1', '-uall', '-z', '--ignore-submodules=dirty']),
    ]);

    // An unborn HEAD has nothing to diff against, as in `inspect`.
    const patch = tracked.ok ? tracked : await git(dir, ['diff', '--no-color', '--no-ext-diff', '--cached']);
    if (!patch.ok && !status.ok) {
        // Whatever is wrong, status says it plainly — the diff of a folder that
        // is not a repository complains about the wrong thing entirely.
        const reason = status.stderr.split('\n')[0] || patch.stderr.split('\n')[0];
        return { lines: [], error: reason || 'git diff failed' };
    }

    // Tabs are expanded here rather than left to the terminal: the box the
    // preview is drawn in counts characters, and a tab it counted as one would
    // push the line through the right-hand border.
    const lines = patch.ok
        ? patch.stdout.split('\n').map((line) => line.replace(/\r$/, '').replace(/\t/g, '    '))
        : [];
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    // Status answered and the diff did not: say so, rather than let the
    // untracked files below stand in for the whole of what changed.
    if (!patch.ok) lines.push(`error: ${patch.stderr.split('\n')[0] || 'git diff failed'}`);

    const untracked = status.ok
        ? parsePorcelain(status.stdout).filter((entry) => {
              if (!entry.untracked || entry.path.endsWith('/')) return false;
              const absolute = path.join(dir, entry.path);
              return !exclude.some((nested) => isInside(nested, absolute));
          })
        : [];

    if (untracked.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`untracked (${untracked.length}):`);
        for (const entry of untracked.slice(0, MAX_UNTRACKED_FILES)) {
            const count = await countLines(path.join(dir, entry.path));
            lines.push(`+ ${entry.path}${count > 0 ? `  ${count} ${count === 1 ? 'line' : 'lines'}` : ''}`);
        }
        const rest = untracked.length - MAX_UNTRACKED_FILES;
        if (rest > 0) lines.push(`  … ${rest} more`);
    }

    if (lines.length > MAX_DIFF_LINES) {
        const dropped = lines.length - MAX_DIFF_LINES;
        lines.length = MAX_DIFF_LINES;
        lines.push('', `… ${dropped} more lines`);
    }

    return { lines, error: null };
}

/** The first line worth reading of whatever git had to say. */
function firstLine(text) {
    return String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
}

/** The short hash out of `[main (root-commit) 8ac1f2e] a message`. */
function commitHash(output) {
    const match = firstLine(output).match(/^\[([^\]]+)\]/);
    if (!match) return '';
    const last = match[1].trim().split(/\s+/).pop();
    return /^[0-9a-f]{7,}$/i.test(last) ? last : '';
}

/**
 * Pathspecs that keep the repositories nested inside this one out of its commit.
 * They have rows of their own, and a commit of their own; staging one from here
 * would write it into its parent as a gitlink nobody asked for.
 */
function withoutNested(dir, nested) {
    return nested
        .map((child) => path.relative(dir, child).split(path.sep).join('/'))
        .filter((relative) => relative && !relative.startsWith('..'))
        .map((relative) => `:(exclude)${relative}`);
}

/**
 * Commit one repository's working tree and push it.
 *
 * "The working tree" is what the row counts: tracked changes and untracked files
 * alike, minus anything belonging to a repository nested inside this one.
 *
 * Nothing to commit is not a failure — a repository whose commits never left the
 * machine is still worth pushing. One with neither is left alone rather than
 * made to reach across a network to be told it is up to date, and a branch that
 * has never been pushed is only given an upstream when there is a commit to
 * carry there.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} message The commit message.
 * @param {string[]} [nested] Absolute paths of repositories inside this one.
 * @param {(step: string) => void} [onStep] Told 'staging', 'committing', 'pushing'.
 * @returns {Promise<{ok: boolean, committed: boolean, pushed: boolean, text: string}>}
 */
async function commitAndPush(dir, message, nested = [], onStep = () => {}) {
    const fail = (text) => ({ ok: false, committed: false, pushed: false, text });

    const branch = await currentBranch(dir);
    if (branch === '-' || branch.startsWith('(')) return fail('detached HEAD — check out a branch first');

    onStep('staging');
    const staged = await git(dir, ['add', '-A', '--', '.', ...withoutNested(dir, nested)]);
    if (!staged.ok) return fail(`add failed: ${firstLine(staged.stderr)}`);

    onStep('committing');
    const commit = await git(dir, ['commit', '-m', message], COMMIT_TIMEOUT_MS);
    const committed = commit.ok;
    if (!committed && !NOTHING_TO_COMMIT.test(`${commit.stdout}\n${commit.stderr}`)) {
        return fail(`commit failed: ${firstLine(commit.stderr) || firstLine(commit.stdout)}`);
    }

    if (!committed) {
        const ahead = await git(dir, ['rev-list', '--count', '@{upstream}..HEAD']);
        // An upstream git cannot name is a branch that has never been pushed.
        if (!ahead.ok || Number.parseInt(ahead.stdout.trim(), 10) === 0) {
            return { ok: true, committed: false, pushed: false, text: 'nothing to commit' };
        }
    }

    onStep('pushing');
    let push = await git(dir, ['push'], NETWORK_TIMEOUT_MS);
    let upstream = false;
    // A branch pushed for the first time has nowhere to push to; git says so and
    // names the command that fixes it, which is the one below.
    if (!push.ok && /no upstream branch|--set-upstream/i.test(push.stderr)) {
        push = await git(dir, ['push', '--set-upstream', 'origin', branch], NETWORK_TIMEOUT_MS);
        upstream = push.ok;
    }

    const hash = committed ? commitHash(commit.stdout) : '';
    const said = committed ? `committed${hash ? ` ${hash}` : ''}` : 'nothing new';
    if (!push.ok) {
        return { ok: false, committed, pushed: false, text: `${said} · push failed: ${firstLine(push.stderr)}` };
    }
    return { ok: true, committed, pushed: true, text: `${said} · pushed${upstream ? ` to origin/${branch}` : ''}` };
}

/**
 * Bring one repository up to date with its remote. Fetching hears what is there
 * and touches nothing else; pulling takes it, and is the only thing in
 * repo-master besides a commit that writes to a working tree.
 *
 * Never throws: trouble comes back as ok: false and a line saying what. A pull
 * that will not go through — a tree too dirty to merge into, branches that have
 * diverged with no rule for reconciling them — is git's to refuse, and its
 * refusal is passed on word for word rather than worked around.
 *
 * @param {string} dir Repository root.
 * @param {boolean} pull Take the commits, rather than only hear about them.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>} `changed` is
 *   a pull that moved HEAD, or a fetch that found something to move it to.
 */
async function sync(dir, pull) {
    const fail = (text) => ({ ok: false, changed: false, text });

    // Nothing to reach is not worth a network timeout to discover.
    const remotes = await git(dir, ['remote']);
    if (!remotes.ok) return fail(firstLine(remotes.stderr) || 'cannot read remotes');
    if (!remotes.stdout.trim()) return fail('no remote to reach');

    const before = await git(dir, ['rev-parse', 'HEAD']);
    const result = pull
        ? await git(dir, ['pull'], NETWORK_TIMEOUT_MS)
        : await git(dir, ['fetch', '--all'], NETWORK_TIMEOUT_MS);
    if (!result.ok) {
        return fail(`${pull ? 'pull' : 'fetch'} failed: ${firstLine(result.stderr) || firstLine(result.stdout)}`);
    }

    if (pull) {
        const after = await git(dir, ['rev-parse', 'HEAD']);
        if (!before.ok || !after.ok) return { ok: true, changed: true, text: 'pulled' };
        if (before.stdout.trim() === after.stdout.trim()) {
            return { ok: true, changed: false, text: 'already up to date' };
        }

        const count = await git(dir, ['rev-list', '--count', `${before.stdout.trim()}..HEAD`]);
        const commits = Number.parseInt(count.stdout, 10);
        const said = Number.isFinite(commits) && commits > 0 ? `${commits} ${commits === 1 ? 'commit' : 'commits'}` : '';
        return { ok: true, changed: true, text: `pulled${said ? ` ${said}` : ''}` };
    }

    // A fetch moves nothing here, so what it is worth is how far the branch
    // stands from what it was just fetched against.
    const gap = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    if (!gap.ok) return { ok: true, changed: false, text: 'fetched · no upstream to compare' };

    const [ahead, behind] = gap.stdout
        .trim()
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10) || 0);
    const said = [behind > 0 ? `${behind} behind` : null, ahead > 0 ? `${ahead} ahead` : null].filter(Boolean);
    return { ok: true, changed: behind > 0, text: `fetched · ${said.join(' · ') || 'up to date'}` };
}

/**
 * Add a linked worktree to a repository: another folder with another branch
 * checked out in it, sharing the one history.
 *
 * Which branch is meant is worked out rather than asked twice. A branch that
 * exists here is checked out; one that exists only on origin is created to
 * follow it, which is what anybody typing the name of a colleague's branch
 * meant; a name git has never heard of is a new branch off HEAD. Everything
 * after that is git's to refuse — a branch already checked out in another
 * worktree, a folder already there — and its refusal is passed on word for word.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} branch Branch to check out in the new worktree.
 * @param {string} target Folder to make, which must not exist yet.
 * @returns {Promise<{ok: boolean, added: boolean, text: string}>}
 */
async function addWorktree(dir, branch, target) {
    const here = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    const known = here.ok && here.stdout.trim();

    let from = '';
    if (!known) {
        const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
        if (remote.ok && remote.stdout.trim()) from = `origin/${branch}`;
    }

    const args = known ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, from].filter(Boolean);
    const added = await git(dir, args);
    if (!added.ok) return { ok: false, added: false, text: firstLine(added.stderr) || 'worktree add failed' };

    const said = known ? 'checked out' : from ? `new branch, following ${from}` : 'new branch';
    return { ok: true, added: true, text: `added ${path.basename(target)} · ${said}` };
}

module.exports = { git, identify, inspect, diff, parseRemote, commitAndPush, sync, addWorktree };
