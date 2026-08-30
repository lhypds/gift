// gift's configuration: one file, config.json, in the project folder.
//
//     {
//         "port": 3999,                       gift's own settings at the top
//         "pm2_name": "gift",
//         "triggers": {                       each trigger type's under its name
//             "github":    { "github_webhook_secret": "...", "serve_path": "…" },
//             "clipboard": { "interval": 1000 }
//         },
//         "functions": {                      each function's under its name
//             "repo-master": { "repo_root": "/Users/me/projects" },
//             "weekly-prs":  { "repos": "owner/repo", "author": "octocat" }
//         }
//     }
//
// Three kinds of section, and which one a setting belongs in follows from who
// reads it: the server's address and PM2 name are gift's, the webhook secret is
// the GitHub trigger's, a repository root is a function's.
//
// What may go in each is declared by a config.schema.json next to the code that
// reads it — the project root for `gift` itself, the trigger's or function's own
// folder otherwise. The schema names each setting, the environment variable it
// is handed to scripts as, its type and its default; it is also what `gift
// config` writes the file from the first time, so opening the file shows every
// setting there is rather than an empty page.
//
// config.json is git-ignored: it holds the webhook secret. A value already in
// the real environment wins over it, so a one-off `GIFT_REPOS=... gift
// weekly-prs` still works.
//
// Precedence, highest first:
//     the real environment
//     config.json — triggers.<type> or functions.<name>
//     config.json — the top level
//     the default in the schema
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const functions = require('../functions.js');
const triggers = require('../triggers/index.js');

/** The name of the target that holds everything belonging to gift itself. */
const GIFT = 'gift';

/** Where a function's and a trigger's settings sit inside the file. */
const FUNCTIONS_KEY = 'functions';
const TRIGGERS_KEY = 'triggers';

const SCHEMA_FILE = 'config.schema.json';

/**
 * Settings that used to live at the top level, and the trigger they belong to
 * now that GitHub is one trigger among four rather than the whole server.
 *
 * A config.json written before triggers existed is read as though they had
 * always been there — see migrate() — and rewritten into the new shape the next
 * time anything saves it. Nothing is lost and nothing has to be edited by hand.
 */
const MOVED = {
    github: ['github_webhook_secret', 'webhook_url', 'serve_path'],
};

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

/** Everything that can be configured: gift itself, the triggers, the functions. */
function targets() {
    return [
        { name: GIFT, kind: 'gift', dir: functions.ROOT, description: 'Shared settings and the hooks server.' },
        ...triggers.list().map((trigger) => ({
            name: trigger.name,
            kind: 'trigger',
            dir: trigger.dir,
            description: trigger.summary,
        })),
        ...functions.list().map((fn) => ({
            name: fn.name,
            kind: 'function',
            dir: fn.dir,
            description: fn.description,
        })),
    ];
}

function targetNamed(name) {
    return targets().find((target) => target.name === name) || null;
}

/** Which of the two named sections a target's settings live in. */
function keyFor(name) {
    const target = targetNamed(name);
    return target && target.kind === 'trigger' ? TRIGGERS_KEY : FUNCTIONS_KEY;
}

/**
 * Which target a directory belongs to. Trigger and function folders configure
 * themselves; anywhere else — the project root, where the server runs — is
 * `gift`.
 */
function targetFor(scopeDir) {
    if (!scopeDir) return GIFT;
    const resolved = path.resolve(scopeDir);
    const match = targets().find((target) => target.kind !== 'gift' && path.resolve(target.dir) === resolved);
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
 * Move the settings that predate triggers into the section they belong to now.
 * Done on the way in rather than by rewriting the file, so a config.json that
 * has not been touched since keeps working from the first command — and takes
 * its new shape whenever something next saves it.
 *
 * A value already written under the trigger wins: someone who has edited the
 * new shape by hand meant it, and a stale top-level key must not undo that.
 */
function migrate(values) {
    for (const [trigger, keys] of Object.entries(MOVED)) {
        for (const key of keys) {
            if (!(key in values)) continue;
            const legacy = values[key];
            delete values[key];

            if (!values[TRIGGERS_KEY] || typeof values[TRIGGERS_KEY] !== 'object') values[TRIGGERS_KEY] = {};
            const own = values[TRIGGERS_KEY][trigger];
            if (!own || typeof own !== 'object') values[TRIGGERS_KEY][trigger] = {};
            if (!(key in values[TRIGGERS_KEY][trigger])) values[TRIGGERS_KEY][trigger][key] = legacy;
        }
    }
    return values;
}

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
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? migrate(parsed) : {};
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

/**
 * One target's slice of the file: the top level for gift, with the two named
 * sections lifted out, and `triggers.<type>` or `functions.<name>` otherwise.
 */
function section(values, name) {
    if (name === GIFT) {
        const { [FUNCTIONS_KEY]: _functions, [TRIGGERS_KEY]: _triggers, ...rest } = values;
        return rest;
    }
    const all = values[keyFor(name)];
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
 * Load the configuration for one run: the target's own settings, then gift's.
 * This is the single entry point — the dispatcher calls it before running
 * anything, and the server calls it at startup.
 *
 * Loading for gift itself loads every trigger too. One process runs all four of
 * them, and `gift create` asks all four their questions, so from gift's side a
 * trigger's settings are not a separate scope the way a function's are — they
 * are simply where the server's own settings now live.
 *
 * @param {string} [scopeDir] Folder of the function or trigger about to run.
 */
function loadFor(scopeDir) {
    const values = read();
    const target = targetFor(scopeDir);

    if (target !== GIFT) {
        applyTo(values, target);
    } else {
        for (const candidate of targets()) {
            if (candidate.kind === 'trigger') applyTo(values, candidate.name);
        }
    }
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

    const where = keyFor(name);
    if (!values[where] || typeof values[where] !== 'object') values[where] = {};
    if (!values[where][name] || typeof values[where][name] !== 'object') values[where][name] = {};
    if (value === null) delete values[where][name][key];
    else values[where][name][key] = value;
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

    /** One named section — `triggers` or `functions` — as it would be written. */
    const build = (kind, key) => {
        const stored = existing[key] && typeof existing[key] === 'object' ? existing[key] : {};
        const sections = {};
        for (const target of targets()) {
            if (target.kind !== kind) continue;
            const own = stored[target.name] && typeof stored[target.name] === 'object' ? stored[target.name] : {};
            sections[target.name] = fill(own, target.name);
        }
        // A section for a trigger or function that is no longer installed stays
        // where it is: deleting it would throw away settings the next update
        // might want back.
        for (const [name, own] of Object.entries(stored)) {
            if (!(name in sections)) sections[name] = own;
        }
        return sections;
    };

    // Written in reading order: gift's own settings, then the triggers, then the
    // functions — which is why the two named sections are built last rather
    // than kept wherever they happened to be.
    const values = fill(section(existing, GIFT), GIFT);
    values[TRIGGERS_KEY] = build('trigger', TRIGGERS_KEY);
    values[FUNCTIONS_KEY] = build('function', FUNCTIONS_KEY);

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
    TRIGGERS_KEY,
    MOVED,
    migrate,
    file,
    targets,
    targetNamed,
    targetFor,
    keyFor,
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
