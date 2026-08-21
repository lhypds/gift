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

const { pad, width } = require('./util.js');

/** Untracked files larger than this are counted as a change but not read. */
const MAX_UNTRACKED_BYTES = 512 * 1024;
/** How many untracked files are read for their line count before we stop. */
const MAX_UNTRACKED_FILES = 300;
/** How many changed files are stat'd to find the "last updated" time. */
const MAX_STAT_FILES = 200;
/** How many lines of a patch the preview keeps; the rest is a note. */
const MAX_DIFF_LINES = 5000;
/** How many unpushed commits the preview names before it only counts them. */
const MAX_COMMITS = 50;

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
 *
 * `remote` is whether there is an origin to push to at all, which is the same
 * question answered by the same read: a branch that has never been pushed is
 * work sitting on one machine where there is a remote, and is all there is where
 * there is not.
 */
async function identify(dir) {
    const home = await gitDir(dir);
    if (home) {
        try {
            const slug = parseRemote(originUrl(await fsp.readFile(path.join(home, 'config'), 'utf8')));
            if (slug) return { name: slug, remote: true };
        } catch {
            /* unreadable, or not a shape we know — ask git below */
        }
    }

    const url = await git(dir, ['remote', 'get-url', 'origin']);
    const slug = url.ok ? parseRemote(url.stdout) : null;
    return { name: slug || path.basename(dir), remote: url.ok && Boolean(url.stdout.trim()) };
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

/** Whether a `--branch` header says the branch has no commit on it yet. */
function unbornFromHeader(header) {
    return /^## No commits yet on /.test(header);
}

/**
 * What the same header says about the upstream: whether there is one git can
 * count against, and how far the branch stands ahead of it — which is how many
 * commits are on this machine and nowhere else.
 *
 * `## main...origin/main [ahead 2, behind 1]` is two ahead. `## main` has no
 * upstream at all, and neither, for this purpose, has `## main...origin/main
 * [gone]`: the branch it followed is not on origin any more, so there is nothing
 * to count against and the counting is done another way.
 */
function upstreamFromHeader(header) {
    const text = header.slice(3).trim();
    const marks = text.match(/\s\[([^\]]+)\]$/);
    if (!text.includes('...') || (marks && /\bgone\b/.test(marks[1]))) return { upstream: false, ahead: 0 };

    const ahead = marks ? marks[1].match(/\bahead (\d+)/) : null;
    return { upstream: true, ahead: ahead ? Number.parseInt(ahead[1], 10) : 0 };
}

/**
 * How many commits are on this machine and nowhere else.
 *
 * The header's own count where there is an upstream to count against. Where there
 * is not, the commits no remote-tracking ref of any remote can reach — which is
 * the same question `unpushedCommits` lists the answer to, asked as a number. A
 * repository with no remote at all is not asked: there is nowhere for its commits
 * to go, and nothing to say about their not having gone there.
 */
async function aheadCount(dir, tracking, remote) {
    if (tracking.upstream) return tracking.ahead;
    if (!remote) return 0;

    const only = await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    return only.ok ? Number.parseInt(only.stdout.trim(), 10) || 0 : 0;
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
        await handle?.close().catch(() => { });
    }
}

/** Is `child` the same path as, or inside, `parent`? */
function isInside(parent, child) {
    if (child === parent) return true;
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Which status entries belong to this repository rather than to one nested
 * inside it. The nested ones have rows of their own — counted there, read there,
 * stashed and discarded there — and a parent that counted them too would say
 * twice over what changed once.
 *
 * @param {string} dir Repository root.
 * @param {string[]} exclude Absolute paths of repositories nested inside it.
 */
function ownEntry(dir, exclude) {
    return (entry) => {
        const absolute = path.join(dir, entry.path.replace(/\/$/, ''));
        return !exclude.some((nested) => isInside(nested, absolute));
    };
}

/**
 * Read the working-tree state of one repository.
 *
 * @param {string} dir Repository root.
 * @param {string[]} [exclude] Absolute paths of repositories nested inside this
 *   one. They have rows of their own, so their changes are not counted twice.
 * @param {{remote?: boolean}} [options] `remote` is whether there is an origin
 *   to push to, from identify(): a branch with no upstream is unpushed work
 *   where there is somewhere to push it, and nothing to say where there is not.
 * @returns {Promise<object>} branch, whether anything changed, how much is
 *   committed here and nowhere else, the diff size, the newest change time, and
 *   an error string when git refused to answer.
 */
async function inspect(dir, exclude = [], { remote = false } = {}) {
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
    const named = branchFromHeader(header);
    // A detached HEAD is the one state the header cannot name, and the one
    // repository in a hundred that is in it can afford to be asked twice.
    const branch = named ?? (await detachedHead(dir));

    // Commits that are on this machine and nowhere else — which is the other way
    // a repository has work in it, and the one no amount of looking at the
    // working tree finds. A detached HEAD is not a branch to push, and an unborn
    // one has nothing on it.
    //
    // Where the branch has an upstream, the `--branch` header has already said
    // how far ahead of it we are, so this costs nothing. Where it has not — a
    // branch never pushed, or one whose upstream is gone — the header has nothing
    // to say and git is asked: what is only here is what no remote-tracking ref
    // can reach. That is a process, and it is only ever spent on a branch that
    // follows nothing in a repository that has somewhere to push to. Asking is
    // the point of asking, though: a branch made a moment ago and not committed
    // on is not unpushed work, and counting it as such would light up a row that
    // has nothing in it.
    const tracking = upstreamFromHeader(header);
    const pushable = Boolean(named) && !unbornFromHeader(header);
    const ahead = pushable ? await aheadCount(dir, tracking, remote) : 0;
    const unpushed = ahead > 0;

    const entries = parsePorcelain(status.stdout).filter(ownEntry(dir, exclude));

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
        unpushed,
        ahead,
        adds: counts.adds,
        dels: counts.dels,
        lastChange,
        error: null,
    };
}

/**
 * The commits a repository has and its remote has not, newest first.
 *
 * `@{upstream}..HEAD` is exactly what a push would carry, and is asked for
 * first: it is the answer wherever there is an upstream to answer against. Where
 * there is not — a branch that has never been pushed — git refuses that range and
 * says so, and what is only here is then everything no remote-tracking ref of any
 * remote can reach, which is what `--not --remotes` means.
 *
 * Long lists are cut. Fifty commit subjects is more than anybody reads out of a
 * box, and the count says how many were not named — asked for only when there is
 * something to say, since a repository with three unpushed commits has already
 * been counted by listing them.
 *
 * Never throws: a repository that will not answer has nothing waiting.
 *
 * @param {string} dir Repository root.
 * @returns {Promise<{entries: {hash: string, when: string, subject: string}[], total: number}>}
 */
async function unpushedCommits(dir) {
    // A tab cannot appear in any of the three, so it is the one separator a
    // subject cannot break — `%x09` rather than a tab in the argument, because
    // that is what git's own format language calls it.
    const format = '--format=%h%x09%ar%x09%s';
    const limit = ['-n', String(MAX_COMMITS + 1)];

    let range = ['@{upstream}..HEAD'];
    let found = await git(dir, ['log', format, ...limit, ...range]);
    if (!found.ok) {
        range = ['HEAD', '--not', '--remotes'];
        found = await git(dir, ['log', format, ...limit, ...range]);
    }
    if (!found.ok) return { entries: [], total: 0 };

    const entries = found.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [hash, when, ...rest] = line.split('\t');
            return { hash, when: when || '', subject: rest.join('\t') };
        });
    if (entries.length <= MAX_COMMITS) return { entries, total: entries.length };

    const counted = await git(dir, ['rev-list', '--count', ...range]);
    const total = Number.parseInt(counted.stdout, 10);
    return {
        entries: entries.slice(0, MAX_COMMITS),
        total: Number.isFinite(total) && total > MAX_COMMITS ? total : entries.length,
    };
}

/**
 * The commit list for the head of the preview: `8ac1f2e  2 days ago  A message`,
 * the ages lined up under one another so the subjects start in one column.
 */
function commitLines(found) {
    const column = Math.max(...found.entries.map((entry) => width(entry.when)), 0);
    const lines = [
        `unpushed (${found.total}):`,
        ...found.entries.map((entry) => `${entry.hash}  ${pad(entry.when, column)}  ${entry.subject}`),
    ];

    const rest = found.total - found.entries.length;
    if (rest > 0) lines.push(`  … ${rest} more`);
    return lines;
}

/**
 * What one repository has in it that is nowhere else, as lines ready to be shown.
 *
 * This is the same ground `inspect` covers, told at length instead of counted:
 * the commits that never left the machine, then the patch against HEAD, and then
 * the untracked files, which no patch mentions because git has never seen them.
 * Nested repositories are left out of the last two, the way they are left out of
 * the row — the commits are the whole repository's by nature.
 *
 * The commits come first because that is the order the work happened in, and
 * because the patch under them is the part that is not committed anywhere at all.
 *
 * @param {string} dir Repository root.
 * @param {string[]} [exclude] Absolute paths of repositories nested inside it.
 * @param {{unpushed?: boolean}} [options] `unpushed` is what the row says about
 *   this repository, from inspect(): the same fact the orange bar is about, and
 *   the one that decides whether there are commits worth listing. A detached
 *   HEAD, a branch with nowhere to push to, a repository merely behind its
 *   upstream — all say no here, as they say no there.
 * @returns {Promise<{lines: string[], error: string|null}>}
 */
async function diff(dir, exclude = [], { unpushed = false } = {}) {
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

    // The commits that never left the machine, where the row says there are any.
    // A repository with everything pushed asks git nothing about it.
    const waiting = unpushed ? await unpushedCommits(dir) : { entries: [], total: 0 };
    const lines = waiting.entries.length > 0 ? [...commitLines(waiting), ''] : [];

    // Tabs are expanded here rather than left to the terminal: the box the
    // preview is drawn in counts characters, and a tab it counted as one would
    // push the line through the right-hand border.
    const patched = patch.ok
        ? patch.stdout.split('\n').map((line) => line.replace(/\r$/, '').replace(/\t/g, '    '))
        : [];
    while (patched.length > 0 && patched[patched.length - 1] === '') patched.pop();
    lines.push(...patched);
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    // Status answered and the diff did not: say so, rather than let the
    // untracked files below stand in for the whole of what changed.
    if (!patch.ok) lines.push(`error: ${patch.stderr.split('\n')[0] || 'git diff failed'}`);

    const own = ownEntry(dir, exclude);
    const untracked = status.ok
        ? parsePorcelain(status.stdout).filter(
            (entry) => entry.untracked && !entry.path.endsWith('/') && own(entry),
        )
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
 * would write it into its parent as a gitlink nobody asked for. A nested path
 * git already ignores needs no exclusion, and naming it here makes `git add`
 * reject the whole operation as an attempt to add an ignored path.
 */
async function withoutNested(dir, nested) {
    const relative = nested
        .map((child) => path.relative(dir, child).split(path.sep).join('/'))
        .filter((child) => child && !child.startsWith('..'));
    const checked = await Promise.all(
        relative.map(async (child) => ({ child, ignored: (await git(dir, ['check-ignore', '--quiet', '--', child])).ok })),
    );
    return checked.filter(({ ignored }) => !ignored).map(({ child }) => `:(exclude)${child}`);
}

/** `3 files`, or `1 file`, for the lines that count what was moved or thrown away. */
function files(count) {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * Why a push was refused, in the one line worth reading. git's first line only
 * says where it was pushing to, which nobody needed; the reason is the
 * `! [rejected] main -> main (fetch first)` line under it, and where there is no
 * ref-by-ref report to read it is the error. The hints after either are a
 * paragraph about what to do next, and there is no room for a paragraph in a row
 * of a table.
 */
function pushReason(stderr) {
    const lines = String(stderr || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const rejected = lines.find((line) => line.startsWith('!'));
    if (rejected) return rejected.replace(/^!\s*/, '').replace(/\s+/g, ' ');
    return lines.find((line) => /^(error|fatal):/.test(line)) || lines[0] || '';
}

/**
 * Push the branch that is checked out, and give it an upstream if it has never
 * been pushed at all: git refuses a branch with nowhere to push to, says so, and
 * names the command that fixes it, which is the second one tried here.
 *
 * Both the commit-and-push and the plain push go through this, so a first push
 * behaves the same however it was asked for.
 *
 * @param {string} dir Repository root.
 * @param {string} branch The branch to set an upstream for, if one is wanted.
 * @returns {Promise<{ok: boolean, upstream: boolean, reason: string}>} `upstream`
 *   is whether this push is what set the branch to follow origin; `reason` is why
 *   it did not go through, where it did not.
 */
async function pushBranch(dir, branch) {
    const first = await git(dir, ['push'], NETWORK_TIMEOUT_MS);
    if (first.ok || !/no upstream branch|--set-upstream/i.test(first.stderr)) {
        return { ok: first.ok, upstream: false, reason: first.ok ? '' : pushReason(first.stderr) };
    }

    const again = await git(dir, ['push', '--set-upstream', 'origin', branch], NETWORK_TIMEOUT_MS);
    return { ok: again.ok, upstream: again.ok, reason: again.ok ? '' : pushReason(again.stderr) };
}

/**
 * Commit one repository's working tree, and leave the commit here.
 *
 * "The working tree" is what the row counts: tracked changes and untracked files
 * alike, minus anything belonging to a repository nested inside this one.
 *
 * Nothing to commit is not a failure. A repository somebody pointed at along with
 * five others, and has not touched since the last commit, is left alone and says
 * so — the same answer a stash of a clean tree gives.
 *
 * This is the whole of the `c` key, and the first half of `commit & push`: the
 * push is what the two differ by, and the report the first one leaves behind is
 * where a `P` carries it the rest of the way.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} message The commit message.
 * @param {string[]} [nested] Absolute paths of repositories inside this one.
 * @param {(step: string) => void} [onStep] Told 'staging', 'committing'.
 * @returns {Promise<{ok: boolean, committed: boolean, branch: string, text: string}>}
 *   `branch` is the branch the commit went on, for whoever is about to push it.
 */
async function commit(dir, message, nested = [], onStep = () => { }) {
    const fail = (text) => ({ ok: false, committed: false, branch: '', text });

    const branch = await currentBranch(dir);
    if (branch === '-' || branch.startsWith('(')) return fail('detached HEAD — check out a branch first');

    onStep('staging');
    const staged = await git(dir, ['add', '-A', '--', '.', ...(await withoutNested(dir, nested))]);
    if (!staged.ok) return fail(`add failed: ${firstLine(staged.stderr)}`);

    onStep('committing');
    const made = await git(dir, ['commit', '-m', message], COMMIT_TIMEOUT_MS);
    if (!made.ok) {
        if (!NOTHING_TO_COMMIT.test(`${made.stdout}\n${made.stderr}`)) {
            return fail(`commit failed: ${firstLine(made.stderr) || firstLine(made.stdout)}`);
        }
        return { ok: true, committed: false, branch, text: 'nothing to commit' };
    }

    const hash = commitHash(made.stdout);
    return { ok: true, committed: true, branch, text: `committed${hash ? ` ${hash}` : ''}` };
}

/**
 * Commit one repository's working tree and push it: commit() above, and then the
 * branch it committed on.
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
async function commitAndPush(dir, message, nested = [], onStep = () => { }) {
    const fail = (text) => ({ ok: false, committed: false, pushed: false, text });

    const made = await commit(dir, message, nested, onStep);
    if (!made.ok) return fail(made.text);

    const { branch, committed } = made;
    if (!committed) {
        const ahead = await git(dir, ['rev-list', '--count', '@{upstream}..HEAD']);
        // An upstream git cannot name is a branch that has never been pushed.
        if (!ahead.ok || Number.parseInt(ahead.stdout.trim(), 10) === 0) {
            return { ok: true, committed: false, pushed: false, text: 'nothing to commit' };
        }
    }

    onStep('pushing');
    const pushed = await pushBranch(dir, branch);

    const said = committed ? made.text : 'nothing new';
    if (!pushed.ok) {
        return { ok: false, committed, pushed: false, text: `${said} · push failed: ${pushed.reason}` };
    }
    return {
        ok: true,
        committed,
        pushed: true,
        text: `${said} · pushed${pushed.upstream ? ` to origin/${branch}` : ''}`,
    };
}

/**
 * Push what a repository has already committed, and commit nothing now.
 *
 * This is the second half of a commit — the one the report offers a `P` for —
 * and the whole of the key on the table, for the commits that were made somewhere
 * else, in an editor, in an agent, at a shell, and never left the machine. Nothing waiting is not a failure: a branch level with its upstream is
 * left alone rather than made to reach across a network to be told so, and a
 * repository with no commit at all has nothing to push by definition. A branch
 * that has never been pushed is given an upstream, as it is after a commit.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>} `changed` is
 *   whether anything actually left the machine.
 */
async function push(dir) {
    const fail = (text) => ({ ok: false, changed: false, text });

    // Nothing to reach is not worth a network timeout to discover, as in sync().
    const remotes = await git(dir, ['remote']);
    if (!remotes.ok) return fail(firstLine(remotes.stderr) || 'cannot read remotes');
    if (!remotes.stdout.trim()) return fail('no remote to reach');

    const branch = await currentBranch(dir);
    if (branch === '-' || branch.startsWith('(')) return fail('detached HEAD — check out a branch first');

    const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!head.ok || !head.stdout.trim()) return { ok: true, changed: false, text: 'nothing to push' };

    // How far the branch stands ahead of its upstream, which is how much there is
    // to carry. An upstream git cannot name is a branch never pushed, and that is
    // a push of everything on it — how much that is, it does not say.
    const ahead = await git(dir, ['rev-list', '--count', '@{upstream}..HEAD']);
    const commits = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : null;
    if (commits === 0) return { ok: true, changed: false, text: 'nothing to push' };

    const result = await pushBranch(dir, branch);
    if (!result.ok) return fail(`push failed: ${result.reason}`);

    const said = commits === null ? '' : ` ${commits} ${commits === 1 ? 'commit' : 'commits'}`;
    return { ok: true, changed: true, text: `pushed${said}${result.upstream ? ` to origin/${branch}` : ''}` };
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
 * What has changed in one repository's working tree, as entries: the same reading
 * `inspect` counts, for the two commands that empty it. Nothing belonging to a
 * repository nested inside this one is in it — those have rows of their own, and
 * an `s` or a `u` on a parent is not an answer about its children.
 *
 * @param {string} dir Repository root.
 * @param {string[]} exclude Absolute paths of repositories nested inside it.
 * @returns {Promise<{ok: boolean, entries: object[], error: string}>}
 */
async function working(dir, exclude = []) {
    const status = await git(dir, ['status', '--porcelain=v1', '-uall', '-z', '--ignore-submodules=dirty']);
    if (!status.ok) {
        return { ok: false, entries: [], error: firstLine(status.stderr) || 'git status failed' };
    }
    return { ok: true, entries: parsePorcelain(status.stdout).filter(ownEntry(dir, exclude)), error: '' };
}

/**
 * Put a repository's changes out of the way and leave the working tree clean:
 * `git stash push -u`, which takes the tracked changes and the untracked files
 * alike. Ignored files stay where they are — build output is not what anybody
 * means by "my changes" — and so does anything belonging to a repository nested
 * inside this one.
 *
 * This is the one working-tree command that keeps what it takes: restore() below
 * is the `git stash pop` that brings the lot back, which is what it is for and
 * why it stands beside discard() rather than instead of it.
 *
 * Nothing to stash is not a failure. A repository with no commit yet cannot stash
 * at all — there is no HEAD to stash against — and git's refusal is passed on
 * word for word rather than worked around.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string[]} [nested] Absolute paths of repositories inside this one.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function stash(dir, nested = []) {
    const found = await working(dir, nested);
    if (!found.ok) return { ok: false, changed: false, text: found.error };
    if (found.entries.length === 0) return { ok: true, changed: false, text: 'nothing to stash' };

    const result = await git(dir, ['stash', 'push', '-u', '--', '.', ...(await withoutNested(dir, nested))]);
    if (!result.ok) return { ok: false, changed: false, text: `stash failed: ${firstLine(result.stderr)}` };

    return { ok: true, changed: true, text: `stashed ${files(found.entries.length)}` };
}

/**
 * Throw a repository's changes away: the tracked ones put back as HEAD has them,
 * staged and unstaged alike, and the untracked files removed. Ignored files are
 * left alone, and so is anything belonging to a repository nested inside this one.
 *
 * There is nothing to undo this. Asking first is the caller's business, and
 * stash() is the same command for anybody who would rather keep what they have.
 *
 * Putting back is only asked for when there is a tracked change to put back: git
 * refuses a pathspec matching no file it knows of, and a repository whose changes
 * are all new files has nothing for that half to do.
 *
 * A repository with no commit yet has nothing to put anything back to — every
 * change in it is a file git has never committed — so the whole of it is unstaged
 * and then removed with the rest.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string[]} [nested] Absolute paths of repositories inside this one.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function discard(dir, nested = []) {
    const fail = (text) => ({ ok: false, changed: false, text });

    const found = await working(dir, nested);
    if (!found.ok) return fail(found.error);
    if (found.entries.length === 0) return { ok: true, changed: false, text: 'nothing to discard' };

    const paths = ['--', '.', ...(await withoutNested(dir, nested))];
    const tracked = found.entries.filter((entry) => !entry.untracked);

    if (tracked.length > 0) {
        const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
        const put = head.ok && head.stdout.trim()
            ? await git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', ...paths])
            : await git(dir, ['rm', '--cached', '-r', '-q', ...paths]);
        if (!put.ok) return fail(`discard failed: ${firstLine(put.stderr)}`);
    }

    // Always, whether or not anything was untracked a moment ago: what the half
    // above unstaged in a repository with no commit is untracked now, and this is
    // what removes it. With nothing left to remove it does nothing, quietly.
    const cleaned = await git(dir, ['clean', '-fd', ...paths]);
    if (!cleaned.ok) return fail(`discard failed: ${firstLine(cleaned.stderr)}`);

    return { ok: true, changed: true, text: `discarded ${files(found.entries.length)}` };
}

/**
 * What a repository has put aside, newest first — the subject line git writes for
 * each stash entry, as `git stash list` prints them.
 *
 * The box asking about a restore marks its rows with this, the way the branch box
 * marks its own: a repository with nothing stashed is worth seeing before enter
 * rather than in the report afterwards, and one holding three is worth being told
 * it is about to be given back only the newest.
 *
 * Never throws, and a repository that will not answer has nothing stashed rather
 * than an error: this is what a box says while it waits, not work anybody asked
 * for.
 *
 * @param {string} dir Repository root.
 * @returns {Promise<string[]>}
 */
async function stashList(dir) {
    const found = await git(dir, ['stash', 'list', '--format=%gs']);
    return found.ok ? found.stdout.split('\n').filter(Boolean) : [];
}

/**
 * Give a repository back what stash() put aside: `git stash pop`, which is the
 * undo stash() is drawn quietly for.
 *
 * The newest entry and no more. A stash is a stack filled one push at a time, and
 * emptying the whole of it on one keystroke is not what anybody pointing at a row
 * meant — the entries underneath are counted in the row and left where they are.
 *
 * Nothing stashed is not a failure. A repository that was already clean when the
 * rest were stashed has nothing to give back, and says so.
 *
 * A pop that conflicts is left standing, as a merge is: git has put what it could
 * into the working tree and kept the entry it came from, so nothing is lost, and
 * unpicking that on somebody's behalf is not repo-master's business. The row says
 * how many files are waiting.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function restore(dir) {
    const fail = (text) => ({ ok: false, changed: false, text });

    const held = await stashList(dir);
    if (held.length === 0) return { ok: true, changed: false, text: 'nothing stashed' };

    // What is in the entry, counted while it is still an entry: the pop says as
    // much in a paragraph of git's own, and a row of a table has one line. Older
    // git cannot be asked about the untracked half, which is a count not made
    // rather than a restore not done.
    const inside = await git(dir, ['stash', 'show', '--name-only', '--include-untracked', 'stash@{0}']);
    const count = inside.ok ? inside.stdout.split('\n').filter(Boolean).length : 0;

    const done = await git(dir, ['stash', 'pop']);
    if (!done.ok) {
        const waiting = await conflicts(dir);
        if (waiting > 0) return fail(`conflicted · ${files(waiting)} to resolve · the stash is kept`);
        return fail(`restore failed: ${refusal(done)}`);
    }

    const left = held.length - 1;
    return {
        ok: true,
        changed: true,
        text: `restored ${count > 0 ? files(count) : 'the stash'}${left > 0 ? ` · ${left} more stashed` : ''}`,
    };
}

/**
 * What a typed branch name means in this repository. The branch of that name if
 * it has one; origin's if only origin has heard of it, which is what anybody
 * typing a colleague's branch name meant; and null when neither has one.
 *
 * The four commands that take a branch name all ask this first, and say which
 * answer they got — a name that is here and a name that is only on origin are
 * two different pieces of work, and being told which is half of trusting it.
 *
 * @param {string} dir Repository root.
 * @param {string} name The branch name as it was typed.
 * @returns {Promise<{ref: string, local: boolean}|null>}
 */
async function findBranch(dir, name) {
    const here = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (here.ok && here.stdout.trim()) return { ref: name, local: true };

    const there = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
    if (there.ok && there.stdout.trim()) return { ref: `origin/${name}`, local: false };

    return null;
}

/**
 * Every branch name a repository has, its own and origin's, for the box that asks
 * which one is meant: it marks the repositories a typed name is in as it is
 * typed, so `b` on a folder of them shows which will move before enter does
 * anything.
 *
 * One process for both lists, and one per repository per box rather than per
 * keystroke — a box may be about thirty repositories, and thirty is a whole
 * sweep's worth of git already.
 *
 * Never throws, and a repository that will not answer has no branches rather than
 * an error: this is what a box says while it waits, not work anybody asked for.
 *
 * @param {string} dir Repository root.
 * @returns {Promise<{local: string[], remote: string[]}>}
 */
async function branches(dir) {
    // The whole refname rather than the short one: shortened, `refs/heads/main`
    // and `refs/remotes/origin/main` are both `main` — and `origin/HEAD`, which is
    // a pointer at origin's default branch rather than a branch anybody named, is
    // shortened to `origin` and reads exactly like a branch called origin.
    const found = await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
    if (!found.ok) return { local: [], remote: [] };

    const local = [];
    const remote = [];
    for (const line of found.stdout.split('\n')) {
        const ref = line.trim();
        if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
        else if (ref.startsWith('refs/remotes/origin/')) {
            const name = ref.slice('refs/remotes/origin/'.length);
            if (name !== 'HEAD') remote.push(name);
        }
    }
    return { local, remote };
}

/**
 * Check a branch out. One that is here is switched to; one only origin has is
 * made here first and set to follow it, which is `git switch --track`; a name
 * neither has heard of is not a branch to switch to, and `new branch` is the
 * command for that instead.
 *
 * What git does with the changes in the working tree is git's own business: it
 * carries them across where it can and refuses where it cannot, and its refusal
 * is passed on word for word.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} name The branch to check out.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function switchBranch(dir, name) {
    const current = await currentBranch(dir);
    if (current === name) return { ok: true, changed: false, text: `already on ${name}` };

    const found = await findBranch(dir, name);
    if (!found) return { ok: false, changed: false, text: `no branch ${name} here or on origin` };

    const done = found.local
        ? await git(dir, ['switch', name])
        : await git(dir, ['switch', '--track', found.ref]);
    if (!done.ok) return { ok: false, changed: false, text: firstLine(done.stderr) || 'switch failed' };

    return {
        ok: true,
        changed: true,
        text: `on ${name}${found.local ? '' : ` · new here, following ${found.ref}`}`,
    };
}

/**
 * Make a branch off whatever is checked out, and check it out. A name already
 * taken is git's to refuse — that branch is somewhere, with commits on it, and
 * repo-master is not the thing to decide what happens to them — and `switch
 * branch` is the command for a branch that already exists.
 *
 * A repository with no commit yet has a branch all the same: the unborn one HEAD
 * points at, which git renames rather than refusing.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} name The branch to make.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function createBranch(dir, name) {
    const from = await currentBranch(dir);
    const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const born = head.ok && Boolean(head.stdout.trim());

    const made = await git(dir, ['switch', '-c', name]);
    if (!made.ok) return { ok: false, changed: false, text: firstLine(made.stderr) || 'branch failed' };

    // A branch off nothing is not "off main" however main is what HEAD said: there
    // were no commits to branch from, and the new name is where the first will go.
    return { ok: true, changed: true, text: born ? `on ${name} · new, off ${from}` : `on ${name} · new, nothing on it yet` };
}

/**
 * How many commits `HEAD` moved on by, for the commands that move it. An empty
 * string where it did not move at all, or where git will not count.
 */
async function moved(dir, before) {
    if (!before) return '';
    const count = await git(dir, ['rev-list', '--count', `${before}..HEAD`]);
    const commits = Number.parseInt(count.stdout, 10);
    return Number.isFinite(commits) && commits > 0 ? ` ${commits} ${commits === 1 ? 'commit' : 'commits'}` : '';
}

/**
 * git's first word on why it would not do something, without the colon it leaves
 * on the end of a line that had a list of files under it — the list is the rest of
 * what git said, and there is one line in a row of a table to say it in.
 */
function refusal(result) {
    return (firstLine(result.stderr) || firstLine(result.stdout) || '').replace(/:$/, '');
}

/** The files a merge or a rebase stopped on, which are the ones left to resolve. */
async function conflicts(dir) {
    const unmerged = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
    return unmerged.ok ? unmerged.stdout.split('\n').filter(Boolean).length : 0;
}

/**
 * Merge a branch into the one that is checked out.
 *
 * `--no-edit` because there is no editor to open: the table has the terminal, and
 * git waiting on a message nobody can see is a repository that hangs until the
 * timeout. The default message is the one `git merge` writes anyway.
 *
 * A merge that hits conflicts is not undone. It stops with the tree half-merged,
 * which is git's normal way of asking for a hand, and unpicking that on somebody's
 * behalf is not repo-master's business — a merge somebody wanted is worth
 * resolving, and throwing it away because a table ran it would be the wrong
 * answer. The row says how many files are waiting and names the way out.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} name The branch to merge in.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function merge(dir, name) {
    const fail = (text) => ({ ok: false, changed: false, text });

    const current = await currentBranch(dir);
    if (current === name) return fail(`${name} is the branch you are on`);

    const found = await findBranch(dir, name);
    if (!found) return fail(`no branch ${name} here or on origin`);

    const before = await git(dir, ['rev-parse', 'HEAD']);
    const done = await git(dir, ['merge', '--no-edit', found.ref], COMMIT_TIMEOUT_MS);
    if (!done.ok) {
        const waiting = await conflicts(dir);
        if (waiting > 0) return fail(`conflicted · ${files(waiting)} to resolve, or git merge --abort`);
        return fail(`merge failed: ${refusal(done)}`);
    }

    const after = await git(dir, ['rev-parse', 'HEAD']);
    if (before.ok && after.ok && before.stdout.trim() === after.stdout.trim()) {
        return { ok: true, changed: false, text: `already has ${found.ref}` };
    }

    return { ok: true, changed: true, text: `merged ${found.ref}${await moved(dir, before.ok ? before.stdout.trim() : '')}` };
}

/**
 * Rebase the branch that is checked out onto another one.
 *
 * A rebase that stops on a conflict is left standing, as a merge is, and for the
 * same reason: the repository is in the middle of one, git is waiting, and the
 * row says so and names the way back out. This is the one command here that
 * rewrites commits, and what it rewrites is the branch you are on — the box says
 * which branch that is, in every repository it is about, before enter is pressed.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} name The branch to rebase onto.
 * @returns {Promise<{ok: boolean, changed: boolean, text: string}>}
 */
async function rebase(dir, name) {
    const fail = (text) => ({ ok: false, changed: false, text });

    const current = await currentBranch(dir);
    if (current === name) return fail(`${name} is the branch you are on`);

    const found = await findBranch(dir, name);
    if (!found) return fail(`no branch ${name} here or on origin`);

    const before = await git(dir, ['rev-parse', 'HEAD']);
    const done = await git(dir, ['rebase', found.ref], COMMIT_TIMEOUT_MS);
    if (!done.ok) {
        const waiting = await conflicts(dir);
        if (waiting > 0) return fail(`stopped · ${files(waiting)} to resolve, or git rebase --abort`);
        // Stopped for some other reason — an empty commit, a hook — and still in
        // the middle of a rebase, which is worth knowing before the next command.
        const standing = await git(dir, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']);
        const said = refusal(done) || 'rebase failed';
        return fail(standing.ok && standing.stdout.trim() ? `stopped mid-rebase · ${said}` : `rebase failed: ${said}`);
    }

    const after = await git(dir, ['rev-parse', 'HEAD']);
    if (before.ok && after.ok && before.stdout.trim() === after.stdout.trim()) {
        return { ok: true, changed: false, text: `already on top of ${found.ref}` };
    }

    return { ok: true, changed: true, text: `rebased onto ${found.ref}` };
}

/**
 * Add a linked worktree to a repository: another folder with another branch
 * checked out in it, sharing the one history.
 *
 * Which branch is meant is worked out rather than asked twice, the way it is for
 * every other command that takes a branch name: a branch that exists here is
 * checked out, one that exists only on origin is created to follow it, and a name
 * git has never heard of is a new branch off HEAD. Everything after that is git's
 * to refuse — a branch already checked out in another worktree, a folder already
 * there — and its refusal is passed on word for word.
 *
 * Never throws: trouble comes back as ok: false and a line saying what.
 *
 * @param {string} dir Repository root.
 * @param {string} branch Branch to check out in the new worktree.
 * @param {string} target Folder to make, which must not exist yet.
 * @returns {Promise<{ok: boolean, added: boolean, text: string}>}
 */
async function addWorktree(dir, branch, target) {
    const found = await findBranch(dir, branch);
    const known = Boolean(found && found.local);
    const from = found && !found.local ? found.ref : '';

    const args = known ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, from].filter(Boolean);
    const added = await git(dir, args);
    if (!added.ok) return { ok: false, added: false, text: firstLine(added.stderr) || 'worktree add failed' };

    const said = known ? 'checked out' : from ? `new branch, following ${from}` : 'new branch';
    return { ok: true, added: true, text: `added ${path.basename(target)} · ${said}` };
}

module.exports = {
    git,
    identify,
    inspect,
    diff,
    parseRemote,
    commit,
    commitAndPush,
    push,
    sync,
    stash,
    discard,
    stashList,
    unpushedCommits,
    restore,
    branches,
    switchBranch,
    createBranch,
    merge,
    rebase,
    addWorktree,
};
