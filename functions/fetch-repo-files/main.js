#!/usr/bin/env node
// fetch-repo-files — take a folder or a single file out of a GitHub repository
// and put it in the current directory.
//
// Nothing is cloned and no .git folder is left behind: a folder arrives as a
// plain folder next to you, a file as a plain file. The URL is whatever the
// browser is showing — the repository itself, a folder under /tree/, a file
// under /blob/, a raw.githubusercontent.com link — or the short form, the path
// written straight after the repository name. Without --branch it is the
// repository's default branch that is read.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const NAME = 'fetch-repo-files';
const API = 'https://api.github.com';

/** The environment variables a token is looked for in, in this order. */
const TOKEN_NAMES = ['GIFT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

function usage() {
    console.log(`Usage: gift fetch-repo-files [options] <url>

Copy a folder, or a single file, out of a GitHub repository into the current
directory. Nothing is cloned: the folder arrives as a plain folder, the file as
a plain file, with no .git in either.

The URL is the one the browser shows — the repository, a /tree/ folder, a
/blob/ file, a raw.githubusercontent.com link — or the short form, the path
written straight after the repository name.

Options:
  -f, --file           Fetch one file rather than a folder
  -b, --branch NAME    Branch, tag or commit to read   (default: the repository's default branch)
  -o, --out DIR        Folder to put it in             (default: the current directory)
      --force          Overwrite what is already there
  -n, --dry-run        Say what would be fetched, and where, without fetching it
  -h, --help           Show this help

Examples:
  gift fetch-repo-files https://github.com/lhypds/ai
  gift fetch-repo-files --file https://github.com/lhypds/ai/a.txt
  gift fetch-repo-files --branch dev https://github.com/lhypds/ai
  gift fetch-repo-files https://github.com/lhypds/ai/tree/main/src

A private repository needs a token: \`token\` under functions.fetch-repo-files in
config.json, GITHUB_TOKEN or GH_TOKEN in the environment, or a signed-in \`gh\`,
which is asked last. A public one needs nothing.`);
}

/** A leading `~` is a literal character until something expands it. */
function expandHome(value) {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
}

function parseArgs(argv, env = {}) {
    const options = {
        url: '',
        file: false,
        branch: '',
        out: env.GIFT_FETCH_OUT || '',
        force: false,
        dryRun: false,
        help: false,
        error: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];

        // `--branch dev` and `--branch=dev` are the same thing; a flag left
        // without its value is worth saying so rather than reading the URL as
        // one.
        const value = (name) => {
            const next = argv[++i];
            if (next === undefined) {
                options.error = `${name} needs a value`;
                return '';
            }
            return next;
        };

        if (argument === '-h' || argument === '--help') options.help = true;
        else if (argument === '-f' || argument === '--file') options.file = true;
        else if (argument === '--force') options.force = true;
        else if (argument === '-n' || argument === '--dry-run') options.dryRun = true;
        else if (argument === '-b' || argument === '--branch') options.branch = value(argument);
        else if (argument.startsWith('--branch=')) options.branch = argument.slice(9);
        else if (argument === '-o' || argument === '--out') options.out = value(argument);
        else if (argument.startsWith('--out=')) options.out = argument.slice(6);
        else if (argument.startsWith('-') && argument !== '-') options.error = `unknown option: ${argument}`;
        else if (!options.url) options.url = argument;
        else options.error = `one URL at a time — also given: ${argument}`;
    }

    return options;
}

/**
 * Read a GitHub URL into the repository it names and whatever comes after it.
 *
 *     https://github.com/owner/repo
 *     https://github.com/owner/repo/tree/BRANCH/some/folder
 *     https://github.com/owner/repo/blob/BRANCH/some/file.txt
 *     https://raw.githubusercontent.com/owner/repo/BRANCH/some/file.txt
 *     github.com/owner/repo/some/file.txt        the short form
 *     owner/repo/some/file.txt                   the shorter one
 *     git@github.com:owner/repo.git
 *
 * A /tree/ or /blob/ URL runs the branch and the path together with no way to
 * tell where one ends — `tree/main/src` and `tree/feature/api` read alike — so
 * that part is handed on as `tail` for resolveSplit() to settle. A path hung
 * straight off the repository has no branch in it and needs none.
 *
 * @returns {{owner: string, repo: string, kind: 'file'|'dir'|null,
 *   tail: string[]|null, subpath: string}|null} null if it names no repository.
 */
function parseTarget(input) {
    let text = String(input).trim();
    if (!text) return null;

    text = text.split(/[?#]/)[0]; // ?tab=readme-ov-file, #L20
    text = text.replace(/^git@github\.com:/i, 'github.com/');
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    text = text.replace(/^www\./i, '');
    text = text.replace(/^\/+|\/+$/g, '');

    // A host is only there when the first segment holds a dot: GitHub accounts
    // are letters, digits and hyphens, so `owner/repo` cannot be mistaken for one.
    let host = 'github.com';
    const slash = text.indexOf('/');
    const first = slash === -1 ? text : text.slice(0, slash);
    if (first.includes('.')) {
        host = first.toLowerCase();
        text = slash === -1 ? '' : text.slice(slash + 1);
    }
    if (host !== 'github.com' && host !== 'raw.githubusercontent.com') return null;

    const parts = text.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const [owner, name, ...rest] = parts;
    const repo = name.replace(/\.git$/i, '');

    // Every raw link is a file, and everything after the repository is branch
    // and path run together.
    if (host === 'raw.githubusercontent.com') {
        return { owner, repo, kind: 'file', tail: rest, subpath: '' };
    }

    const [marker, ...tail] = rest;
    if (marker === 'tree') return { owner, repo, kind: 'dir', tail, subpath: '' };
    if (marker === 'blob' || marker === 'raw') return { owner, repo, kind: 'file', tail, subpath: '' };
    return { owner, repo, kind: null, tail: null, subpath: rest.join('/') };
}

/**
 * A token, if there is one to be had: the configured one first, then the usual
 * environment variables, then whatever `gh` is signed in with. A public
 * repository needs none — a token buys a private one, and 5000 requests an hour
 * rather than 60.
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

/** A path or a ref keeps its slashes; everything else in it is escaped. */
function encodeSegments(value) {
    return value
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function request(url, { token = '', accept = 'application/vnd.github+json' } = {}) {
    const headers = {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `gift/${process.env.GIFT_VERSION || 'dev'}`,
    };
    // The tarball is a redirect to codeload with a signed URL of its own, and
    // fetch drops this header on the way there, which is what should happen.
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
            : 'GitHub allows 60 requests an hour without a token; set one up (see `gift help fetch-repo-files`) or try again later';
    }
    return message || `HTTP ${response.status}`;
}

/** The branch a repository hands out when nobody asks for one. */
async function defaultBranch(owner, repo, token) {
    const response = await request(`${API}/repos/${owner}/${repo}`, { token });

    if (response.status === 404) {
        const hint = token ? '' : ' — a private one needs a token, see `gift help fetch-repo-files`';
        throw new Error(`repository not found: ${owner}/${repo}${hint}`);
    }
    if (!response.ok) return ''; // rate limited or offline: GitHub still knows its own default
    const body = await response.json();
    return body.default_branch || '';
}

/**
 * Split a /tree/ or /blob/ tail into the branch and the path inside it. One
 * segment is nearly always the branch — `tree/main/src` — but a branch may hold
 * slashes, and only GitHub can say whether `feature/api` is one branch or a
 * branch and a folder. So the splits are tried shortest first and the one that
 * names a real commit wins; each try costs a request that answers with a single
 * SHA. With one segment there is nothing to ask about.
 */
async function resolveSplit(owner, repo, tail, token) {
    const splits = tail.map((_, index) => ({
        ref: tail.slice(0, index + 1).join('/'),
        path: tail.slice(index + 1).join('/'),
    }));
    if (splits.length <= 1) return splits[0] || { ref: '', path: '' };

    for (const split of splits) {
        const response = await request(`${API}/repos/${owner}/${repo}/commits/${encodeSegments(split.ref)}`, {
            token,
            accept: 'application/vnd.github.sha',
        });
        await response.arrayBuffer().catch(() => {}); // read it out, whatever it says
        if (response.ok) return split;
    }

    // Nothing answered — the plain reading goes on to report the real error.
    return splits[0];
}

/**
 * With --branch given, the branch in the URL is being replaced, but its
 * segments are still sitting in front of the path. They come off: the given
 * branch's segments where the URL starts with them, one segment otherwise.
 */
function pathAfterRef(tail, branch) {
    const wanted = branch.split('/').filter(Boolean);
    const matches = wanted.length > 0 && wanted.every((segment, index) => tail[index] === segment);
    return tail.slice(matches ? wanted.length : 1).join('/');
}

async function download(url, file, token, notFound = '') {
    const response = await request(url, { token });
    // The tarball answers a bad ref with a bare 404 and nothing to read, so the
    // caller's own words are better than the status.
    if (response.status === 404 && notFound) throw new Error(notFound);
    if (!response.ok) throw new Error(await describe(response, token));
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
}

/** Unpack a GitHub tarball, dropping the `repo-<sha>` folder it wraps everything in. */
function extract(archive, into) {
    const result = spawnSync('tar', ['-xzf', archive, '-C', into, '--strip-components=1'], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    if (result.error) {
        if (result.error.code === 'ENOENT') throw new Error('tar is needed to unpack the download, and is not installed');
        throw new Error(`tar: ${result.error.message}`);
    }
    if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr).trim() || `exit ${result.status}`}`);
}

function countFiles(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
        else total += 1;
    }
    return total;
}

function bytes(size) {
    if (size < 1024) return `${size} bytes`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** One file, straight out of the contents API so the branch is a parameter rather than a guess. */
async function takeFile({ owner, repo, ref, subpath, destination, token }) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const response = await request(`${API}/repos/${owner}/${repo}/contents/${encodeSegments(subpath)}${query}`, {
        token,
        accept: 'application/vnd.github.raw',
    });

    if (response.status === 404) {
        throw new Error(`no such file in ${owner}/${repo}${ref ? `@${ref}` : ''}: ${subpath}`);
    }
    if (!response.ok) throw new Error(await describe(response, token));

    // Asked for a folder, the contents API answers with a listing rather than a
    // file, whatever it was asked to answer in.
    if ((response.headers.get('content-type') || '').includes('json')) {
        throw new Error(`${subpath} is a folder — leave --file off to fetch the whole of it`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(destination, body);
    console.log(`Fetched ${subpath || path.basename(destination)} — ${bytes(body.length)}`);
}

/**
 * A folder, out of the repository's tarball: one download rather than a request
 * per file, and it is the only way to read a folder whole. What is wanted is
 * copied out of it and the rest is thrown away.
 */
async function takeFolder({ owner, repo, ref, subpath, destination, force, token }) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-fetch-'));

    try {
        const archive = path.join(temporary, 'repo.tar.gz');
        const unpacked = path.join(temporary, 'repo');
        fs.mkdirSync(unpacked);

        console.log('Downloading…');
        await download(
            `${API}/repos/${owner}/${repo}/tarball${ref ? `/${encodeSegments(ref)}` : ''}`,
            archive,
            token,
            ref
                ? `no branch, tag or commit '${ref}' in ${owner}/${repo} — or no such repository`
                : `repository not found: ${owner}/${repo}`,
        );
        extract(archive, unpacked);

        const source = subpath ? path.resolve(unpacked, subpath) : unpacked;
        // A path out of a URL is not to be trusted with `..`.
        if (source !== unpacked && !source.startsWith(`${unpacked}${path.sep}`)) {
            throw new Error(`${subpath} leads outside the repository`);
        }
        if (!fs.existsSync(source)) {
            throw new Error(`no such path in ${owner}/${repo}${ref ? `@${ref}` : ''}: ${subpath}`);
        }

        // The URL pointed at a file after all — no --file, no /blob/, just a
        // path that turned out to name one. It is still what was asked for.
        if (fs.statSync(source).isFile()) {
            fs.copyFileSync(source, destination);
            console.log(`Fetched ${subpath} — ${bytes(fs.statSync(destination).size)}`);
            console.log('(It is a file: --file fetches one without downloading the whole repository.)');
            return;
        }

        const files = countFiles(source);
        fs.cpSync(source, destination, { recursive: true, force, errorOnExist: !force });
        console.log(`Fetched ${files} ${files === 1 ? 'file' : 'files'}.`);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

async function main(argv) {
    const options = parseArgs(argv, process.env);
    if (options.help) {
        usage();
        return 0;
    }
    if (options.error) {
        console.error(`${NAME}: ${options.error}`);
        console.error('Run `gift fetch-repo-files --help` for the options.');
        return 2;
    }
    if (!options.url) {
        console.error(`${NAME}: give it a GitHub URL to fetch.`);
        console.error('Run `gift fetch-repo-files --help` for the options.');
        return 2;
    }

    const target = parseTarget(options.url);
    if (!target) {
        console.error(`${NAME}: '${options.url}' does not name a GitHub repository.`);
        console.error('Expected something like https://github.com/owner/repo/tree/main/src');
        return 2;
    }

    const token = findToken();

    // Which branch, and which path inside it. A /tree/ or /blob/ URL carries
    // both run together; anything else carries only a path, and the branch is
    // the one asked for or the repository's own.
    let ref = options.branch;
    let subpath = target.subpath;

    if (target.tail) {
        if (ref) {
            subpath = pathAfterRef(target.tail, ref);
        } else {
            const split = await resolveSplit(target.owner, target.repo, target.tail, token);
            ref = split.ref;
            subpath = split.path;
        }
    }

    let branchLabel = ref;
    if (!ref) {
        ref = await defaultBranch(target.owner, target.repo, token);
        branchLabel = ref ? `${ref} (default)` : 'the default branch';
    }

    const wantFile = options.file || target.kind === 'file';
    if (wantFile && !subpath) {
        console.error(`${NAME}: --file needs a path to a file, not just a repository.`);
        return 2;
    }

    const outDir = path.resolve(expandHome(options.out || '.'));
    const destination = path.join(outDir, subpath ? path.basename(subpath) : target.repo);

    console.log(`Repository:  ${target.owner}/${target.repo}`);
    console.log(`Branch:      ${branchLabel}`);
    console.log(`Path:        ${subpath || '(the whole repository)'}`);
    console.log(`Destination: ${destination}`);

    if (options.dryRun) {
        console.log('Dry run — nothing was written.');
        return 0;
    }

    if (fs.existsSync(destination) && !options.force) {
        console.error(`${NAME}: ${destination} is already there — pass --force to write over it.`);
        return 1;
    }

    fs.mkdirSync(outDir, { recursive: true });

    if (wantFile) {
        await takeFile({ owner: target.owner, repo: target.repo, ref, subpath, destination, token });
    } else {
        await takeFolder({
            owner: target.owner,
            repo: target.repo,
            ref,
            subpath,
            destination,
            force: options.force,
            token,
        });
    }

    console.log(`Saved to ${destination}`);
    return 0;
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

module.exports = { main, parseArgs, parseTarget, pathAfterRef };
