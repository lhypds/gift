// gift's configuration: one file, config.json, in the project folder.
//
//     {
//         "github_webhook_secret": "...",     gift's own settings at the top
//         "port": 3999,
//         "functions": {                      each function's under its name
//             "repo-master": { "repo_root": "/Users/me/projects" },
//             "weekly-prs":  { "repos": "owner/repo", "author": "octocat" }
//         }
//     }
//
// What may go in it is declared by a config.schema.json next to the code that
// reads it — in the project root for `gift` itself, and in the function's own
// folder for a function. The schema names each setting, the environment
// variable it is handed to scripts as, its type and its default; it is also what
// `gift config` writes the file from the first time, so opening the file shows
// every setting there is rather than an empty page.
//
// config.json is git-ignored: it holds the webhook secret. A value already in
// the real environment wins over it, so a one-off `GIFT_REPOS=... gift
// weekly-prs` still works.
//
// Precedence, highest first:
//     the real environment
//     config.json — functions.<name>
//     config.json — the top level
//     the default in the schema
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const functions = require('../functions.js');

/** The name of the target that holds everything not belonging to one function. */
const GIFT = 'gift';

/** Where a function's settings sit inside the file. */
const FUNCTIONS_KEY = 'functions';

const SCHEMA_FILE = 'config.schema.json';

/** A leading `~` is a literal character until something expands it. */
function expandHome(value) {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
}

/** The one configuration file. $GIFT_CONFIG_FILE moves it, which tests use. */
function file() {
    if (process.env.GIFT_CONFIG_FILE) return path.resolve(expandHome(process.env.GIFT_CONFIG_FILE));
    return path.join(functions.ROOT, 'config.json');
}

/** Everything that can be configured: gift itself, then the functions. */
function targets() {
    return [
        { name: GIFT, dir: functions.ROOT, description: 'Shared settings and the webhooks server.' },
        ...functions.list().map((fn) => ({ name: fn.name, dir: fn.dir, description: fn.description })),
    ];
}

function targetNamed(name) {
    return targets().find((target) => target.name === name) || null;
}

/**
 * Which target a directory belongs to. Function folders configure themselves;
 * anywhere else — the project root, where the server runs — is `gift`.
 */
function targetFor(scopeDir) {
    if (!scopeDir) return GIFT;
    const resolved = path.resolve(scopeDir);
    const match = functions.list().find((fn) => path.resolve(fn.dir) === resolved);
    return match ? match.name : GIFT;
}

/** What a target may be asked about. An unreadable or missing schema means nothing. */
function schemaFor(name) {
    const target = targetNamed(name);
    if (!target) return { description: '', options: [] };

    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(target.dir, SCHEMA_FILE), 'utf8'));
        return {
            description: parsed.description || target.description || '',
            options: Array.isArray(parsed.options) ? parsed.options : [],
        };
    } catch {
        return { description: target.description || '', options: [] };
    }
}

let warned = false;

/**
 * The whole file. A file that will not parse is worth one complaint rather than
 * a crash on every command — a half-typed edit should not stop `gift status`
 * from telling you what is wrong.
 */
function read() {
    const target = file();
    let text;
    try {
        text = fs.readFileSync(target, 'utf8');
    } catch {
        return {}; // no file yet
    }

    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        if (!warned) {
            warned = true;
            process.stderr.write(`gift: ${target} is not valid JSON (${error.message}) — ignoring it.\n`);
        }
        return {};
    }
}

/**
 * Replace the file. It holds the webhook secret, so it is written 0600, and
 * through a temporary file so an interrupted write cannot leave half a config
 * behind.
 */
function write(values) {
    const target = file();
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(values, null, 4)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
    return target;
}

/** One target's slice of the file: the top level for gift, functions.<name> for a function. */
function section(values, name) {
    if (name === GIFT) {
        const { [FUNCTIONS_KEY]: _functions, ...rest } = values;
        return rest;
    }
    const all = values[FUNCTIONS_KEY];
    const own = all && typeof all === 'object' ? all[name] : null;
    return own && typeof own === 'object' ? own : {};
}

/** Turn what is in JSON into what a script expects to read. */
function asEnvValue(value) {
    if (value === true) return '1';
    if (value === false) return '';
    return String(value);
}

/** Values are only skipped when they say nothing: absent, null, or an empty string. */
function isSet(value) {
    return value !== undefined && value !== null && value !== '';
}

/**
 * One row per setting a target declares: what it is, what it is set to, and
 * where that value came from.
 *
 * @returns {Array<{key: string, env: string, type: string, description: string,
 *   value: *, source: 'environment'|'config'|'default'|'unset'}>}
 */
function settings(name) {
    const schema = schemaFor(name);
    const stored = section(read(), name);

    return schema.options.map((option) => {
        const row = {
            key: option.key,
            env: option.env,
            type: option.type || 'string',
            description: option.description || '',
            secret: option.type === 'secret',
            stored: stored[option.key],
        };

        if (option.env && isSet(process.env[option.env])) {
            return { ...row, value: process.env[option.env], source: 'environment' };
        }
        if (isSet(stored[option.key])) return { ...row, value: stored[option.key], source: 'config' };
        if (isSet(option.default)) return { ...row, value: option.default, source: 'default' };
        return { ...row, value: '', source: 'unset' };
    });
}

/** Hand one target's settings to the environment, without overwriting anything. */
function applyTo(values, name) {
    const stored = section(values, name);

    for (const option of schemaFor(name).options) {
        if (!option.env || !isSet(stored[option.key])) continue;
        if (process.env[option.env] !== undefined) continue;
        process.env[option.env] = asEnvValue(stored[option.key]);
    }
}

/**
 * Load the configuration for one run: the function's own settings, then gift's.
 * This is the single entry point — the dispatcher calls it before running
 * anything, and the server calls it at startup.
 *
 * @param {string} [scopeDir] Folder of the function about to run, if any.
 */
function loadFor(scopeDir) {
    const values = read();
    const target = targetFor(scopeDir);

    if (target !== GIFT) applyTo(values, target);
    applyTo(values, GIFT);
}

/**
 * The effective value of one environment variable, for the shell scripts that
 * start and stop the server and cannot read JSON themselves.
 */
function get(variable, fallback = '') {
    if (isSet(process.env[variable])) return process.env[variable];

    for (const target of targets()) {
        const row = settings(target.name).find((setting) => setting.env === variable);
        if (row && isSet(row.value)) return asEnvValue(row.value);
    }
    return fallback;
}

/** Read a value typed by a person into the type its setting is declared as. */
function coerce(option, input) {
    const text = String(input).trim();
    switch (option.type) {
        case 'number': {
            const value = Number(text);
            if (!Number.isFinite(value)) return { error: `${option.key} takes a number` };
            if (option.min !== undefined && value < option.min) {
                return { error: `${option.key} takes a number of at least ${option.min}` };
            }
            return { value };
        }
        case 'boolean':
            if (['true', 'yes', 'y', 'on', '1'].includes(text.toLowerCase())) return { value: true };
            if (['false', 'no', 'n', 'off', '0'].includes(text.toLowerCase())) return { value: false };
            return { error: `${option.key} takes yes or no` };
        case 'path':
            // Stored absolute: a folder written down today has to still mean the
            // same folder tomorrow, from whatever directory gift is run in.
            return { value: path.resolve(expandHome(text)) };
        default:
            return { value: text };
    }
}

/** Put one value in its place in the document, creating the section it belongs to. */
function place(values, name, key, value) {
    if (name === GIFT) {
        if (value === null) delete values[key];
        else values[key] = value;
        return values;
    }

    if (!values[FUNCTIONS_KEY] || typeof values[FUNCTIONS_KEY] !== 'object') values[FUNCTIONS_KEY] = {};
    if (!values[FUNCTIONS_KEY][name] || typeof values[FUNCTIONS_KEY][name] !== 'object') {
        values[FUNCTIONS_KEY][name] = {};
    }
    if (value === null) delete values[FUNCTIONS_KEY][name][key];
    else values[FUNCTIONS_KEY][name][key] = value;
    return values;
}

/**
 * Write one setting. `value` of null removes it. `gift config` opens the file
 * rather than calling this; ./setup.sh uses it to save the secret it generates.
 *
 * @returns {{ok: true, file: string, value: *} | {ok: false, error: string}}
 */
function set(name, key, value) {
    const option = schemaFor(name).options.find((candidate) => candidate.key === key);
    const values = read();

    if (value === null) return { ok: true, file: write(place(values, name, key, null)), value: null };

    const typed = option ? coerce(option, value) : { value: String(value) };
    if (typed.error) return { ok: false, error: typed.error };

    return { ok: true, file: write(place(values, name, key, typed.value)), value: typed.value };
}

/**
 * The document as it would look with nothing configured: every setting the
 * schemas declare, at its default, with the empty ones there to be filled in.
 * This is what `gift config` writes the first time, so the file is a list of
 * what can be set rather than a blank page.
 */
function skeleton(existing = {}) {
    const blank = (option) => (option.default !== undefined ? option.default : '');

    /** One section, schema order first, then anything the user added themselves. */
    const fill = (stored, name) => {
        const own = {};
        for (const option of schemaFor(name).options) {
            // An `advanced` setting is one whose default is right for nearly
            // everybody — the command behind a menu entry, say. It still works
            // when it is written down, and is left alone once it is, but it does
            // not go in a fresh file: a line nobody edits is a line in the way.
            if (option.advanced && !(option.key in stored)) continue;
            own[option.key] = option.key in stored ? stored[option.key] : blank(option);
        }
        for (const [key, value] of Object.entries(stored)) {
            if (!(key in own)) own[key] = value;
        }
        return own;
    };

    // Written in reading order: gift's settings, then the functions, which is
    // why `functions` is built last rather than kept wherever it happened to be.
    const values = fill(section(existing, GIFT), GIFT);

    const sections = {};
    const stored = existing[FUNCTIONS_KEY] && typeof existing[FUNCTIONS_KEY] === 'object' ? existing[FUNCTIONS_KEY] : {};
    for (const target of targets()) {
        if (target.name === GIFT) continue;
        sections[target.name] = fill(stored[target.name] && typeof stored[target.name] === 'object' ? stored[target.name] : {}, target.name);
    }
    // A section for a function that is no longer installed stays where it is:
    // deleting it would throw away settings the next update might want back.
    for (const [name, own] of Object.entries(stored)) {
        if (!(name in sections)) sections[name] = own;
    }
    values[FUNCTIONS_KEY] = sections;

    return values;
}

/** Create config.json if it is not there yet, filled in from the schemas. */
function ensure() {
    const target = file();
    if (fs.existsSync(target)) return { file: target, created: false };
    write(skeleton(read()));
    return { file: target, created: true };
}

module.exports = {
    GIFT,
    FUNCTIONS_KEY,
    file,
    targets,
    targetNamed,
    targetFor,
    schemaFor,
    read,
    write,
    section,
    settings,
    loadFor,
    get,
    set,
    coerce,
    skeleton,
    ensure,
    expandHome,
};

// Enough of a command line for ./setup.sh, ./start.sh and ./stop.sh, which need
// a value out of the configuration before there is any Node program running to
// ask.
if (require.main === module) {
    const [command, ...rest] = process.argv.slice(2);

    if (command === 'get' && rest.length >= 1) {
        process.stdout.write(`${get(rest[0], rest[1] || '')}\n`);
    } else if (command === 'set' && rest.length >= 3) {
        const result = set(rest[0], rest[1], rest.slice(2).join(' '));
        if (!result.ok) {
            process.stderr.write(`gift config: ${result.error}\n`);
            process.exitCode = 2;
        }
    } else if (command === 'ensure') {
        process.stdout.write(`${ensure().file}\n`);
    } else if (command === 'path') {
        process.stdout.write(`${file()}\n`);
    } else {
        process.stderr.write('usage: config.js get NAME [DEFAULT] | set TARGET KEY VALUE | ensure | path\n');
        process.exitCode = 2;
    }
}
