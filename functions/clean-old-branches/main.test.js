// clean-old-branches, against repositories made for the test: a bare one to be
// the remote, and a clone of it holding a branch in each state a local branch
// can be in relative to it. The cases worth a test are the ones a plain "is the
// name on origin" gets wrong — a branch pushed under another name, a stale
// origin/* ref left behind after the remote deleted the branch, a branch
// another worktree has checked out.
//
//     node --test functions/clean-old-branches/main.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const clean = require('./main.js');

const MAIN = path.join(__dirname, 'main.js');

// Nobody's own git config reaches the test: a global commit.gpgsign or a hook
// would make it a test of their machine rather than of the code.
const ENV = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'gift',
    GIT_AUTHOR_EMAIL: 'gift@example.com',
    GIT_COMMITTER_NAME: 'gift',
    GIT_COMMITTER_EMAIL: 'gift@example.com',
};
delete ENV.GIFT_CLEAN_BRANCHES_REMOTE;

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(cwd, ...args) {
    return spawnSync(process.execPath, [MAIN, ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const branches = (cwd) => git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');

/**
 * A remote and a clone of it. The remote has main, pushed and other; the clone:
 *
 *   main       on origin, and checked out
 *   pushed     on origin
 *   renamed    pushed as origin/other and tracking it — its name is not there, its work is
 *   gone       pushed, then deleted on origin, with its origin/gone ref left behind
 *   local      never pushed
 *   elsewhere  never pushed, and checked out in a second worktree
 */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-clean-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const remote = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    git(root, 'init', '--bare', remote);
    git(root, 'clone', remote, work);

    git(work, 'checkout', '-b', 'main');
    git(work, 'commit', '--allow-empty', '-m', 'first');
    git(work, 'push', '-u', 'origin', 'main');
    git(work, 'branch', 'pushed');
    git(work, 'push', '-u', 'origin', 'pushed');
    git(work, 'branch', 'renamed');
    git(work, 'push', '-u', 'origin', 'renamed:other');
    git(work, 'branch', 'gone');
    git(work, 'push', '-u', 'origin', 'gone');
    git(work, 'push', 'origin', '--delete', 'gone');
    git(work, 'branch', 'local');
    git(work, 'branch', 'elsewhere');
    git(work, 'worktree', 'add', path.join(root, 'elsewhere'), 'elsewhere');

    return { root, work };
}

test('parseArgs takes the remote from a flag, or else from the configuration', () => {
    assert.strictEqual(clean.parseArgs([], { GIFT_CLEAN_BRANCHES_REMOTE: 'fork' }).remote, 'fork');
    assert.strictEqual(clean.parseArgs(['--remote=upstream'], { GIFT_CLEAN_BRANCHES_REMOTE: 'fork' }).remote, 'upstream');
    assert.strictEqual(clean.parseArgs(['-r', 'upstream']).remote, 'upstream');
    assert.match(clean.parseArgs(['--remote']).error, /needs a value/);
    assert.match(clean.parseArgs(['main']).error, /unexpected argument/);
});

test('chooseRemote prefers origin, takes a lone remote, and does not guess between several', () => {
    assert.deepStrictEqual(clean.chooseRemote(['upstream', 'origin'], ''), { remote: 'origin' });
    assert.deepStrictEqual(clean.chooseRemote(['fork'], ''), { remote: 'fork' });
    assert.deepStrictEqual(clean.chooseRemote(['origin', 'upstream'], 'upstream'), { remote: 'upstream' });
    assert.ok(clean.chooseRemote(['fork', 'upstream'], '').error);
    assert.ok(clean.chooseRemote([], '').error);
    assert.ok(clean.chooseRemote(['origin'], 'upstream').error);
});

test('parseRemoteBranches reads branch names and nothing else', () => {
    const names = clean.parseRemoteBranches('abc\trefs/heads/main\ndef\trefs/heads/feature/x\n123\trefs/tags/v1\n');
    assert.deepStrictEqual([...names], ['main', 'feature/x']);
});

test('classify keeps what is on the remote under any name, and what git would not delete', () => {
    const branch = (name, upstreamRemote = '', upstreamRef = '', worktree = '') => ({ name, commit: 'abc1234', upstreamRemote, upstreamRef, worktree });
    const { stale, kept } = clean.classify(
        [
            branch('main', 'origin', 'refs/heads/main', '/repo'),
            branch('renamed', 'origin', 'refs/heads/other'),
            branch('gone', 'origin', 'refs/heads/gone'),
            branch('local'),
            branch('stacked', '.', 'refs/heads/local'),
            branch('wip', '', '', '/repo'),
            branch('side', '', '', '/repo-side'),
            branch('fork', 'upstream', 'refs/heads/fork'),
        ],
        { remote: 'origin', onRemote: new Set(['main', 'other']), here: '/repo' },
    );

    assert.deepStrictEqual(
        stale.map((each) => [each.name, each.why]),
        [
            ['gone', 'gone from origin'],
            ['local', 'no upstream'],
            ['stacked', 'no upstream'],
        ],
    );
    assert.deepStrictEqual(
        kept.map((each) => [each.name, each.why]),
        [
            ['wip', 'checked out here'],
            ['side', 'checked out in /repo-side'],
            ['fork', 'tracks upstream/fork'],
        ],
    );
});

test('deletes the branches the remote does not have, and only those', (t) => {
    const { work } = fixture(t);

    const result = run(work, '--yes');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(branches(work), ['elsewhere', 'main', 'pushed', 'renamed']);
    assert.match(result.stdout, /gone\s+\w+\s+gone from origin/);
    assert.match(result.stdout, /local\s+\w+\s+no upstream/);
    assert.match(result.stdout, /elsewhere\s+checked out in /);
    assert.match(result.stdout, /2 branches deleted\./);
});

test('--dry-run lists them and deletes nothing', (t) => {
    const { work } = fixture(t);
    git(work, 'checkout', 'local');
    const before = branches(work);

    const result = run(work, '--dry-run');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /local\s+checked out here/);
    assert.match(result.stdout, /Dry run — nothing was deleted\./);
    assert.deepStrictEqual(branches(work), before);
});

test('without a terminal to ask in, nothing is deleted unless it is told --yes', (t) => {
    const { work } = fixture(t);
    const before = branches(work);

    const result = run(work);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--yes/);
    assert.deepStrictEqual(branches(work), before);
});

test('a remote with no branches at all is refused rather than believed', (t) => {
    const { root, work } = fixture(t);
    const empty = path.join(root, 'empty.git');
    git(root, 'init', '--bare', empty);
    git(work, 'remote', 'add', 'empty', empty);
    const before = branches(work);

    const result = run(work, '--remote=empty', '--yes');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /no branches at all/);
    assert.deepStrictEqual(branches(work), before);
});
