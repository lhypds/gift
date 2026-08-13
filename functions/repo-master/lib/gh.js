// Open pull requests, counted with `gh`.
//
// Every repository is asked separately, so the poller spreads its questions
// evenly over the interval instead of asking all of them at once: one call per
// slot, round-robin. GitHub allows an authenticated account 5000 API points an
// hour, and repo-master keeps well under that by refusing to make more than
// `maxPerMinute` calls a minute — with more repositories than that budget
// allows, the interval stretches rather than the limit breaking.
'use strict';

const { execFile } = require('node:child_process');

/** Failures in a row before a repository drops out of the rotation. */
const MAX_FAILURES = 3;

function gh(args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile('gh', args, { maxBuffer: 8 * 1024 * 1024, timeout, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                const reason = error.code === 'ENOENT' ? 'gh is not installed' : (stderr || error.message || '').trim();
                resolve({ ok: false, stdout: stdout || '', reason: reason.split('\n')[0] });
                return;
            }
            resolve({ ok: true, stdout, reason: '' });
        });
    });
}

/** Whether `gh` is installed and signed in, and why not when it is not. */
async function available() {
    const status = await gh(['auth', 'status']);
    if (status.ok) return { ok: true, reason: '' };
    return {
        ok: false,
        reason: status.reason.includes('not installed') ? 'gh is not installed' : 'gh is not signed in',
    };
}

/** `gh` addresses a repository as owner/repo, or host/owner/repo elsewhere. */
function repoArgument(repo) {
    return repo.host && repo.host !== 'github.com' ? `${repo.host}/${repo.slug}` : repo.slug;
}

/** The numbers of the open pull requests on one repository. */
async function openPullRequests(repo) {
    const result = await gh([
        'pr',
        'list',
        '--repo',
        repoArgument(repo),
        '--state',
        'open',
        '--json',
        'number',
        '--limit',
        '100',
    ]);
    if (!result.ok) return { ok: false, reason: result.reason };

    try {
        const parsed = JSON.parse(result.stdout);
        return { ok: true, numbers: parsed.map((pull) => pull.number) };
    } catch {
        return { ok: false, reason: 'gh returned something other than JSON' };
    }
}

/** Only GitHub repositories have pull requests to count. */
function pollable(repo) {
    return Boolean(repo.slug) && Boolean(repo.host) && /(^|\.)github\./i.test(repo.host);
}

/**
 * Ask each repository for its open pull requests, over and over, one at a time.
 *
 * @param {object} options
 * @param {() => object[]} options.repos Current rows, read afresh each slot.
 * @param {number} options.interval Seconds the user asked for between rounds.
 * @param {number} options.maxPerMinute Ceiling on calls, whatever the interval.
 * @param {(repo: object) => void} options.onUpdate Called after each answer.
 */
function createPoller({ repos, interval, maxPerMinute, onUpdate }) {
    let timer = null;
    let stopped = false;
    let index = 0;
    let effective = interval;

    /**
     * The interval actually used: the one asked for, unless that many
     * repositories at that rate would exceed the per-minute budget.
     */
    /** Repositories still worth asking about — GitHub ones we have not given up on. */
    const rotation = () => repos().filter((repo) => pollable(repo) && !repo.pr.giveUp);

    const effectiveInterval = () => {
        const count = rotation().length;
        if (count === 0) return interval;
        return Math.max(interval, Math.ceil((count * 60) / maxPerMinute));
    };

    const step = async () => {
        if (stopped) return;

        const targets = rotation();
        effective = effectiveInterval();

        if (targets.length > 0) {
            if (index >= targets.length) index = 0;
            const repo = targets[index];
            index++;

            const result = await openPullRequests(repo);
            if (stopped) return;

            if (result.ok) {
                repo.pr.failures = 0;
                repo.pr.unknown = false;
                const numbers = new Set(result.numbers);
                // The first answer is the baseline: only what shows up after
                // repo-master started counts as a new pull request.
                if (!repo.pr.baseline) repo.pr.baseline = numbers;
                repo.pr.hasNew = [...numbers].some((number) => !repo.pr.baseline.has(number));
                repo.pr.numbers = numbers;
                repo.pr.count = numbers.size;
            } else {
                repo.pr.failures++;
                repo.pr.reason = result.reason;
                if (repo.pr.failures >= MAX_FAILURES) {
                    repo.pr.unknown = true;
                    repo.pr.giveUp = true;
                }
            }
            onUpdate(repo);
        }

        const slots = Math.max(1, rotation().length);
        timer = setTimeout(step, Math.max(250, (effective * 1000) / slots));
    };

    return {
        start() {
            if (timer || stopped) return;
            timer = setTimeout(step, 0);
        },
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
        /** What the header reports, which is not always what was asked for. */
        interval: () => effective,
        stretched: () => effective > interval,
    };
}

module.exports = { available, openPullRequests, pollable, createPoller };
