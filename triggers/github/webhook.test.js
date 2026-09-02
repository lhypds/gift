// The webhook on GitHub's side: what `gift delete` takes away with gh, and —
// more to the point — when it does not. A repository's webhooks are not all
// gift's, and one webhook feeds every hook on its repository, so the cases
// worth a test are the ones where a delete has to leave it alone.
//
//     node --test triggers/github/webhook.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const github = require('./index.js');
const gh = require('./gh.js');

const URL = 'https://gift.example.com/hooks/github';
const LISTED = [
    { id: 11, config: { url: URL }, events: ['push'], active: true },
    { id: 22, config: { url: 'https://ci.example.com/build' }, events: ['push', 'pull_request'], active: true },
];

// ---------------------------------------------------------------- gh.js ---

test('deleting a webhook is one DELETE, by id', () => {
    const calls = [];
    const run = (command, args) => {
        calls.push([command, ...args]);
        return { status: 0, stdout: '', stderr: '' };
    };

    const result = gh.deleteGitHubWebhook('owner/repo', 123, run);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].slice(0, 5), ['gh', 'api', '--method', 'DELETE', 'repos/owner/repo/hooks/123']);
});

test('gh failing to delete is reported in its own words', () => {
    const run = () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\nmore\n' });

    assert.deepStrictEqual(gh.deleteGitHubWebhook('owner/repo', 123, run), {
        ok: false,
        message: 'gh: Not Found (HTTP 404)',
    });
});

test('GitHub confirms a deletion by no longer listing the id', () => {
    const listing = (hooks) => () => ({ status: 0, stdout: JSON.stringify(hooks), stderr: '' });

    assert.strictEqual(gh.verifyGitHubWebhookGone('owner/repo', 123, listing([{ id: 456 }])).ok, true);

    const still = gh.verifyGitHubWebhookGone('owner/repo', 123, listing([{ id: 123 }, { id: 456 }]));
    assert.strictEqual(still.ok, false);
    assert.match(still.message, /still lists webhook 123/);
});

// ------------------------------------------------------------- askDelete ---

/**
 * `gift delete` for a GitHub hook, with gh answering as told and nothing
 * spawned. Returns what the trigger settled on, what running it reported, the
 * ids gh was asked to delete, and every line printed on the way.
 */
async function deleteWith(t, {
    trigger = { type: 'github', repo: 'owner/repo' },
    others = [],
    yes = false,
    listed = LISTED,
    url = URL,
    authProblem = null,
    deleteResult = { ok: true },
    yesNo = true,
    pick = '',
} = {}) {
    const deleted = [];
    const stubs = {
        ghAuthProblem: () => authProblem,
        readGitHubWebhooks: () => ({ ok: true, hooks: listed.filter((item) => !deleted.includes(item.id)) }),
        deleteGitHubWebhook: (repo, id) => {
            deleted.push(id);
            return deleteResult;
        },
        verifyGitHubWebhookGone: (repo, id) => (
            deleted.includes(id) && deleteResult.ok
                ? { ok: true }
                : { ok: false, message: `GitHub still lists webhook ${id}` }
        ),
    };
    const originals = {};
    for (const [name, stub] of Object.entries(stubs)) {
        originals[name] = gh[name];
        gh[name] = stub;
    }
    const hadUrl = process.env.GIFT_WEBHOOK_URL;
    if (url === null) delete process.env.GIFT_WEBHOOK_URL;
    else process.env.GIFT_WEBHOOK_URL = url;

    const printed = [];
    const out = console.log;
    console.log = (...parts) => printed.push(parts.join(' '));
    t.after(() => {
        console.log = out;
        Object.assign(gh, originals);
        if (hadUrl === undefined) delete process.env.GIFT_WEBHOOK_URL;
        else process.env.GIFT_WEBHOOK_URL = hadUrl;
    });

    const asked = await github.askDelete({
        trigger,
        others,
        yes,
        askText: async () => pick,
        askYesNo: async () => yesNo,
    });
    const result = asked && typeof asked.after === 'function' ? asked.after() : null;
    return { asked, result, deleted, printed };
}

test('a hook on any repository has no webhook to take away', async (t) => {
    const { asked, deleted } = await deleteWith(t, { trigger: { type: 'github', repo: '*' } });

    assert.deepStrictEqual(asked, {});
    assert.deepStrictEqual(deleted, []);
});

test('the webhook is kept while another hook on the repository still receives its deliveries', async (t) => {
    // Spelled differently, as the server would still match it.
    const others = [{ name: 'deploy-too', trigger: { type: 'github', repo: 'Owner/Repo' } }];
    const { result, deleted } = await deleteWith(t, { others });

    assert.deepStrictEqual(deleted, []);
    assert.strictEqual(result.ok, true);
    assert.match(result.lines[0], /kept — 'deploy-too'/);
});

test('a hook on any repository counts as still receiving them', async (t) => {
    const others = [{ name: 'log-everything', trigger: { type: 'github', repo: '*' } }];
    const { result, deleted } = await deleteWith(t, { others });

    assert.deepStrictEqual(deleted, []);
    assert.match(result.lines[0], /kept — 'log-everything'/);
});

test('with --yes, the webhook delivering to webhook_url goes without a question', async (t) => {
    const { result, deleted } = await deleteWith(t, {
        yes: true,
        yesNo: null, // would back out, were it asked
    });

    assert.deepStrictEqual(deleted, [11]);
    assert.strictEqual(result.ok, true);
    assert.match(result.lines[0], /no longer lists webhook 11 on owner\/repo/);
});

test('with --yes and no webhook_url, nothing on GitHub is guessed at', async (t) => {
    const { result, deleted } = await deleteWith(t, { yes: true, url: null });

    assert.deepStrictEqual(deleted, []);
    assert.strictEqual(result.ok, true);
    assert.match(result.lines[0], /GIFT_WEBHOOK_URL is not set/);
});

test("without webhook_url, the repository's webhooks are listed to choose from", async (t) => {
    const { result, deleted, printed } = await deleteWith(t, { url: null, pick: '2' });

    assert.ok(printed.some((line) => line.includes('https://ci.example.com/build')), 'every webhook is shown');
    assert.deepStrictEqual(deleted, [22]);
    assert.strictEqual(result.ok, true);
});

test('a webhook_url GitHub does not list falls back to the list too', async (t) => {
    const { deleted, printed } = await deleteWith(t, { url: 'https://moved.example.com/hooks/github', pick: '1' });

    assert.ok(printed.some((line) => line.includes('lists no webhook on owner/repo delivering to')));
    assert.deepStrictEqual(deleted, [11]);
});

test('q at the list leaves every webhook where it is', async (t) => {
    const { result, deleted } = await deleteWith(t, { url: null, pick: 'q' });

    assert.deepStrictEqual(deleted, []);
    assert.match(result.lines[0], /untouched/);
});

test('answering n keeps the webhook and says where to find it', async (t) => {
    const { result, deleted } = await deleteWith(t, { yesNo: false });

    assert.deepStrictEqual(deleted, []);
    assert.strictEqual(result.ok, true);
    assert.match(result.lines.join('\n'), /Settings > Webhooks/);
});

test('backing out of the webhook question backs out of the delete', async (t) => {
    const { asked, deleted } = await deleteWith(t, { yesNo: null });

    assert.strictEqual(asked, null);
    assert.deepStrictEqual(deleted, []);
});

test('gh signed out leaves the webhook in place, saying so', async (t) => {
    const { result, deleted } = await deleteWith(t, { authProblem: 'gh is not signed in — run: gh auth login' });

    assert.deepStrictEqual(deleted, []);
    assert.strictEqual(result.ok, true);
    assert.match(result.lines[0], /gh is not signed in/);
});

test('a webhook GitHub still lists after the delete is a warning, not a success', async (t) => {
    const { result } = await deleteWith(t, { deleteResult: { ok: false, message: 'gh: Forbidden (HTTP 403)' } });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.lines.length, 0);
    assert.match(result.warnings[0], /webhook 11 on owner\/repo is not: gh: Forbidden \(HTTP 403\)/);
});
