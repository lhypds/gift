// The GitHub trigger — an API endpoint that accepts requests from GitHub.
//
// A webhook delivery arrives, its signature is checked against the shared
// secret, and the hooks whose repository, event and branch all match run their
// script. server_webhooks.js next door is the endpoint itself; this is the trigger
// contract around it — what `gift create` asks, what `gift list` shows, and
// what the server mounts at startup.
'use strict';

const { forTrigger } = require('../../utils/log.js');
const gh = require('./gh.js');
const receiver = require('./server_webhooks.js');

const log = forTrigger('github');

const DEFAULT_SECRET_ENV = receiver.DEFAULT_SECRET_ENV;
const WEBHOOK_URL_ENV = 'GIFT_WEBHOOK_URL';
const DEFAULT_PATH = '/hooks/github';

// What the branch question takes when the user just presses Enter: the server
// matches any name in the list, so offering both spellings of the default branch
// covers the common case without the user having to know which one the repo uses.
const DEFAULT_BRANCHES = ['main', 'master'];

const VALID_REPO_PART = /^[A-Za-z0-9._-]+$/;
// Branch names are git refs, so slashes belong in them — release/1.2 is one name.
const VALID_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * The branch list out of one typed answer. Commas or spaces separate, so
 * `main, master` and `main master` both give two branches, and a name repeated
 * only counts once — the server matches any name in the list.
 */
function parseBranches(text) {
    const branches = [];
    for (const part of String(text).split(/[\s,]+/)) {
        const value = part.trim();
        if (value && !branches.includes(value)) branches.push(value);
    }
    return branches;
}

/**
 * Whether the answer names branches the server could ever match, as a message or
 * null. The server compares whole branch names, so anything git would not accept
 * as one is a branch that never fires — worth catching while it can still be
 * retyped rather than at the first push that goes missing.
 */
function branchesProblem(branches) {
    if (branches.length === 0) return 'Name at least one branch, or * for any.';
    if (branches.includes('*')) {
        return branches.length === 1 ? null : '* already covers every branch — list names, or just *.';
    }
    for (const branch of branches) {
        if (!VALID_BRANCH_NAME.test(branch)) return `'${branch}' is not a branch name.`;
        if (branch.startsWith('/') || branch.endsWith('/')) return `'${branch}' cannot start or end with /.`;
        if (branch.includes('..') || branch.endsWith('.lock')) return `'${branch}' is not a name git allows.`;
    }
    return null;
}

// ----------------------------------------------------------------- contract ---

function normalize(trigger) {
    const repo = trigger.repo ? String(trigger.repo) : '*';
    if (repo !== '*') {
        const parsed = gh.parseRepo(repo);
        if (!parsed.owner || !parsed.name) {
            throw new Error(`has a "repo" that is not owner/repo — '${trigger.repo}'`);
        }
    }

    const events = Array.isArray(trigger.events) && trigger.events.length
        ? trigger.events.map(String)
        : ['push'];
    const branches = Array.isArray(trigger.branches) ? trigger.branches.map(String) : [];
    const problem = branches.length ? branchesProblem(branches) : null;
    if (problem) throw new Error(`has a "branches" the server could never match — ${problem}`);

    return {
        repo,
        events,
        branches,
        secretEnv: trigger.secretEnv ? String(trigger.secretEnv) : DEFAULT_SECRET_ENV,
    };
}

function describe(trigger) {
    const rows = [
        ['repo', trigger.repo],
        ['events', trigger.events.join(', ')],
        ['branches', trigger.branches.length ? trigger.branches.join(', ') : 'any'],
    ];
    if (trigger.secretEnv !== DEFAULT_SECRET_ENV) rows.push(['secret', trigger.secretEnv]);
    return rows;
}

function line(trigger) {
    return `${trigger.repo}  ${trigger.events.join('|')}`;
}

/**
 * The questions `gift create` asks once GitHub is the chosen type.
 *
 * The remote webhook is settled here, before anything is written: gh has to be
 * installed and signed in and the secret has to be set, or the webhook the user
 * just asked for cannot be made. That is a stop, not a warning — a local hook
 * GitHub never calls looks exactly like a working one, and finding out is worth
 * more than a saved hooks.json.
 */
async function ask({ askText, askYesNo }) {
    // Which repository may trigger it. The server compares `owner/repo` whole,
    // so it is either one repository or `*` — an owner on its own cannot match.
    const repoAnswer = await askText('Repository — owner/repo, * for any', {
        fallback: '*',
        validate: (value) => {
            if (value === '*') return null;
            const parsed = gh.parseRepo(value);
            if (!parsed.owner) return 'Type the repository as owner/repo, or * for any.';
            if (!VALID_REPO_PART.test(parsed.owner)) return `'${parsed.owner}' is not a GitHub owner name.`;
            if (!parsed.name) return `Name the repository too — ${parsed.owner}/something, or * for any.`;
            if (!VALID_REPO_PART.test(parsed.name)) return `'${parsed.name}' is not a repository name.`;
            return null;
        },
    });
    if (repoAnswer === null) return null;

    let repo = '*';
    if (repoAnswer !== '*') {
        const parsed = gh.parseRepo(repoAnswer);
        repo = `${parsed.owner}/${parsed.name}`;
    }

    // Asked next because it is the other half of the same question: together
    // with the repository it is everything the server checks before running the
    // script. A push to a branch outside the list is answered with 'No match'.
    const branchesAnswer = await askText('Branches — comma separated, * for any', {
        fallback: DEFAULT_BRANCHES.join(', '),
        validate: (value) => branchesProblem(parseBranches(value)),
    });
    if (branchesAnswer === null) return null;

    const trigger = {
        type: 'github',
        repo,
        events: ['push'],
        branches: parseBranches(branchesAnswer),
        secretEnv: DEFAULT_SECRET_ENV,
    };

    // A `*` hook has no single repository to hang a webhook on, so it is never
    // offered one.
    if (repo === '*') return { trigger, label: repo };

    const createRemote = await askYesNo(`Create the GitHub webhook for ${repo} with gh?`, true);
    if (createRemote === null) return null;
    if (!createRemote) return { trigger, label: repo };

    const secret = process.env[DEFAULT_SECRET_ENV];
    // ghAuthProblem covers both: a missing gh reports itself as not installed.
    const problem = gh.ghAuthProblem()
        || (secret ? null : `${DEFAULT_SECRET_ENV} is not set, and it is what signs the deliveries`);
    if (problem) {
        throw new Error(
            `the GitHub webhook for ${repo} cannot be created — ${problem}\n`
            + 'Nothing was written. Fix that and run `gift create` again, or answer n to the\n'
            + "GitHub question and add the webhook under the repository's Settings > Webhooks."
        );
    }

    let url = String(process.env[WEBHOOK_URL_ENV] || '').trim();
    if (url && !gh.webhookUrlProblem(url)) {
        console.log(`  GitHub webhook URL: ${url} (from ${WEBHOOK_URL_ENV})`);
    } else {
        if (url) console.log(`  note: ${WEBHOOK_URL_ENV} is ignored — ${gh.webhookUrlProblem(url)}`);
        url = await askText(`Public webhook URL for ${repo} — gh will create the remote webhook`, {
            validate: gh.webhookUrlProblem,
        });
        if (url === null) return null;
    }

    return {
        trigger,
        label: repo,
        // Run after the hook has been written, so a failure here leaves a hook
        // that can be pointed at a hand-made webhook rather than nothing at all.
        after() {
            console.log(`Creating the GitHub webhook for ${repo} with gh...`);
            const created = gh.createGitHubWebhook(repo, url, trigger.events, secret);
            // Asked either way. A POST that reported failure may still have
            // landed, and a webhook GitHub already had is a pass rather than a
            // problem.
            console.log('Confirming it with gh...');
            const confirmed = gh.verifyGitHubWebhook(repo, url);

            if (confirmed.ok) {
                const events = confirmed.events.length ? confirmed.events.join(', ') : 'no events';
                const lines = [
                    `GitHub confirms webhook ${confirmed.id} on ${repo} — ${url}, ${events}${confirmed.active ? '' : ', inactive'}.`,
                ];
                if (!created.ok) lines.push(`  note: gh said '${created.message}', but the webhook is there.`);
                return { ok: true, lines, warnings: [] };
            }
            if (created.ok) {
                return {
                    ok: false,
                    lines: [],
                    warnings: [
                        `gh created the GitHub webhook, but GitHub does not confirm it: ${confirmed.message}`,
                        'Check the repository settings before relying on the hook.',
                    ],
                };
            }
            return {
                ok: false,
                lines: [],
                warnings: [
                    `the local hook was added, but GitHub was not updated: ${created.message}`,
                    'Check the gh account has Webhooks write access, then add it in the repository settings.',
                ],
            };
        },
    };
}

/** Anything worth saying once the hook is saved, whatever was asked. */
function afterNotes() {
    if (process.env[DEFAULT_SECRET_ENV]) return [];
    return [
        `warning: ${DEFAULT_SECRET_ENV} is not set — the server refuses GitHub deliveries without a secret.`,
        '         Add it to config.json with `gift config`, the same value as the webhook\'s Secret on GitHub.',
    ];
}

// -------------------------------------------------------------------- serve ---

/**
 * The endpoint, as express middleware. Mounted by the root server before its
 * 404 catch-all, so a delivery on any path still reaches the receiver.
 */
function mount({ hooks, runtime, options, express }) {
    const secrets = receiver.collectSecrets(hooks);
    if (secrets.size === 0) {
        // Not fatal any more: the other three triggers need no secret, and a
        // gift with only a clipboard hook has no reason to refuse to start.
        log('warn', 'no webhook secret configured — GitHub deliveries will all be rejected', {
            hint: 'put github_webhook_secret in config.json (`gift config`), the same value as the webhook Secret on GitHub',
        });
    }
    return {
        secrets,
        middleware: receiver.createReceiver({
            hooks,
            secrets,
            runtime,
            path: options.path || DEFAULT_PATH,
            express,
        }),
    };
}

/**
 * There is nothing to start: the endpoint is already mounted and the listener
 * belongs to the root server. This reports what is watching, so the startup log
 * reads the same for all four triggers.
 */
function start({ hooks, options, secrets }) {
    log('info', `endpoint ${options.path || DEFAULT_PATH}`, {
        hooks: hooks.length,
        secrets: secrets ? receiver.fingerprints(secrets) : undefined,
    });
    return { stop() { /* the listener is the root server's to close */ } };
}

module.exports = {
    name: 'github',
    title: 'GitHub',
    summary: 'An API endpoint that accepts webhook deliveries from GitHub.',
    prompt: 'a push (or another event) arrives from a GitHub repository',
    DEFAULT_PATH,
    DEFAULT_SECRET_ENV,
    normalize,
    describe,
    line,
    ask,
    afterNotes,
    mount,
    start,
    // Re-exported so `gift status` and the tests can reach them without
    // knowing the trigger's file layout.
    gh,
    receiver,
    parseBranches,
    branchesProblem,
};
