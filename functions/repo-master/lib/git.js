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
 * owner/repo and the host it lives on, read from the origin remote. Returns
 * null for a repository with no origin, or a URL we cannot make sense of.
 */
function parseRemote(url) {
    const trimmed = url.trim();
    if (!trimmed) return null;

    // git@host:owner/repo.git · ssh://git@host/owner/repo · https://host/owner/repo.git
    const match = trimmed.match(/^(?:[\w.+-]+@|[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?)([^:/]+)[:/]+(.+?)(?:\.git)?\/?$/i);
    if (!match) return null;

    const host = match[1].replace(/^ssh\./, '');
    const slug = match[2].replace(/^:\d+\//, ''); // ssh://host:22/owner/repo
    if (!slug.includes('/')) return null;
    return { host, slug };
}

/** The parts of a repository that do not change between refreshes. */
async function identify(dir) {
    const remote = await git(dir, ['remote', 'get-url', 'origin']);
    const parsed = remote.ok ? parseRemote(remote.stdout) : null;
    return {
        host: parsed ? parsed.host : null,
        slug: parsed ? parsed.slug : null,
        name: parsed ? parsed.slug : path.basename(dir),
    };
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

module.exports = { git, identify, inspect, parseRemote };
