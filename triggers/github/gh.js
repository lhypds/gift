// The webhook on GitHub's side, through the `gh` CLI.
//
// A hook in hooks.json is only half of a GitHub trigger: GitHub also has to be
// told where to deliver. `gift create` offers to do that here, and then asks
// GitHub to confirm it — `gh api --method POST` exiting 0 is gh's word for it,
// and a local hook GitHub never calls looks exactly like a working one.
// `gift delete` takes the webhook away again the same way, and confirms that
// too: a webhook that outlives its hook keeps delivering to a server that
// answers 'No match', which is a quiet way to never notice it is still there.
'use strict';

const { spawnSync } = require('node:child_process');

/**
 * Pull the owner and repository out of whatever the user pasted: `owner`,
 * `owner/repo`, an HTTPS URL, or an SSH remote.
 */
function parseRepo(text) {
    let value = String(text).trim();
    value = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, ''); // https://
    value = value.replace(/^[^@/\s]+@([^:/\s]+):/, ''); // git@github.com:
    value = value.replace(/\.git$/i, '');
    value = value.replace(/^\/+|\/+$/g, '');

    const parts = value.split('/').filter(Boolean);
    // A first segment with a dot in it is the host, not the owner.
    if (parts.length > 1 && parts[0].includes('.')) parts.shift();

    return { owner: parts[0] || '', name: parts[1] || '' };
}

function webhookUrlProblem(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return 'Type the complete public URL, including https://.';
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'The webhook URL must use http:// or https://.';
    if (parsed.username || parsed.password) return 'Do not put credentials in the webhook URL.';
    return null;
}

/** What gh said went wrong: its first line of stderr, or why it never ran. */
function ghProblem(result, fallback) {
    if (result.error) {
        return result.error.code === 'ENOENT' ? 'gh is not installed' : result.error.message;
    }
    const said = String(result.stderr || '').trim().split('\n').find(Boolean);
    return said || fallback;
}

/**
 * Whether gh can act on the user's behalf, as a message or null when it can.
 * Checked before offering the remote webhook: an installed but signed-out gh is
 * the ordinary reason a hook lands in hooks.json while GitHub never hears of it,
 * and finding that out afterwards is finding it out too late.
 */
function ghAuthProblem(run = spawnSync) {
    const result = run('gh', ['auth', 'status'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (!result.error && result.status === 0) return null;
    return ghProblem(result, 'gh is not signed in — run: gh auth login');
}

/** Create a repository webhook without ever placing its secret on the command line. */
function createGitHubWebhook(repo, url, events, secret, run = spawnSync) {
    const body = JSON.stringify({
        name: 'web',
        active: true,
        events,
        config: {
            url,
            content_type: 'json',
            secret,
            insecure_ssl: '0',
        },
    });
    const result = run(
        'gh',
        [
            'api',
            '--method', 'POST',
            `repos/${repo}/hooks`,
            '--header', 'Accept: application/vnd.github+json',
            '--input', '-',
            '--silent',
        ],
        { input: body, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );

    if (!result.error && result.status === 0) return { ok: true };
    return { ok: false, message: ghProblem(result, `gh api exited ${result.status}`) };
}

/** The webhooks GitHub currently lists for the repository, as gh reports them. */
function readGitHubWebhooks(repo, run = spawnSync) {
    const result = run(
        'gh',
        [
            'api',
            `repos/${repo}/hooks`,
            '--header', 'Accept: application/vnd.github+json',
            '--paginate',
        ],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0) {
        return { ok: false, message: ghProblem(result, `gh api exited ${result.status}`) };
    }

    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        return { ok: false, message: 'gh api returned something other than JSON' };
    }
    if (!Array.isArray(parsed)) return { ok: false, message: 'gh api did not return a list of webhooks' };
    return { ok: true, hooks: parsed };
}

/**
 * The webhook in a list that delivers to the URL, or undefined. GitHub refuses
 * a second webhook on the same URL as a duplicate, so there is at most one.
 */
function webhookDeliveringTo(hooks, url) {
    return hooks.find((item) => item && item.config && item.config.url === url);
}

/**
 * Ask GitHub whether the webhook is really there, matching on the delivery URL.
 * This is GitHub's word rather than gh's — and it is also what tells a webhook
 * that failed to appear from one that was already there before gift asked,
 * which GitHub refuses as a duplicate.
 */
function verifyGitHubWebhook(repo, url, run = spawnSync) {
    const listed = readGitHubWebhooks(repo, run);
    if (!listed.ok) {
        return { ok: false, message: `the repository's webhooks could not be read: ${listed.message}` };
    }

    const match = webhookDeliveringTo(listed.hooks, url);
    if (!match) return { ok: false, message: `GitHub lists no webhook delivering to ${url}` };
    return {
        ok: true,
        id: match.id,
        active: match.active !== false,
        events: Array.isArray(match.events) ? match.events : [],
    };
}

/** Delete one repository webhook, by the id GitHub gave it. */
function deleteGitHubWebhook(repo, id, run = spawnSync) {
    const result = run(
        'gh',
        [
            'api',
            '--method', 'DELETE',
            `repos/${repo}/hooks/${id}`,
            '--header', 'Accept: application/vnd.github+json',
            '--silent',
        ],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );

    if (!result.error && result.status === 0) return { ok: true };
    return { ok: false, message: ghProblem(result, `gh api exited ${result.status}`) };
}

/**
 * Ask GitHub whether the webhook is really gone. The counterpart of
 * verifyGitHubWebhook: a DELETE that reported failure may still have landed,
 * and one that reported success is still gh's word rather than GitHub's.
 */
function verifyGitHubWebhookGone(repo, id, run = spawnSync) {
    const listed = readGitHubWebhooks(repo, run);
    if (!listed.ok) {
        return { ok: false, message: `the repository's webhooks could not be read: ${listed.message}` };
    }

    const still = listed.hooks.find((item) => item && String(item.id) === String(id));
    if (still) return { ok: false, message: `GitHub still lists webhook ${id}` };
    return { ok: true };
}

module.exports = {
    parseRepo,
    webhookUrlProblem,
    ghAuthProblem,
    createGitHubWebhook,
    readGitHubWebhooks,
    webhookDeliveringTo,
    verifyGitHubWebhook,
    deleteGitHubWebhook,
    verifyGitHubWebhookGone,
};
