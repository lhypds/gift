// One hook, as hooks.json spells it and as everything downstream reads it.
//
//     {
//         "name": "restart-stash",
//         "trigger": { "type": "github", "repo": "lhypds/stash", … },
//         "run": "/var/www/stash.gcc3.com/restart.sh",
//         "args": [],
//         "cwd": "/var/www/stash.gcc3.com",
//         "detach": true,
//         "enabled": true
//     }
//
// A hook is two halves. The `trigger` half says what has to happen — a push
// arriving from GitHub, the clipboard changing, a page coming back different, a
// file being written — and belongs entirely to one trigger module, which is why
// nothing in here looks inside it. The other half is the same whichever trigger
// fired: a bash script, its arguments, and the directory it runs in.
//
// Both paths are spelled out in full and neither is guessed. A relative path
// would depend on where the server happened to be started from, which is not
// something a deploy should turn on.
//
// Older hooks.json files put the GitHub fields at the top level and had no
// `trigger` at all, because GitHub was the only thing gift listened to. Those
// are read as a GitHub trigger — see legacyTrigger below — so an install that
// predates the other three keeps working untouched.
'use strict';

const os = require('node:os');
const path = require('node:path');

const triggers = require('../triggers/index.js');

const DEFAULT_TYPE = 'github';

/** The GitHub fields as they were written before triggers had types. */
const LEGACY_KEYS = ['repo', 'events', 'branches', 'secretEnv'];

/** A leading `~` is a literal character until something expands it. */
function expandHome(target) {
    if (target === '~') return os.homedir();
    return target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
}

/** Whether a hook is written in the pre-triggers shape. */
function isLegacy(hook) {
    return !hook.trigger && LEGACY_KEYS.some((key) => hook[key] !== undefined);
}

function legacyTrigger(hook) {
    const trigger = { type: DEFAULT_TYPE };
    for (const key of LEGACY_KEYS) {
        if (hook[key] !== undefined) trigger[key] = hook[key];
    }
    return trigger;
}

/**
 * Read one hook as it is written into the record the rest of gift uses: the
 * trigger resolved to its module and normalised by it, the paths made absolute,
 * everything unset given the answer it would have had anyway.
 *
 * @throws {Error} with a message naming the hook and what is wrong with it.
 */
function normalize(hook, index = 0) {
    const name = hook.name || `hook-${index + 1}`;
    const bad = (message) => new Error(`hook '${name}' ${message}`);

    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        throw new Error(`hook ${index + 1} is not a JSON object`);
    }

    const written = hook.trigger !== undefined ? hook.trigger : isLegacy(hook) ? legacyTrigger(hook) : { type: DEFAULT_TYPE };
    if (!written || typeof written !== 'object' || Array.isArray(written)) {
        throw bad('has a "trigger" that is not a JSON object');
    }

    const type = written.type || DEFAULT_TYPE;
    const module_ = triggers.get(type);
    if (!module_) {
        throw bad(`has an unknown trigger type '${type}' — try one of: ${triggers.names().join(', ')}`);
    }

    let trigger;
    try {
        trigger = { ...module_.normalize({ ...written, type }), type };
    } catch (err) {
        throw bad(err.message);
    }

    // The handler is a bash script, whichever trigger fired: one shape of
    // handler means one set of GIFT_* variables and one way to read the log.
    if (!hook.run) throw bad('has no "run" script');
    const run = expandHome(String(hook.run));
    if (!path.isAbsolute(run)) throw bad(`"run" must be an absolute path, not '${hook.run}'`);
    if (!run.endsWith('.sh')) throw bad(`"run" must be a .sh script, not '${hook.run}'`);

    // `cwd` defaults to the script's own folder rather than being demanded: a
    // deploy script almost always runs beside itself, and a hook that omits it
    // is saying so rather than forgetting.
    const cwd = hook.cwd ? expandHome(String(hook.cwd)) : path.dirname(run);
    if (!path.isAbsolute(cwd)) throw bad(`"cwd" must be an absolute path, not '${hook.cwd}'`);

    return {
        name,
        trigger,
        run: path.normalize(run),
        args: Array.isArray(hook.args) ? hook.args.map(String) : [],
        cwd: path.normalize(cwd),
        detach: Boolean(hook.detach),
        // Absent means on. Turning a hook off is a deliberate edit, so only an
        // explicit false stops it from firing.
        enabled: hook.enabled !== false,
    };
}

/** The type a hook is written as, without normalising the rest of it. */
function typeOf(hook) {
    if (hook && hook.trigger && hook.trigger.type) return String(hook.trigger.type);
    return DEFAULT_TYPE;
}

/**
 * The rows shown for one hook by `gift list`, `gift create`'s confirmation and
 * `gift status`. The trigger contributes its own — a repository and its
 * branches, a URL and how often it is polled — and the handler rows are the
 * same for every type.
 */
function describe(hook, { resolve = (p) => p, notes = () => [] } = {}) {
    const type = typeOf(hook);
    const module_ = triggers.get(type);
    const written = hook.trigger || (isLegacy(hook) ? legacyTrigger(hook) : { type });

    const rows = [['trigger', module_ ? `${type} — ${module_.title}` : `${type} (unknown type)`]];
    if (module_) {
        try {
            for (const row of module_.describe(module_.normalize(written))) rows.push(row);
        } catch {
            // A trigger that will not normalise is still worth listing; the row
            // below says what is wrong with it rather than the command failing.
            rows.push(['note', 'this trigger is not configured correctly — `gift serve` will refuse it']);
        }
    }

    const run = hook.run ? resolve(expandHome(String(hook.run))) : '';
    rows.push(['run', run || '(none — this hook cannot run)']);
    if (Array.isArray(hook.args) && hook.args.length) {
        // Quoted the way it would be typed, so an argument with a space in it
        // does not read as two.
        rows.push(['args', hook.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')]);
    }
    rows.push([
        'cwd',
        hook.cwd
            ? resolve(expandHome(String(hook.cwd)))
            : run
                ? `${path.dirname(run)} (the script's folder)`
                : "(the script's folder)",
    ]);
    if (hook.detach) rows.push(['detach', 'yes']);
    if (hook.enabled === false) rows.push(['enabled', 'no — this hook is turned off']);
    if (run) for (const note of notes(run)) rows.push(['note', note]);
    return rows;
}

/** One short line for the delete menu's table: what would fire this hook. */
function line(hook) {
    const module_ = triggers.get(typeOf(hook));
    if (!module_) return typeOf(hook);
    const written = hook.trigger || (isLegacy(hook) ? legacyTrigger(hook) : { type: typeOf(hook) });
    try {
        return module_.line(module_.normalize(written));
    } catch {
        return '(not configured)';
    }
}

module.exports = {
    DEFAULT_TYPE,
    normalize,
    typeOf,
    describe,
    line,
    isLegacy,
    legacyTrigger,
    expandHome,
};
