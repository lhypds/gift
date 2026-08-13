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
/** A push waits on a network, and sometimes on a large repository. */
const PUSH_TIMEOUT_MS = 120000;

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

/** The parts of a repository that do not change between refreshes. */
async function identify(dir) {
    const remote = await git(dir, ['remote', 'get-url', 'origin']);
    const slug = remote.ok ? parseRemote(remote.stdout) : null;
    return { name: slug || path.basename(dir) };
}

/** The checked-out branch, or the short commit when HEAD is detached. */
async function currentBranch(dir) {
    const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.ok && branch.stdout.trim()) return branch.stdout.trim();

    const head = await git(dir, ['rev-parse', '--short', 'HEAD']);
    if (head.ok && head.stdout.trim()) return `(${head.stdout.trim()})`;

    return '-'; // a repository with no commits yet
}

/**
 * Split `git status --porcelain=v1 -z` output. Entries are NUL terminated, and
 * a rename or copy is followed by its original path as a field of its own.
 */
function parsePorcelain(output) {
    const fields = output.split('\0');
    const entries = [];

    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.length < 4) continue;

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
    const [branch, status, tracked] = await Promise.all([
        currentBranch(dir),
        git(dir, ['status', '--porcelain=v1', '-uall', '-z', '--ignore-submodules=dirty']),
        git(dir, ['diff', '--numstat', '--ignore-submodules=dirty', 'HEAD']),
    ]);

    if (!status.ok) {
        return { branch, error: status.stderr.split('\n')[0] || 'git status failed' };
    }

    const entries = parsePorcelain(status.stdout).filter((entry) => {
        const absolute = path.join(dir, entry.path.replace(/\/$/, ''));
        return !exclude.some((nested) => isInside(nested, absolute));
    });

    // An unborn HEAD makes the diff above fail; everything staged in such a
    // repository is new, so compare against the index instead.
    let counts = { adds: 0, dels: 0 };
    if (tracked.ok) {
        counts = sumNumstat(tracked.stdout);
    } else {
        const staged = await git(dir, ['diff', '--numstat', '--cached']);
        if (staged.ok) counts = sumNumstat(staged.stdout);
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
    let push = await git(dir, ['push'], PUSH_TIMEOUT_MS);
    let upstream = false;
    // A branch pushed for the first time has nowhere to push to; git says so and
    // names the command that fixes it, which is the one below.
    if (!push.ok && /no upstream branch|--set-upstream/i.test(push.stderr)) {
        push = await git(dir, ['push', '--set-upstream', 'origin', branch], PUSH_TIMEOUT_MS);
        upstream = push.ok;
    }

    const hash = committed ? commitHash(commit.stdout) : '';
    const said = committed ? `committed${hash ? ` ${hash}` : ''}` : 'nothing new';
    if (!push.ok) {
        return { ok: false, committed, pushed: false, text: `${said} · push failed: ${firstLine(push.stderr)}` };
    }
    return { ok: true, committed, pushed: true, text: `${said} · pushed${upstream ? ` to origin/${branch}` : ''}` };
}

module.exports = { git, identify, inspect, diff, parseRemote, commitAndPush };
