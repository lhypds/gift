#!/usr/bin/env node
// clone-repos — clone every repository an organization has, into one folder.
//
// The organization is typed in — its name, or the URL of its page — and what
// comes back is everything the token can reach: the public repositories, the
// private ones you are a member of, the forks and the archived ones. Each is
// cloned into a folder of its own, side by side. One that is already there is
// left where it is, so the command is worth running again a month later when
// the organization has grown; `--pull` updates those instead of skipping them.
//
// A name that is nobody's organization is tried as a user, and as your own
// account when it is your own login — an account's private repositories are
// listed from a different place than anyone else's.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const NAME = 'clone-repos';
const API = 'https://api.github.com';

/** The environment variables a token is looked for in, in this order. */
const TOKEN_NAMES = ['GIFT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

/** The largest page GitHub hands out, so an organization costs the fewest requests. */
const PER_PAGE = 100;

/** How many clones run at once when nobody says otherwise. */
const DEFAULT_JOBS = 4;

/** A clone of a large repository waits on the network, and sometimes on a lot of it. */
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;

/** How wide the name column grows before long names are simply longer than it. */
const MAX_NAME_COLUMN = 40;

function usage() {
    console.log(`Usage: gift clone-repos [options] [organization]

Clone every repository in a GitHub organization into one folder: the public
ones, the private ones the token can see, the forks and the archived ones.
Without the name on the command line it is asked for.

A repository already cloned is left alone, so running it again picks up
whatever is new.

Options:
  -o, --out DIR        Folder the clones land in        (default: the current directory)
      --ssh            Clone over SSH rather than HTTPS
      --https          Clone over HTTPS                 (the default)
      --no-archived    Leave archived repositories out
      --no-forks       Leave forks out
      --depth N        Shallow clone, N commits deep
  -j, --jobs N         How many clones at a time        (default: ${DEFAULT_JOBS})
      --pull           Update repositories already cloned rather than skipping them
  -n, --dry-run        List what would be cloned, and where, without cloning it
  -h, --help           Show this help

Examples:
  gift clone-repos linktivity
  gift clone-repos --out ~/code/linktivity linktivity
  gift clone-repos --ssh --no-archived linktivity
  gift clone-repos --dry-run https://github.com/linktivity

A private repository needs a token: \`token\` under functions.clone-repos in
config.json, GITHUB_TOKEN or GH_TOKEN in the environment, or a signed-in \`gh\`,
which is asked last. Without one only public repositories are found — and
GitHub allows 60 requests an hour rather than 5000.`);
}

/** A leading `~` is a literal character until something expands it. */
function expandHome(value) {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
}

/** The reverse, so a destination reads as ~/code rather than /Users/me/code. */
function shortenHome(value) {
    const home = os.homedir();
    if (value === home) return '~';
    if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1)}`;
    return value;
}

function parseArgs(argv, env = {}) {
    const configuredJobs = Number(env.GIFT_CLONE_JOBS);

    const options = {
        org: '',
        out: env.GIFT_CLONE_DIR || '',
        protocol: String(env.GIFT_CLONE_PROTOCOL || 'https').toLowerCase(),
        archived: true,
        forks: true,
        depth: 0,
        jobs: Number.isFinite(configuredJobs) && configuredJobs >= 1 ? Math.floor(configuredJobs) : DEFAULT_JOBS,
        pull: false,
        dryRun: false,
        help: false,
        error: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];

        // `--jobs 8` and `--jobs=8` are the same thing; a flag left without its
        // value is worth saying so rather than reading the organization as one.
        const value = (name) => {
            const next = argv[++i];
            if (next === undefined) {
                options.error = `${name} needs a value`;
                return '';
            }
            return next;
        };
        const count = (name, text) => {
            const number = Number(text);
            if (!Number.isInteger(number) || number < 1) {
                options.error = `${name} takes a whole number of at least 1`;
                return 0;
            }
            return number;
        };

        if (argument === '-h' || argument === '--help') options.help = true;
        else if (argument === '--ssh') options.protocol = 'ssh';
        else if (argument === '--https') options.protocol = 'https';
        else if (argument === '--no-archived') options.archived = false;
        else if (argument === '--no-forks') options.forks = false;
        else if (argument === '--pull') options.pull = true;
        else if (argument === '-n' || argument === '--dry-run') options.dryRun = true;
        else if (argument === '-o' || argument === '--out') options.out = value(argument);
        else if (argument.startsWith('--out=')) options.out = argument.slice(6);
        else if (argument === '--depth') options.depth = count(argument, value(argument));
        else if (argument.startsWith('--depth=')) options.depth = count('--depth', argument.slice(8));
        else if (argument === '-j' || argument === '--jobs') options.jobs = count(argument, value(argument)) || options.jobs;
        else if (argument.startsWith('--jobs=')) options.jobs = count('--jobs', argument.slice(7)) || options.jobs;
        else if (argument.startsWith('-') && argument !== '-') options.error = `unknown option: ${argument}`;
        else if (!options.org) options.org = argument;
        else options.error = `one organization at a time — also given: ${argument}`;
    }

    if (!options.error && options.protocol !== 'https' && options.protocol !== 'ssh') {
        options.error = `protocol is https or ssh, not '${options.protocol}'`;
    }

    return options;
}

/**
 * The login inside whatever was typed. A name is a name, but the answer is as
 * likely to be pasted from the browser — `https://github.com/linktivity`, or
 * the repositories tab, which is `/orgs/linktivity/repositories` — and
 * `@linktivity` is how people write one down.
 *
 * @returns {string} The login, or '' if it is not one.
 */
function parseOrg(input) {
    let text = String(input).trim();
    if (!text) return '';

    text = text.split(/[?#]/)[0];
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    text = text.replace(/^(?:www\.)?github\.com\//i, '');
    text = text.replace(/^@/, '');
    text = text.replace(/^\/+|\/+$/g, '');
    text = text.replace(/^orgs\//i, ''); // github.com/orgs/<name>/repositories
    text = text.split('/')[0];

    // A GitHub login is letters, digits and hyphens, no more than 39 of them,
    // and starts and ends with neither a hyphen nor nothing. Anything else came
    // from a URL we did not understand, and is worth saying so about rather than
    // asking GitHub a question it can only answer with 404.
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(text) ? text : '';
}

/**
 * Ask which organization. There is nothing to clone until it is known and it is
 * different every time — an organization is not a setting worth writing down —
 * so it is a question rather than a prompt for a missing argument. Ctrl-C and
 * Ctrl-D answer nothing, and are answered by stopping.
 *
 * @returns {Promise<string|null>} null when the user gave up.
 */
function askForOrg({ input = process.stdin, output = process.stdout } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input, output });

        let done = false;
        const finish = (answer) => {
            if (done) return;
            done = true;
            resolve(answer);
        };
        const giveUp = () => {
            if (done) return;
            output.write('\n');
            finish(null);
        };

        rl.once('SIGINT', giveUp); // Ctrl-C
        rl.once('close', giveUp); // Ctrl-D, or the input running out
        rl.question('Organization: ', (answer) => {
            finish(answer);
            rl.close();
        });
    });
}

/**
 * A token, if there is one to be had: the configured one first, then the usual
 * environment variables, then whatever `gh` is signed in with. Without one only
 * the public repositories are listed, and only 60 requests an hour are allowed.
 */
function findToken() {
    for (const name of TOKEN_NAMES) {
        const value = process.env[name];
        if (value && value.trim()) return value.trim();
    }

    const asked = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (asked.status === 0 && asked.stdout.trim()) return asked.stdout.trim();
    return '';
}

function request(url, token) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `gift/${process.env.GIFT_VERSION || 'dev'}`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { headers });
}

/** Whether an answer means the hourly allowance is spent rather than anything else. */
function rateLimited(response) {
    return (response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0';
}

/** What went wrong, in GitHub's own words where it gave any. */
async function describe(response, token) {
    let message = '';
    try {
        const body = await response.json();
        if (body && body.message) message = body.message;
    } catch {
        /* not JSON, so the status is all there is */
    }

    if (rateLimited(response)) {
        return token
            ? 'GitHub rate limit reached — try again later'
            : 'GitHub allows 60 requests an hour without a token; set one up (see `gift help clone-repos`) or try again later';
    }
    if (response.status === 401) return 'GitHub refused the token — it may have expired';
    return message || `HTTP ${response.status}`;
}

/** The page after this one, out of the Link header GitHub paginates with. */
function nextPage(response) {
    const link = response.headers.get('link');
    if (!link) return '';

    for (const part of link.split(',')) {
        const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
        if (match) return match[1];
    }
    return '';
}

/** Every page of a repository listing, followed to the end. */
async function readAll(url, token) {
    const repos = [];
    let next = url;

    while (next) {
        const response = await request(next, token);
        if (!response.ok) {
            const error = new Error(await describe(response, token));
            error.status = response.status;
            throw error;
        }

        const page = await response.json();
        if (!Array.isArray(page)) throw new Error('GitHub answered with something other than a list of repositories');
        repos.push(...page);
        next = nextPage(response);
    }

    return repos;
}

/** The login the token belongs to, if it belongs to anyone. */
async function whoami(token) {
    if (!token) return '';
    try {
        const response = await request(`${API}/user`, token);
        if (!response.ok) return '';
        const body = await response.json();
        return body && body.login ? body.login : '';
    } catch {
        return ''; // offline, or a token that answers nothing — the caller has other ways
    }
}

/**
 * Everything the token can see under one name.
 *
 * An organization is the usual answer and is tried first, and everything in it
 * counts. A name that is nobody's organization is somebody's account instead,
 * where only what the account owns counts — asked as `type=all`, a user listing
 * also hands back every repository of every organization they belong to, which
 * is somebody else's organization to clone.
 *
 * Which listing depends on whose account: /users/<login>/repos shows only what
 * is public, so your own login is read from /user/repos, which is where an
 * account's private repositories live.
 *
 * @returns {Promise<{kind: 'organization'|'user'|'you', repos: object[]}>}
 */
async function listRepos(org, token) {
    const query = `per_page=${PER_PAGE}&sort=full_name`;

    try {
        return { kind: 'organization', repos: await readAll(`${API}/orgs/${encodeURIComponent(org)}/repos?type=all&${query}`, token) };
    } catch (error) {
        if (error.status !== 404) throw error;
    }

    const login = await whoami(token);
    if (login && login.toLowerCase() === org.toLowerCase()) {
        return { kind: 'you', repos: await readAll(`${API}/user/repos?affiliation=owner&${query}`, token) };
    }

    try {
        return { kind: 'user', repos: await readAll(`${API}/users/${encodeURIComponent(org)}/repos?type=owner&${query}`, token) };
    } catch (error) {
        if (error.status !== 404) throw error;
        const hint = token ? '' : ' — a private one needs a token, see `gift help clone-repos`';
        throw new Error(`no organization or user called '${org}' on GitHub${hint}`);
    }
}

/** The API reports a repository's size in kilobytes. */
function bytes(kilobytes) {
    if (kilobytes < 1024) return `${kilobytes} KB`;
    if (kilobytes < 1024 * 1024) return `${(kilobytes / 1024).toFixed(1)} MB`;
    return `${(kilobytes / 1024 / 1024).toFixed(1)} GB`;
}

function pad(text, columns) {
    return String(text) + ' '.repeat(Math.max(0, columns - String(text).length));
}

/** What is worth saying about a repository beyond its name. */
function labels(repo) {
    const words = [repo.private ? 'private' : 'public'];
    if (repo.fork) words.push('fork');
    if (repo.archived) words.push('archived');
    return words.join(', ');
}

/**
 * A shell script git asks for the password, so that a private repository can be
 * cloned over HTTPS with the token already found rather than a second set of
 * credentials, or a prompt nobody is watching.
 *
 * The token goes to git through the environment rather than the command line,
 * where `ps` would show it, and the helpers are turned off for these clones
 * (`-c credential.helper=`) so that nothing writes it into a keychain: it was
 * borrowed for the run and is gone with the temporary folder.
 */
function makeAskpass(token) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-clone-'));
    const file = path.join(dir, 'askpass.sh');

    // git asks twice, once for each half, and the prompt it passes says which:
    // "Username for 'https://github.com': ", then "Password for ...".
    fs.writeFileSync(
        file,
        `#!/bin/sh
case "$1" in
    Username*) printf '%s\\n' "x-access-token" ;;
    *) printf '%s\\n' "$GIFT_CLONE_TOKEN" ;;
esac
`,
        { mode: 0o700 },
    );

    return { dir, file };
}

/** Run a git command, with its output kept rather than printed over everyone else's. */
function git(args, { cwd, env, timeout = CLONE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => {
            out += chunk;
        });
        child.stderr.on('data', (chunk) => {
            err += chunk;
        });

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            err += '\ntimed out';
        }, timeout);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ ok: false, out, err: error.code === 'ENOENT' ? 'git is not installed' : error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, out, err });
        });
    });
}

/**
 * What git says on its way somewhere rather than about where it ended up:
 * the progress it rewrites over itself, and the stock advice it prints under a
 * refused connection.
 */
const NOISE =
    /^(?:Cloning into|Receiving objects|Resolving deltas|Updating files|Counting objects|Compressing objects|remote: (?:Enumerating|Counting|Compressing|Total|Finding)|Please make sure you have the correct access rights|and the repository exists\.)/i;

/**
 * The one line of git's output worth repeating on a row of its own.
 *
 * The first line that says something is the one that says what happened —
 * `remote: Repository not found.`, `git@github.com: Permission denied
 * (publickey).` — and the last is usually git's own summary of it, which is
 * vaguer: a clone refused for want of a key ends `and the repository exists.`,
 * which is advice rather than a reason.
 */
function reason(text) {
    const lines = String(text)
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);

    const said = lines.filter((line) => !NOISE.test(line));
    return said[0] || lines[lines.length - 1] || '';
}

/** Whether a folder is there and has anything in it — git clones into an empty one happily. */
function occupied(dir) {
    try {
        return fs.readdirSync(dir).length > 0;
    } catch {
        return false; // not there at all
    }
}

/**
 * One repository: cloned, updated, or left alone because it is already here.
 *
 * @returns {Promise<{name: string, status: 'cloned'|'updated'|'skipped'|'failed', detail: string}>}
 */
async function handle(repo, { outDir, protocol, depth, pull, env, prefix }) {
    const destination = path.join(outDir, repo.name);

    // A repository name is a folder name here, and a failed clone is deleted
    // again — so a name that is not one, whatever GitHub let through, is worth
    // refusing rather than resolving to somewhere above the destination.
    if (path.dirname(destination) !== outDir) {
        return { name: repo.name, status: 'failed', detail: 'its name is not a folder name' };
    }

    if (occupied(destination)) {
        if (!pull) return { name: repo.name, status: 'skipped', detail: 'already here' };

        if (!fs.existsSync(path.join(destination, '.git'))) {
            return { name: repo.name, status: 'skipped', detail: 'a folder of that name, but not a repository' };
        }
        const pulled = await git(['-C', destination, 'pull', '--ff-only'], { env });
        return pulled.ok
            ? { name: repo.name, status: 'updated', detail: reason(pulled.out) || 'up to date' }
            : { name: repo.name, status: 'failed', detail: reason(pulled.err) || 'git pull failed' };
    }

    const url = protocol === 'ssh' ? repo.ssh_url : repo.clone_url;
    if (!url) return { name: repo.name, status: 'failed', detail: `GitHub gave no ${protocol} URL for it` };

    const args = [...prefix, 'clone'];
    if (depth) args.push('--depth', String(depth));
    args.push(url, destination);

    const cloned = await git(args, { env });
    if (cloned.ok) return { name: repo.name, status: 'cloned', detail: '' };

    // A clone that died part-way leaves a folder that is not a repository, and
    // the next run would read it as one already here.
    fs.rmSync(destination, { recursive: true, force: true });
    return { name: repo.name, status: 'failed', detail: reason(cloned.err) || 'git clone failed' };
}

/**
 * Run `jobs` of them at a time, in the order they are given, and hand back the
 * results in that same order however they finished.
 */
async function pool(items, jobs, worker) {
    const results = new Array(items.length);
    let next = 0;

    const runner = async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, runner));
    return results;
}

async function main(argv) {
    const options = parseArgs(argv, process.env);
    if (options.help) {
        usage();
        return 0;
    }
    if (options.error) {
        console.error(`${NAME}: ${options.error}`);
        console.error('Run `gift clone-repos --help` for the options.');
        return 2;
    }

    let org = '';
    if (options.org) {
        org = parseOrg(options.org);
        if (!org) {
            console.error(`${NAME}: '${options.org}' does not name a GitHub organization.`);
            console.error('Expected something like `linktivity` or https://github.com/linktivity');
            return 2;
        }
    } else {
        // Nobody is asked who cannot answer — a pipe, a cron job.
        if (!process.stdin.isTTY) {
            console.error(`${NAME}: give it the organization to clone.`);
            console.error('Run `gift clone-repos --help` for the options.');
            return 2;
        }

        console.log('clone-repos clones every repository an organization has into one folder.');
        console.log('');
        for (;;) {
            const answer = await askForOrg();
            if (answer === null) return 130; // Ctrl-C

            org = parseOrg(answer);
            if (org) break;
            console.log(
                answer.trim()
                    ? `'${answer.trim()}' is not a GitHub organization — type its name, or the URL of its page.`
                    : 'Type the name of an organization, or the URL of its page.',
            );
        }
    }

    const token = findToken();
    const outDir = path.resolve(expandHome(options.out || '.'));

    console.log(`Reading ${org}…`);
    const listing = await listRepos(org, token);

    const kept = listing.repos.filter((repo) => (options.archived || !repo.archived) && (options.forks || !repo.fork));
    const left = listing.repos.length - kept.length;

    const counted = (of) => listing.repos.filter(of).length;
    const summary = [
        `${listing.repos.length} ${listing.repos.length === 1 ? 'repository' : 'repositories'}`,
        counted((repo) => repo.private) ? `${counted((repo) => repo.private)} private` : '',
        counted((repo) => repo.fork) ? `${counted((repo) => repo.fork)} forked` : '',
        counted((repo) => repo.archived) ? `${counted((repo) => repo.archived)} archived` : '',
    ].filter(Boolean);

    const what = listing.kind === 'organization' ? 'Organization' : listing.kind === 'you' ? 'Account (yours)' : 'User';
    console.log(`${pad(`${what}:`, 15)}${org}`);
    console.log(`${pad('Found:', 15)}${summary.join(' · ')}${left ? ` — ${left} left out` : ''}`);
    console.log(`${pad('Destination:', 15)}${shortenHome(outDir)}`);
    console.log(`${pad('Protocol:', 15)}${options.protocol}${token ? '' : ' (no token — public repositories only)'}`);
    console.log('');

    if (kept.length === 0) {
        console.log('Nothing to clone.');
        return 0;
    }

    const column = Math.min(MAX_NAME_COLUMN, Math.max(...kept.map((repo) => repo.name.length)));

    if (options.dryRun) {
        for (const repo of kept) {
            const here = occupied(path.join(outDir, repo.name)) ? (options.pull ? ' — already here, would be pulled' : ' — already here, would be skipped') : '';
            console.log(`  ${pad(repo.name, column)}  ${pad(labels(repo), 20)}${pad(bytes(repo.size || 0), 10)}${here}`.trimEnd());
        }
        console.log('');
        console.log('Dry run — nothing was cloned.');
        return 0;
    }

    fs.mkdirSync(outDir, { recursive: true });

    // Over HTTPS the token found above is what git is given, through a helper of
    // its own; over SSH the key already on the machine is what counts, and the
    // token is only what listed the repositories. Either way git is told not to
    // stop for a prompt: with several clones running at once, nobody would know
    // which of them was asking.
    const askpass = options.protocol === 'https' && token ? makeAskpass(token) : null;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (askpass) {
        env.GIT_ASKPASS = askpass.file;
        env.GIFT_CLONE_TOKEN = token;
    }
    const prefix = askpass ? ['-c', 'credential.helper='] : [];

    let done = 0;
    const width = String(kept.length).length;

    try {
        const results = await pool(kept, options.jobs, async (repo) => {
            const result = await handle(repo, {
                outDir,
                protocol: options.protocol,
                depth: options.depth,
                pull: options.pull,
                env,
                prefix,
            });

            done++;
            const detail = result.detail ? ` — ${result.detail}` : '';
            console.log(`  [${String(done).padStart(width)}/${kept.length}] ${pad(result.name, column)}  ${result.status}${detail}`.trimEnd());
            return result;
        });

        const failed = results.filter((result) => result.status === 'failed');
        const count = (status) => results.filter((result) => result.status === status).length;

        console.log('');
        const totals = [
            `${count('cloned')} cloned`,
            options.pull ? `${count('updated')} updated` : '',
            `${count('skipped')} skipped`,
            failed.length ? `${failed.length} failed` : '',
        ].filter(Boolean);
        console.log(`${totals.join(' · ')} — ${shortenHome(outDir)}`);

        if (failed.length) {
            console.log('');
            console.log('Failed:');
            for (const failure of failed) console.log(`  ${pad(failure.name, column)}  ${failure.detail}`);
            return 1;
        }
        return 0;
    } finally {
        if (askpass) fs.rmSync(askpass.dir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error) => {
            console.error(`${NAME}: ${error && error.message ? error.message : error}`);
            process.exit(1);
        });
}

module.exports = { main, parseArgs, parseOrg, listRepos, pool };
