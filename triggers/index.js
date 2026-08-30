// Trigger discovery. Every folder in triggers/ holding an index.js is a trigger
// type — the thing that notices something happened and asks gift to run a hook's
// script. The folder name is the type name, and it is what a hook's
// `"trigger": { "type": ... }` names.
//
// Four are shipped:
//
//     github      an HTTP endpoint that receives GitHub webhook deliveries
//     clipboard   watches the clipboard for content that matches
//     website     polls a URL and watches for a change, or for content
//     file        watches a file or folder for changes
//
// Adding a fifth is dropping a folder in beside them: it needs an index.js
// exporting the contract below, and gains a `gift create` menu entry, a
// config.schema.json section in config.json, and a place in `gift list`
// without anything else being edited.
//
// The contract every trigger module exports:
//
//     name          the type name, matching the folder
//     title         how it is offered in `gift create`
//     summary       one line, for the menu and `gift help`
//     prompt        "a hook fires on it when …", for the fallback help
//
//     normalize(t)  fill in the defaults and reject what could never fire;
//                   throws an Error whose message is shown to the user. Called
//                   on every read of hooks.json, so a hook that can never work
//                   stops the server rather than going quiet.
//     describe(t)   [[label, value]] rows for `gift list` and `gift status`
//     line(t)       one short line, for tables and the startup log
//
//     ask(ctx)      the questions `gift create` asks once this type is picked.
//                   Returns { trigger, label, after? } — `label` is what the
//                   default hook name is built from, and `after` runs once the
//                   hook is safely written, for anything that has to happen
//                   elsewhere (GitHub's own webhook). Null if the user backs
//                   out; throwing stops `gift create` without writing anything.
//     afterNotes(h) lines to print after a hook of this type is created
//
//     mount(ctx)    optional: HTTP routes, as { middleware }. Mounted before
//                   the server's 404, and only when hooks of this type exist.
//     start(ctx)    begin watching; returns { stop() }
//
// `mount` and `start` are given the runtime (see runtime.js) and only the hooks
// of their own type — a trigger never sees another's. Whatever `mount` returns
// is also spread into `start`'s ctx, which is how the GitHub trigger's endpoint
// and its startup line share one set of secrets.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TRIGGERS_DIR = __dirname;

/**
 * The order they are offered in, which is the order they were added rather than
 * alphabetical: GitHub is what most hooks are, so it is the first answer.
 * Anything dropped in later and not named here follows, by name.
 */
const FIRST = ['github', 'clipboard', 'website', 'file'];

let cache = null;

function loadFolder(name) {
    const dir = path.join(TRIGGERS_DIR, name);
    const entry = path.join(dir, 'index.js');
    if (!fs.existsSync(entry)) return null;

    let module_;
    try {
        module_ = require(entry);
    } catch (err) {
        // A broken trigger folder must not stop the other three from working,
        // and must not do it silently either.
        process.stderr.write(`gift: triggers/${name} could not be loaded — ${err.message}\n`);
        return null;
    }
    if (!module_ || typeof module_.start !== 'function') return null;

    return { ...module_, name: module_.name || name, dir };
}

/** Every trigger type, the shipped ones in FIRST order and the rest by name. */
function list() {
    if (cache) return cache;

    let entries;
    try {
        entries = fs.readdirSync(TRIGGERS_DIR, { withFileTypes: true });
    } catch {
        return [];
    }

    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const trigger = loadFolder(entry.name);
        if (trigger) found.push(trigger);
    }

    const rank = (name) => (FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
    cache = found.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    return cache;
}

/** One trigger type by name, or null. */
function get(name) {
    return list().find((trigger) => trigger.name === name) || null;
}

/** The type names, for validation messages and `gift create`'s menu. */
function names() {
    return list().map((trigger) => trigger.name);
}

module.exports = { TRIGGERS_DIR, list, get, names };
