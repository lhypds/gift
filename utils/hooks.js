// The implementation shared by the top-level hook-management commands.
//
//   gift list            show what is configured
//   gift create          add one, asking for the repository, name, script and cwd
//   gift delete [name]   remove one
//
// All three work on hooks.json — the file `gift serve` reads at startup
// (--config=FILE, or GIFT_SERVE_CONFIG, points them somewhere else). The server
// only reads it when it starts, so create and delete restart the server after
// writing a change. What the server then writes is read by `gift log`.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT } = require('../functions.js');
const { ask } = require('./pick.js');
const { SERVER_DIR } = require('./service.js');

const DEFAULT_CONFIG = path.join(SERVER_DIR, 'hooks.json');

// What a freshly created hooks.json is seeded with — the same defaults the
// server falls back to, written out so the file is a complete picture.
const DEFAULT_SETTINGS = {
    host: '127.0.0.1',
    port: 3999,
    path: '/hooks/github',
    log: 'hooks.log',
};

const DEFAULT_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';
const WEBHOOK_URL_ENV = 'GIFT_WEBHOOK_URL';

// What the branch question takes when the user just presses Enter: the server
// matches any name in the list, so offering both spellings of the default branch
// covers the common case without the user having to know which one the repo uses.
const DEFAULT_BRANCHES = ['main', 'master'];

const VALID_REPO_PART = /^[A-Za-z0-9._-]+$/;
const VALID_HOOK_NAME = /^[A-Za-z0-9._-]+$/;
// Branch names are git refs, so slashes belong in them — release/1.2 is one name.
const VALID_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

// -------------------------------------------------------------------- paths ---

/** Shorten a path for printing: relative to the repo when it is inside it. */
function show(target) {
    const inside = path.relative(ROOT, target);
    return inside && !inside.startsWith('..') ? inside : target;
}

function expandHome(target) {
    if (target === '~') return os.homedir();
    return target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
}

/** Resolve a path the user typed: `~` expanded, relative to where they stand. */
function resolveTyped(target) {
    return path.resolve(process.cwd(), expandHome(target));
}

function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/**
 * What is worth saying about a hook's script — the same two things the server
 * warns about at startup, so they surface before a delivery arrives.
 */
function scriptNotes(run) {
    if (!fs.existsSync(run)) return [`no file at ${run} yet`];
    try {
        fs.accessSync(run, fs.constants.X_OK);
    } catch {
        return [`${run} is not executable — chmod +x it`];
    }
    return [];
}

// ------------------------------------------------------------------- config ---

/**
 * Read hooks.json as it is written, without normalising anything: what is read
 * here is written back, so editing one hook leaves the rest of the file alone.
 *
 * @returns {{config: object, missing: boolean}}
 */
function readConfig(file) {
    if (!fs.existsSync(file)) {
        return { config: { ...DEFAULT_SETTINGS, hooks: [] }, missing: true };
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`${show(file)}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${show(file)}: expected a JSON object`);
    }
    if (parsed.hooks === undefined) parsed.hooks = [];
    if (!Array.isArray(parsed.hooks)) throw new Error(`${show(file)}: "hooks" is not an array`);

    return { config: parsed, missing: false };
}

function isPrimitive(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * JSON in the shape hooks.json is written by hand: a two-space indent, with
 * arrays of plain values kept on one line — `"events": ["push"]` — so a hook
 * stays readable as a block. JSON.stringify would break every array open.
 */
function stringify(value, indent = '') {
    if (Array.isArray(value)) {
        if (value.every(isPrimitive)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
        const inner = `${indent}  `;
        const items = value.map((v) => inner + stringify(v, inner));
        return `[\n${items.join(',\n')}\n${indent}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (entries.length === 0) return '{}';
        const inner = `${indent}  `;
        const lines = entries.map(([key, v]) => `${inner}${JSON.stringify(key)}: ${stringify(v, inner)}`);
        return `{\n${lines.join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(value);
}

/** Write the config through a temporary file, so a failure cannot truncate it. */
function writeConfig(file, config) {
    let mode = 0o644;
    try {
        mode = fs.statSync(file).mode & 0o777;
    } catch {
        /* new file — keep the default */
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${stringify(config)}\n`, { mode });
    fs.renameSync(temp, file);
}

function configFile(options) {
    return path.resolve(options.config || process.env.GIFT_SERVE_CONFIG || DEFAULT_CONFIG);
}

/** Restart the PM2 process after hooks.json changes, using the normal start path. */
function restartServer(run = spawnSync) {
    const script = path.join(SERVER_DIR, 'start.sh');
    const result = run('bash', [script], { cwd: SERVER_DIR, stdio: 'inherit' });

    if (result.error) {
        return { ok: false, message: result.error.code === 'ENOENT' ? 'bash is not installed' : result.error.message };
    }
    if (result.status !== 0) {
        return { ok: false, message: `start.sh exited ${result.status === null ? 'without a status' : result.status}` };
    }
    return { ok: true };
}

// --------------------------------------------------------------- GitHub CLI ---

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
function createGitHubWebhook(repo, url, hook, secret, run = spawnSync) {
    const body = JSON.stringify({
        name: 'web',
        active: true,
        events: hook.events,
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
 * Ask GitHub whether the webhook is really there, matching on the delivery URL.
 * `gh api --method POST` exiting 0 is gh's word for it; this is GitHub's — and it
 * is also what tells a webhook that failed to appear from one that was already
 * there before gift asked, which GitHub refuses as a duplicate.
 */
function verifyGitHubWebhook(repo, url, run = spawnSync) {
    const listed = readGitHubWebhooks(repo, run);
    if (!listed.ok) {
        return { ok: false, message: `the repository's webhooks could not be read: ${listed.message}` };
    }

    const match = listed.hooks.find((item) => item && item.config && item.config.url === url);
    if (!match) return { ok: false, message: `GitHub lists no webhook delivering to ${url}` };
    return {
        ok: true,
        id: match.id,
        active: match.active !== false,
        events: Array.isArray(match.events) ? match.events : [],
    };
}

// ------------------------------------------------------------------- fields ---

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

/**
 * The rows shown for one hook, by `list` and by the confirmation in `create`.
 * `run` and `cwd` are resolved against the project root — where the server resolves
 * them from, wherever the configuration file itself is.
 */
function describe(hook) {
    const events = Array.isArray(hook.events) && hook.events.length ? hook.events : ['push'];
    const branches = Array.isArray(hook.branches) ? hook.branches : [];
    const run = hook.run ? path.resolve(SERVER_DIR, expandHome(String(hook.run))) : '';

    const rows = [
        ['repo', hook.repo || '*'],
        ['events', events.join(', ')],
        ['branches', branches.length ? branches.join(', ') : 'any'],
        ['run', run ? show(run) : '(none — this hook cannot run)'],
    ];
    if (Array.isArray(hook.args) && hook.args.length) {
        // Quoted the way it would be typed, so an argument with a space in it
        // does not read as two.
        rows.push(['args', hook.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')]);
    }
    rows.push([
        'cwd',
        hook.cwd
            ? show(path.resolve(SERVER_DIR, expandHome(String(hook.cwd))))
            : run
                ? `${show(path.dirname(run))} (the script's folder)`
                : "(the script's folder)",
    ]);
    if (hook.detach) rows.push(['detach', 'yes']);
    if (hook.secretEnv && hook.secretEnv !== DEFAULT_SECRET_ENV) rows.push(['secret', hook.secretEnv]);
    if (run) for (const note of scriptNotes(run)) rows.push(['note', note]);
    return rows;
}

function printRows(rows, indent = '     ') {
    const width = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
        console.log(`${indent}${label.padEnd(width)}  ${value}`);
    }
}

/**
 * Resolve what the user typed to a hook: a position in the list, an exact name,
 * or enough of one — the same rule the rest of the CLI follows.
 *
 * @returns {{status: 'ok', index: number} | {status: 'unknown'}
 *          | {status: 'out-of-range'} | {status: 'ambiguous', matches: string[]}}
 */
function resolveHook(hooks, token) {
    const text = String(token).trim();

    if (/^\d+$/.test(text)) {
        const index = Number(text) - 1;
        if (index < 0 || index >= hooks.length) return { status: 'out-of-range' };
        return { status: 'ok', index };
    }

    const exact = [];
    hooks.forEach((hook, index) => {
        if (String(hook.name) === text) exact.push(index);
    });
    if (exact.length === 1) return { status: 'ok', index: exact[0] };
    if (exact.length > 1) {
        return { status: 'ambiguous', matches: exact.map((i) => String(hooks[i].name)) };
    }

    const matches = [];
    hooks.forEach((hook, index) => {
        if (String(hook.name).startsWith(text)) matches.push(index);
    });
    if (matches.length === 1) return { status: 'ok', index: matches[0] };
    if (matches.length > 1) {
        return { status: 'ambiguous', matches: matches.map((i) => String(hooks[i].name)) };
    }
    return { status: 'unknown' };
}

// ------------------------------------------------------------------ asking ---

/**
 * Ask for one field. Enter takes the default; validate() returns a message to
 * show and ask again, or null to accept. Resolves null if the user gave up.
 */
async function askText(question, { fallback = '', validate } = {}) {
    for (; ;) {
        const answer = await ask(fallback ? `${question} [${fallback}]: ` : `${question}: `);
        if (answer === null) return null;

        const value = answer.trim() || fallback;
        const problem = validate ? validate(value) : null;
        if (problem) {
            console.log(problem);
            continue;
        }
        return value;
    }
}

async function askYesNo(question, fallback) {
    for (; ;) {
        const answer = await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `);
        if (answer === null) return null;

        const value = answer.trim().toLowerCase();
        if (value === '') return fallback;
        if (['y', 'yes'].includes(value)) return true;
        if (['n', 'no'].includes(value)) return false;
        console.log('Answer y or n.');
    }
}

// -------------------------------------------------------------------- list ---

function listHooks(file) {
    const { config, missing } = readConfig(file);
    if (missing) {
        console.error(`gift list: no ${show(file)}`);
        console.error('Run `gift create` to write one.');
        return 1;
    }

    const hooks = config.hooks;
    if (hooks.length === 0) {
        console.log(`${show(file)} configures no hooks.`);
        console.log('Run `gift create` to add one.');
        return 0;
    }

    console.log(`${show(file)}`);
    const numberWidth = String(hooks.length).length;
    hooks.forEach((hook, index) => {
        console.log('');
        console.log(`  ${String(index + 1).padStart(numberWidth)}  ${hook.name || `hook-${index + 1}`}`);
        printRows(describe(hook), `  ${' '.repeat(numberWidth)}    `);
    });

    console.log('');
    const settings = [
        `${config.host || DEFAULT_SETTINGS.host}:${config.port || DEFAULT_SETTINGS.port}`,
        config.path || DEFAULT_SETTINGS.path,
    ].join('');
    console.log(`${hooks.length} hook${hooks.length === 1 ? '' : 's'}, served on ${settings}.`);
    return 0;
}

// ------------------------------------------------------------------ create ---

/** A descriptive unused default name for the new hook. */
function defaultName(repoName, taken) {
    const base = repoName ? `hook-${repoName.toLowerCase()}` : 'hook';
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
}

async function createHook(file) {
    if (!process.stdin.isTTY) {
        console.error('gift create: a terminal is needed to ask for the hook fields.');
        console.error(`Add the hook to ${show(file)} by hand instead.`);
        return 2;
    }

    const { config, missing } = readConfig(file);
    const taken = new Set(config.hooks.map((hook, index) =>
        String(hook.name || `hook-${index + 1}`)
    ));

    console.log(`Adding a hook to ${show(file)}${missing ? ', which will be created' : ''}.`);
    console.log('Five questions about the hook, and for one repository whether to create its');
    console.log('GitHub webhook too. Enter takes the [default], Ctrl-C stops without writing anything.');
    console.log('');

    const cancelled = () => {
        console.log('Nothing was written.');
        return 130;
    };

    // Which repository may trigger it. The server compares `owner/repo` whole,
    // so it is either one repository or `*` — an owner on its own cannot match.
    const repoAnswer = await askText('Repository — owner/repo, * for any', {
        fallback: '*',
        validate: (value) => {
            if (value === '*') return null;
            const parsed = parseRepo(value);
            if (!parsed.owner) return 'Type the repository as owner/repo, or * for any.';
            if (!VALID_REPO_PART.test(parsed.owner)) return `'${parsed.owner}' is not a GitHub owner name.`;
            if (!parsed.name) return `Name the repository too — ${parsed.owner}/something, or * for any.`;
            if (!VALID_REPO_PART.test(parsed.name)) return `'${parsed.name}' is not a repository name.`;
            return null;
        },
    });
    if (repoAnswer === null) return cancelled();

    let repo = '*';
    if (repoAnswer !== '*') {
        const parsed = parseRepo(repoAnswer);
        repo = `${parsed.owner}/${parsed.name}`;
    }

    // Which branches, asked next because it is the other half of the same
    // question: together with the repository it is everything the server checks
    // before running the script. A push to a branch outside the list is a delivery
    // the server answers with 'No match'.
    const branchesAnswer = await askText('Branches — comma separated, * for any', {
        fallback: DEFAULT_BRANCHES.join(', '),
        validate: (value) => branchesProblem(parseBranches(value)),
    });
    if (branchesAnswer === null) return cancelled();
    const branches = parseBranches(branchesAnswer);

    // Whether GitHub is told about the hook is settled here, before the three
    // questions about the script and before anything is written. A `*` hook has no
    // single repository to hang a webhook on, so it is never offered one.
    //
    // Asking first, then checking: gh has to be installed and signed in, and the
    // secret has to be set, or the webhook the user just asked for cannot be made.
    // That is a stop, not a warning — a local hook GitHub never calls looks exactly
    // like a working one, and finding out is worth more than a saved hooks.json.
    let githubUrl = null;
    const secret = process.env[DEFAULT_SECRET_ENV];
    if (repo !== '*') {
        const createRemote = await askYesNo(`Create the GitHub webhook for ${repo} with gh?`, true);
        if (createRemote === null) return cancelled();
        if (createRemote) {
            // ghAuthProblem covers both: a missing gh reports itself as not installed.
            const problem = ghAuthProblem()
                || (secret ? null : `${DEFAULT_SECRET_ENV} is not set, and it is what signs the deliveries`);
            if (problem) {
                console.log('');
                console.error(`gift create: the GitHub webhook for ${repo} cannot be created — ${problem}`);
                console.error('Nothing was written. Fix that and run `gift create` again, or answer n to the');
                console.error("GitHub question and add the webhook under the repository's Settings > Webhooks.");
                return 2;
            }

            const configuredUrl = String(process.env[WEBHOOK_URL_ENV] || '').trim();
            if (configuredUrl && !webhookUrlProblem(configuredUrl)) {
                githubUrl = configuredUrl;
                console.log(`  GitHub webhook URL: ${githubUrl} (from ${WEBHOOK_URL_ENV})`);
            } else {
                if (configuredUrl) console.log(`  note: ${WEBHOOK_URL_ENV} is ignored — ${webhookUrlProblem(configuredUrl)}`);
                githubUrl = await askText(`Public webhook URL for ${repo} — gh will create the remote webhook`, {
                    validate: webhookUrlProblem,
                });
                if (githubUrl === null) return cancelled();
            }
        }
    }

    const name = await askText('Hook name — the label it appears under in the log', {
        fallback: defaultName(repo === '*' ? '' : repo.split('/')[1], taken),
        validate: (value) => {
            if (!VALID_HOOK_NAME.test(value)) return 'Letters, digits, dot, dash and underscore only.';
            if (taken.has(value)) return `A hook named '${value}' already exists — choose a unique name.`;
            return null;
        },
    });
    if (name === null) return cancelled();

    // Absolute only. A relative path would be resolved against wherever the user
    // happens to be standing, which is not what the hook would run months later.
    const runAnswer = await askText('Script to run — an absolute path', {
        validate: (value) => {
            if (!value) return 'A script is needed; it is what the hook runs.';
            if (!path.isAbsolute(expandHome(value))) {
                return 'That path must be absolute, so the hook runs the same script wherever the server was started.';
            }
            return null;
        },
    });
    if (runAnswer === null) return cancelled();
    const run = resolveTyped(runAnswer);
    for (const note of scriptNotes(run)) console.log(`  note: ${note}`);

    const cwdAnswer = await askText('Working directory the script runs in', {
        fallback: path.dirname(run),
    });
    if (cwdAnswer === null) return cancelled();
    const cwd = resolveTyped(cwdAnswer);
    if (!isDirectory(cwd)) console.log(`  note: no directory at ${cwd} yet`);

    // Everything not asked about takes the common answer — a push, no arguments,
    // not detached, the shared secret. Field order matches hooks.example.json, so
    // hand-written and generated hooks read the same way.
    const hook = {
        name,
        repo,
        events: ['push'],
        branches,
        run,
        args: [],
        cwd,
        detach: false,
        secretEnv: DEFAULT_SECRET_ENV,
    };

    config.hooks.push(hook);
    writeConfig(file, config);

    let githubResult = null;
    let confirmed = null;
    if (githubUrl) {
        console.log(`Creating the GitHub webhook for ${repo} with gh...`);
        githubResult = createGitHubWebhook(repo, githubUrl, hook, secret);
        // Asked either way. A POST that reported failure may still have landed,
        // and a webhook GitHub already had is a pass rather than a problem.
        console.log('Confirming it with gh...');
        confirmed = verifyGitHubWebhook(repo, githubUrl);
    }

    console.log('');
    console.log(`Added '${name}' to ${show(file)}.`);
    if (confirmed && confirmed.ok) {
        const events = confirmed.events.length ? confirmed.events.join(', ') : 'no events';
        const active = confirmed.active ? '' : ', inactive';
        console.log(`GitHub confirms webhook ${confirmed.id} on ${repo} — ${githubUrl}, ${events}${active}.`);
        if (!githubResult.ok) {
            console.log(`  note: gh said '${githubResult.message}', but the webhook is there.`);
        }
    } else if (githubResult && githubResult.ok) {
        console.error(`warning: gh created the GitHub webhook, but GitHub does not confirm it: ${confirmed.message}`);
        console.error('         Check the repository settings before relying on the hook.');
    } else if (githubResult) {
        console.error(`warning: the local hook was added, but GitHub was not updated: ${githubResult.message}`);
        console.error('         Check the gh account has Webhooks write access, then add it in the repository settings.');
    }
    console.log('');
    console.log(`  ${name}`);
    printRows(describe(hook), '    ');
    console.log('');
    if (!process.env[DEFAULT_SECRET_ENV]) {
        console.log(`warning: ${DEFAULT_SECRET_ENV} is not set — the server refuses to start without a secret.`);
        console.log(`         Put it in .env, the same value as the webhook's Secret on GitHub.`);
    }
    console.log(`Edit ${show(file)} for anything else — other events or branches, arguments, detach.`);
    console.log('');
    const restartResult = restartServer();
    if (!restartResult.ok) {
        console.error(`gift create: the hook was saved, but the server could not be restarted: ${restartResult.message}`);
    }
    // The webhook counts as created only once GitHub lists it, not when gh says so.
    return (githubResult && !(confirmed && confirmed.ok)) || !restartResult.ok ? 1 : 0;
}

// ------------------------------------------------------------------ delete ---

/** Show the hooks numbered and read a choice; null if the user backs out. */
async function pickHook(hooks) {
    const label = (hook, index) => String(hook.name || `hook-${index + 1}`);
    const numberWidth = String(hooks.length).length;
    const nameWidth = Math.max(...hooks.map((hook, index) => label(hook, index).length));
    const repoWidth = Math.max(...hooks.map((h) => String(h.repo || '*').length));

    console.log('hooks:');
    hooks.forEach((hook, index) => {
        const number = String(index + 1).padStart(numberWidth);
        const events = (Array.isArray(hook.events) && hook.events.length ? hook.events : ['push']).join('|');
        const repo = String(hook.repo || '*').padEnd(repoWidth);
        console.log(`  ${number}  ${label(hook, index).padEnd(nameWidth)}  ${repo}  ${events}`);
    });
    console.log('');

    for (; ;) {
        const answer = await ask(`Delete which hook [1-${hooks.length}], or q to quit: `);
        if (answer === null) return null;

        const token = answer.trim();
        if (token === '' || token === 'q' || token === 'quit') return null;

        const result = resolveHook(hooks, token);
        if (result.status === 'ok') return result.index;
        if (result.status === 'out-of-range') {
            console.log(`There is no ${token} in the list — pick 1 to ${hooks.length}.`);
        } else if (result.status === 'ambiguous') {
            console.log(`'${token}' matches more than one hook — use its list position.`);
        } else {
            console.log(`No hook called '${token}'.`);
        }
    }
}

async function deleteHook(file, options, positionals) {
    const { config, missing } = readConfig(file);
    if (missing) {
        console.error(`gift delete: no ${show(file)}`);
        return 1;
    }
    if (config.hooks.length === 0) {
        console.error(`gift delete: ${show(file)} configures no hooks.`);
        return 1;
    }

    let index;
    if (positionals.length > 0) {
        const token = positionals[0];
        const result = resolveHook(config.hooks, token);
        if (result.status === 'ambiguous') {
            console.error(`gift delete: '${token}' matches more than one hook:`);
            for (const match of result.matches) console.error(`  ${match}`);
            console.error("Use the hook's list position to pick one.");
            return 2;
        }
        if (result.status === 'out-of-range') {
            console.error(`gift delete: there is no hook ${token} — ${show(file)} has ${config.hooks.length}.`);
            return 2;
        }
        if (result.status !== 'ok') {
            console.error(`gift delete: no hook called '${token}' in ${show(file)}`);
            console.error('Run `gift status` to see the configured hooks.');
            return 2;
        }
        index = result.index;
    } else {
        if (!process.stdin.isTTY) {
            console.error('gift delete: a hook name or a terminal is needed.');
            return 2;
        }
        index = await pickHook(config.hooks);
        if (index === null) {
            console.log('Nothing was deleted.');
            return 130;
        }
    }

    const hook = config.hooks[index];
    const name = String(hook.name || `hook-${index + 1}`);

    if (!options.yes) {
        if (!process.stdin.isTTY) {
            console.error('gift delete: nothing to ask on — pass --yes to delete without confirming.');
            return 2;
        }
        console.log('');
        console.log(`  ${name}`);
        printRows(describe(hook), '    ');
        console.log('');
        const confirmed = await askYesNo(`Delete '${name}' from ${show(file)}?`, false);
        if (!confirmed) {
            console.log('Nothing was deleted.');
            return confirmed === null ? 130 : 0;
        }
    }

    config.hooks.splice(index, 1);
    writeConfig(file, config);

    console.log(`Deleted '${name}' from ${show(file)}.`);
    console.log('');
    const restartResult = restartServer();
    if (!restartResult.ok) {
        console.error(`gift delete: the hook was deleted, but the server could not be restarted: ${restartResult.message}`);
        return 1;
    }
    return 0;
}

// ---------------------------------------------------------------- dispatch ---

function createUsage() {
    console.log('usage: gift create [--config=FILE]');
    console.log('');
    console.log('Create a server hook, asking five things: the repository, the branches to');
    console.log('watch, the hook name, the script to run and the working directory it runs in.');
    console.log('');
    console.log(`The rest takes the common answer — a push, no arguments, not detached, the secret`);
    console.log(`in ${DEFAULT_SECRET_ENV}. Edit hooks.json to change them.`);
    console.log('');
    console.log(`For a specific repository, gift asks whether to create its GitHub webhook with gh`);
    console.log(`before the questions about the script. Answering yes needs gh installed and signed`);
    console.log(`in and ${DEFAULT_SECRET_ENV} set: without them nothing is written at all. Set`);
    console.log(`${WEBHOOK_URL_ENV} to the complete public delivery URL, or gift will ask for it.`);
    console.log(`Afterwards gift asks GitHub to confirm the webhook is really there.`);
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: hooks.json)');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('The server is restarted automatically after the hook is created.');
}

function listUsage() {
    console.log('usage: gift list [--config=FILE]');
    console.log('');
    console.log('List the configured server hooks and their settings.');
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: hooks.json)');
    console.log('  -h, --help      Show this help');
}

function deleteUsage() {
    console.log('usage: gift delete [name] [options]');
    console.log('');
    console.log('Delete a server hook by name, unique name prefix, or list position.');
    console.log('For hooks with the same name, use the list position.');
    console.log('With no name, choose from a menu.');
    console.log('');
    console.log('options:');
    console.log('  --config=FILE   Hook configuration file (default: hooks.json)');
    console.log('  -y, --yes       Delete without asking for confirmation');
    console.log('  -h, --help      Show this help');
    console.log('');
    console.log('The server is restarted automatically after the hook is deleted.');
}

function parseArgs(argv, command) {
    const options = { yes: false, help: false };
    const positionals = [];

    for (const arg of argv) {
        if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg === '-y' || arg === '--yes') {
            if (command !== 'delete') throw new Error(`unknown option '${arg}' (try: gift create --help)`);
            options.yes = true;
        } else if (arg.startsWith('--config=')) options.config = arg.slice(9);
        else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}' (try: gift ${command} --help)`);
        else positionals.push(arg);
    }
    return { options, positionals };
}

async function createMain(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv, 'create');
    } catch (err) {
        console.error(`gift create: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        createUsage();
        return 0;
    }
    if (positionals.length > 0) {
        console.error(`gift create: '${positionals[0]}' is not expected — create takes no arguments`);
        return 2;
    }

    try {
        return await createHook(configFile(options));
    } catch (err) {
        console.error(`gift create: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

async function listMain(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv, 'list');
    } catch (err) {
        console.error(`gift list: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        listUsage();
        return 0;
    }
    if (positionals.length > 0) {
        console.error(`gift list: '${positionals[0]}' is not expected — list takes no arguments`);
        return 2;
    }

    try {
        return listHooks(configFile(options));
    } catch (err) {
        console.error(`gift list: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

async function deleteMain(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv, 'delete');
    } catch (err) {
        console.error(`gift delete: ${err.message}`);
        return 2;
    }

    const { options, positionals } = parsed;
    if (options.help) {
        deleteUsage();
        return 0;
    }
    if (positionals.length > 1) {
        console.error(`gift delete: '${positionals[1]}' is not expected — pass at most one hook name`);
        return 2;
    }

    try {
        return await deleteHook(configFile(options), options, positionals);
    } catch (err) {
        console.error(`gift delete: ${err && err.message ? err.message : err}`);
        return 1;
    }
}

module.exports = {
    createMain,
    createUsage,
    deleteMain,
    deleteUsage,
    listMain,
    listUsage,
    // Kept injectable so the gh integration can be verified without network access.
    createGitHubWebhook,
    readGitHubWebhooks,
    verifyGitHubWebhook,
    ghAuthProblem,
    restartServer,
    webhookUrlProblem,
    // Configuration and path helpers shared with `gift log` and `gift status`.
    readConfig,
    configFile,
    show,
    expandHome,
};
