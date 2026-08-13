#!/usr/bin/env node
// repo-master — one live table for every git repository under a folder.
//
// It finds the repositories (nested checkouts and submodules included), watches
// their working trees, and paints the lot as a table that keeps itself up to
// date. Rows that want attention wear an orange bar. Pick rows with the arrow
// keys or find them with /, add more with space, and press enter for the menu of
// what may be done to them: open them in an editor or an agent, read what
// changed, fetch, pull, branch a worktree off one, commit and push the lot, or
// delete a folder outright. The commands worth reaching for carry a key of their
// own, and the menu prints it beside them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const gitLib = require('./lib/git.js');
const reposLib = require('./lib/repos.js');
const actionsLib = require('./lib/actions.js');
const { watchAll } = require('./lib/watch.js');
const { createScreen, RESET } = require('./lib/screen.js');
const { createPalette, frame } = require('./lib/table.js');
const { limiter, expandHome, shortenHome } = require('./lib/util.js');

const VERSION = '0.0.1';

const DEFAULTS = {
    depth: 4,
    refresh: 30, // full sweep, in case a file watcher missed something
};

/** How many git processes may run at once, however many repositories there are. */
const GIT_CONCURRENCY = 4;
/** Redraws are coalesced this long, so a burst of edits paints once. */
const RENDER_MS = 60;
/** The clock the "last updated" column is read against moves on its own. */
const TICK_MS = 5000;

function usage() {
    console.log(`Usage: gift repo-master [DIR] [options]

Watch every git repository under DIR and show them as a live table. Without a
directory it watches the configured repo_root — functions.repo-master in gift's
config.json — and failing that, the current directory.

Options:
  --repo-root=PATH     Folder to watch; same as the positional argument (--dir also works)
  --depth=N            How many folders deep to search        (default ${DEFAULTS.depth})
  --refresh=SEC        Seconds between full git sweeps        (default ${DEFAULTS.refresh})
  --once               Print the table once and exit
  -h, --help           Show this help

Keys:
  up/down or k/j   move                  space   add to the selection
  enter            the command menu      /       search the table
  e                open with code        d       read the diff
  f                fetch                 p       pull
  t then a         add a worktree        D       delete the folder
  esc              clear                 r       refresh now
  q                quit

Every one of those keys runs a command the enter menu also holds a row for, on
the repositories picked with space — or the row under the cursor when none are.
The menu prints each command's key beside it, so nothing has to be learned twice.

The ones that open something open the main project — the first repository picked
— and claude and codex are handed the rest as directories they may also work in.
The ones that reach a remote, and the one that deletes a folder, are asked for
first in a box naming every repository they are about: enter runs it, esc backs
out. Pulling marks the ones with uncommitted changes, which is where a pull goes
wrong; deleting marks all of them, and says what else is inside the folders. What
came of each is reported in a box of its own.

t then a adds a worktree: a box asks for a branch, and each picked repository
gets a folder beside it named for the two of them — ~/projects/gift-feature-x for
feature-x in ~/projects/gift — which is a row of its own as soon as it exists. A
branch that is already here is checked out, one that is only on origin is
followed, and a new name is a new branch off HEAD.

/ narrows the table to the repositories whose name, path or branch holds what is
typed. The list narrows as it is typed; enter keeps it and gives the keys back,
esc undoes it. Everything else goes on as before behind it — rows are watched and
counted whether or not the search is showing them.

The mouse does the whole of a run on its own: the wheel moves through the table
and through the menu, and a click is the enter key — it opens the menu on the
row the wheel left the cursor on, and runs the command the wheel left the menu
pointing at. Where the pointer is lying makes no difference to either. The wheel
scrolls the diff and the reports as well. A delete is the one thing a click will
not answer for. Selecting text with the mouse needs a modifier held down while
the table is up — option in iTerm2, shift most other places.

commit & push treats every picked repository as a project of its own: it asks for
a message in a box, then commits and pushes each of them with it, none the main
project of the others.`);
}

function parseArgs(argv, env) {
    const options = {
        dir: env.GIFT_REPO_MASTER_REPO_ROOT || '',
        depth: Number(env.GIFT_REPO_MASTER_DEPTH) || DEFAULTS.depth,
        refresh: Number(env.GIFT_REPO_MASTER_REFRESH) || DEFAULTS.refresh,
        once: false,
        help: false,
        positional: '',
        error: null,
    };

    const number = (raw, name, min) => {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < min) {
            options.error = `${name} needs a number of at least ${min}`;
            return null;
        }
        return value;
    };

    for (const argument of argv) {
        if (argument === '-h' || argument === '--help') options.help = true;
        else if (argument === '--once') options.once = true;
        else if (argument.startsWith('--repo-root=')) options.dir = argument.slice(12);
        else if (argument.startsWith('--dir=')) options.dir = argument.slice(6); // the older spelling
        else if (argument.startsWith('--depth=')) options.depth = number(argument.slice(8), '--depth', 1) ?? options.depth;
        else if (argument.startsWith('--refresh=')) options.refresh = number(argument.slice(10), '--refresh', 1) ?? options.refresh;
        else if (argument.startsWith('-')) options.error = `unknown option: ${argument}`;
        else if (!options.positional) options.positional = argument;
        else options.error = `unexpected argument: ${argument}`;
    }

    if (options.positional) options.dir = options.positional;
    return options;
}

/** A blank row, before git has said anything about it. */
function makeRow(found, identity) {
    return {
        ...found,
        ...identity,
        branch: '',
        loaded: false,
        hasChanges: false,
        changedFiles: 0,
        adds: 0,
        dels: 0,
        lastChange: null,
        error: null,
    };
}

async function main(argv) {
    const options = parseArgs(argv, process.env);
    if (options.help) {
        usage();
        return 0;
    }
    if (options.error) {
        console.error(`repo-master: ${options.error}`);
        console.error('Run `gift repo-master --help` for the options.');
        return 2;
    }

    const root = path.resolve(options.dir ? expandHome(options.dir) : process.cwd());
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        console.error(`repo-master: ${root} is not a folder`);
        return 1;
    }

    const interactive = !options.once && process.stdin.isTTY && process.stdout.isTTY;

    const found = reposLib.arrange(root, await reposLib.discover(root, options.depth));
    const identities = await Promise.all(found.map((entry) => gitLib.identify(entry.dir)));
    const rows = found.map((entry, index) => makeRow(entry, identities[index]));

    const state = {
        version: VERSION,
        root,
        rows,
        interactive,
        cursor: interactive ? 0 : -1,
        scroll: 0,
        selected: new Set(),
        mode: 'table',
        menuIndex: 0,
        menuTargets: [],
        preview: null,
        input: null,
        confirm: null,
        report: null,
        // What the search left showing. The rows themselves are all still here —
        // watched, refreshed, counted in the header — and `filter` is only which
        // of them the table draws and the cursor may reach.
        filter: '',
        search: null,
        actions: actionsLib.actions(process.env),
        notes: { watch: '' },
        message: '',
        busy: false,
    };

    const gate = limiter(GIT_CONCURRENCY);
    const palette = createPalette(process.stdout);

    let screen = null;
    let renderTimer = null;

    const draw = () => {
        if (!screen || !screen.running) return;
        screen.draw(frame(state, palette, screen.size()));
    };
    const requestRender = () => {
        if (renderTimer || !screen || !screen.running) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            draw();
        }, RENDER_MS);
    };

    // Nothing a single repository does — being deleted mid-read, refusing to
    // answer — is worth taking the table down for.
    const refresh = (repo) =>
        gate(async () => {
            let result;
            try {
                result = await gitLib.inspect(repo.dir, repo.nested);
            } catch (failure) {
                result = { error: failure.message || String(failure) };
            }
            Object.assign(repo, {
                hasChanges: false,
                changedFiles: 0,
                adds: 0,
                dels: 0,
                lastChange: null,
                error: null,
                ...result,
                loaded: true,
            });
            requestRender();
        });

    const refreshAll = () => Promise.all(rows.map(refresh));

    // The rows the search left showing, which is every row until somebody
    // presses `/`. Everything the user points at is counted in this list rather
    // than in `rows` — the cursor, the window, the row a key acts on — so a
    // filtered table behaves like a table of exactly those repositories. It is
    // worked out afresh each time rather than kept: a row whose branch just
    // changed may have walked into or out of the search, and a list held on to
    // would go on showing what was true a moment ago.
    const shown = () => reposLib.filter(rows, state.filter);

    // Repositories come and go — that is rather the point of a folder nobody
    // tidies. Rescanning keeps the rows honest without losing what is already
    // known about the ones that stayed: `rows` is edited in place, so the
    // watchers and the selection all keep pointing at the same objects.
    let onRowsChanged = () => {};
    let scanning = false;
    const rescan = async () => {
        if (scanning) return false;
        scanning = true;
        try {
            const discovered = reposLib.arrange(root, await reposLib.discover(root, options.depth));
            const known = new Map(rows.map((row) => [row.dir, row]));
            if (discovered.length === known.size && discovered.every((entry) => known.has(entry.dir))) {
                for (const entry of discovered) Object.assign(known.get(entry.dir), entry);
                return false;
            }

            const under = shown()[state.cursor]?.dir;
            const next = [];
            const fresh = [];
            for (const entry of discovered) {
                const existing = known.get(entry.dir);
                if (existing) {
                    Object.assign(existing, entry); // depth and nesting may have moved
                    next.push(existing);
                } else {
                    const row = makeRow(entry, await gitLib.identify(entry.dir));
                    fresh.push(row);
                    next.push(row);
                }
            }
            rows.length = 0;
            rows.push(...next);

            for (const dir of [...state.selected]) if (!rows.some((row) => row.dir === dir)) state.selected.delete(dir);
            // The cursor counts the rows a search left showing, not all of them.
            const visible = shown();
            const moved = visible.findIndex((row) => row.dir === under);
            state.cursor = Math.max(0, Math.min(moved === -1 ? state.cursor : moved, visible.length - 1));

            onRowsChanged();
            fresh.forEach(refresh);
            requestRender();
            return true;
        } finally {
            scanning = false;
        }
    };

    // One shot: print what we know and leave. Nothing scrolls on paper, so the
    // whole list is printed however long it is.
    if (!interactive) {
        await refreshAll();
        const size = { columns: process.stdout.columns || 120, rows: rows.length + 16 };
        for (const line of frame(state, palette, size)) console.log(line);
        return 0;
    }

    // Interactive from here on.
    let finish;
    const quit = new Promise((resolve) => {
        finish = resolve;
    });

    // The keys wrap, because a list you can walk off the bottom of and come back
    // round the top of is quicker to get about. A wheel does not: it is a
    // physical thing that stops, and a flick too many that jumped from the last
    // repository to the first would be nobody's idea of scrolling.
    const moveCursor = (delta, wrap = true) => {
        const visible = shown();
        if (visible.length === 0) return;
        const next = state.cursor + delta;
        state.cursor = wrap
            ? (next + visible.length) % visible.length
            : Math.max(0, Math.min(next, visible.length - 1));
        draw();
    };

    // The selection is ordered, not just a set of rows: whichever repository was
    // picked first is the main project, and the rest come along behind it. With
    // nothing picked, the row under the cursor is the main project on its own.
    //
    // A search hides rows; it does not unpick them. Something picked and then
    // searched past is still picked, and still worked on — the box every command
    // opens names every repository it is about, which is where that is noticed.
    const targets = () => {
        const visible = shown();
        if (state.selected.size === 0) return visible.slice(state.cursor, state.cursor + 1);
        const byDir = new Map(rows.map((row) => [row.dir, row]));
        return [...state.selected].map((dir) => byDir.get(dir)).filter(Boolean);
    };

    /** A command by name, for the keys that start one without the menu. */
    const command = (id) => state.actions.find((entry) => entry.id === id);

    const openMenu = () => {
        const chosen = targets();
        if (chosen.length === 0) return;
        state.menuTargets = chosen;
        state.menuIndex = 0;
        state.mode = 'menu';
        state.message = '';
        draw();
    };

    // What a command wants before it can run, and where the answer comes from.
    // Some run on what was picked and nothing else; some want a word typed
    // first; two of them want to be asked whether they were meant at all. Every
    // one of them can be started from the menu or from its own key, and this is
    // the one place that knows what starting it involves — so both go through
    // here and the two cannot drift apart.
    //
    // `back` is where esc returns to, which is the menu when the menu opened it
    // and the table when a key did.
    const startAction = (action, chosen, back = 'menu') => {
        if (!action || chosen.length === 0) return;

        switch (action.kind) {
            case 'diff':
                // The main project is the one with a diff to read; the rest were
                // picked to be worked on together, which reading is not.
                openPreview(chosen[0]);
                return;
            case 'sync':
                askSync(action, chosen, back);
                return;
            case 'delete':
                askDelete(action, chosen, back);
                return;
            case 'worktree':
                // The folder is not asked for, it is shown: it follows from the
                // branch, and watching it spell itself out under the line being
                // typed is worth more than a second question would be.
                ask(action, chosen, back, (branch) => runWorktree(action, chosen, branch), (branch) =>
                    chosen.map((repo) => ({
                        name: repo.name,
                        text: branch.trim() ? relativeToRoot(actionsLib.worktreePath(repo.dir, branch.trim())) : '…',
                    })),
                );
                return;
            case 'commit':
                ask(action, chosen, back, (message) => runCommit(action, chosen, message));
                return;
            default:
                runAction(action, chosen);
        }
    };

    /** A word first, in a box of its own, and then the work. */
    const ask = (action, chosen, back, submit, list = null) => {
        state.mode = 'input';
        state.input = {
            action,
            targets: chosen,
            title: action.prompt.title,
            footer: action.prompt.footer,
            value: '',
            column: 0,
            hint: '',
            back,
            submit,
            // What to say about each repository under the line, given what has
            // been typed so far. Without one the box lists what changed in them.
            list,
        };
        state.message = '';
        draw();
    };

    /** A path as the table writes them: `./gcc3/public/notes`, or `~/elsewhere`. */
    const relativeToRoot = (target) => {
        const relative = path.relative(root, target);
        return !relative || relative.startsWith('..') ? shortenHome(target) : `./${relative}`;
    };

    // What is run and what it is run on arrive together, because the menu is not
    // the only thing that starts a command: a key starts one from the table, on
    // what the cursor and the selection say without a box in between.
    const runAction = async (action, chosen) => {
        state.mode = 'table';
        state.busy = true;
        state.message = '';
        draw();

        // Some commands are the last thing repo-master does. `goto folder` is
        // asked for in order to be somewhere else, and putting the table back up
        // in front of somebody who has just typed `exit` is one screen too many:
        // leaving that shell leaves repo-master. The resume hook has to know
        // before the command finishes, because a table painted and taken down
        // again a line later shows as a flicker.
        let leaving = Boolean(action.last);

        let message = '';
        try {
            message = await actionsLib.run(action, chosen, {
                suspend: () => {
                    if (renderTimer) clearTimeout(renderTimer);
                    renderTimer = null;
                    screen.suspend();
                },
                resume: () => {
                    if (!leaving) screen.resume();
                },
            });
        } catch (failure) {
            message = failure.message || String(failure);
        }

        state.busy = false;
        state.selected.clear();

        // A command that would not start has a line about it to read, and
        // reading it needs the table back after all.
        if (leaving && !message) {
            finish(0);
            return;
        }
        if (!screen.running) screen.resume();

        state.message = message || '';
        draw();
    };

    // Committing, fetching and pulling are the things the table does itself
    // rather than hand the terminal to somebody else for, so they say how they
    // are getting on: a line per repository in a box, rewritten as each one
    // moves. The box stays up afterwards to be read; the summary outlives it.
    //
    // @param {string} title What the box is called.
    // @param {string} label What the summary line calls the work afterwards.
    // @param {object[]} repos
    // @param {{done: string, skipped: string}} words How to count the outcomes up.
    // @param {(onUpdate: Function) => Promise<object[]>} start Kicks the work off.
    // @param {() => void} [after] What to put right afterwards. Refreshing the
    //   rows is enough for work done inside them; work that makes or unmakes a
    //   folder has to go looking for rows as well.
    const runReport = async (title, label, repos, words, start, after = refreshAll) => {
        const entries = repos.map((repo) => ({ repo, state: 'pending', text: 'waiting…' }));
        state.mode = 'report';
        state.report = { title, entries, words, running: true, scroll: 0, view: 1 };
        state.busy = true;
        state.message = '';
        draw();

        const outcome = await start((update) => {
            const entry = entries.find((row) => row.repo === update.repo);
            if (entry) Object.assign(entry, { state: update.state, text: update.text });
            requestRender();
        });

        state.report.running = false;
        state.busy = false;
        state.selected.clear();

        const counted = (name) => outcome.filter((result) => result.state === name).length;
        const summary = [
            counted('done') > 0 ? `${counted('done')} ${words.done}` : null,
            counted('skipped') > 0 ? `${counted('skipped')} ${words.skipped}` : null,
            counted('failed') > 0 ? `${counted('failed')} failed` : null,
        ].filter(Boolean);
        state.message = `${label}: ${summary.join(' · ') || 'nothing to do'}`;
        draw();

        // Every one of those repositories may have just changed underneath the
        // table — a pull moves the working tree, and a fetch moves the count of
        // what is waiting in it.
        after();
    };

    /** A rescan and then a refresh: rows have come or gone, not merely moved. */
    const rescanAfter = () => {
        rescan()
            .then(refreshAll)
            .catch(() => {});
    };

    const runCommit = (action, repos, message) =>
        runReport(
            `${action.label} · "${message}"`,
            action.label,
            repos,
            { done: 'pushed', skipped: 'unchanged' },
            (onUpdate) => actionsLib.commit(repos, message, onUpdate),
        );

    const runSync = (kind, repos) =>
        runReport(
            `${actionsLib.SYNC[kind].label} · ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`,
            actionsLib.SYNC[kind].label,
            repos,
            kind === 'pull'
                ? { done: 'updated', skipped: 'already up to date' }
                : { done: 'with new commits', skipped: 'up to date' },
            (onUpdate) => actionsLib.sync(repos, kind, onUpdate),
        );

    // A worktree is a folder that was not there before, and a folder under the
    // watched root is a row: the rescan is what turns the one into the other,
    // rather than leaving it to the next sweep half a minute later.
    const runWorktree = (action, repos, branch) =>
        runReport(
            `${action.label} · ${branch}`,
            action.label,
            repos,
            { done: 'added', skipped: 'left alone' },
            (onUpdate) => actionsLib.worktrees(repos, branch, onUpdate),
            rescanAfter,
        );

    const runDelete = (action, repos) =>
        runReport(
            `${action.label} · ${repos.length} ${repos.length === 1 ? 'folder' : 'folders'}`,
            action.label,
            repos,
            { done: 'deleted', skipped: 'gone already' },
            (onUpdate) => actionsLib.remove(repos, onUpdate),
            rescanAfter,
        );

    // Fetching and pulling are asked for before they are done, because they reach
    // a remote and a pull writes into a working tree. The box is what goes
    // between: it names every repository about to be reached for, and pulling
    // marks the ones with uncommitted changes, which is where a pull goes wrong.
    const askSync = (action, chosen, back) => {
        state.mode = 'confirm';
        state.confirm = { kind: action.sync, action, targets: chosen, back, scroll: 0, view: 1 };
        state.message = '';
        draw();
    };

    /**
     * Deleting is asked for in the same box, and for better reason: there is
     * nothing to undo it. What it removes is a folder, so a repository nested
     * inside one being deleted goes with it, and the box says so rather than
     * leaving it to be discovered afterwards.
     *
     * The watched root is not on offer. It is the folder the table is a table of,
     * and deleting it is not a thing anybody meant by pointing at a row in it.
     */
    const askDelete = (action, chosen, back) => {
        const safe = chosen.filter((repo) => repo.dir !== root);
        if (safe.length === 0) {
            state.mode = 'table';
            state.message = `${action.label}: ${shortenHome(root)} is the folder being watched`;
            draw();
            return;
        }

        const doomed = new Set(safe.map((repo) => repo.dir));
        state.mode = 'confirm';
        state.confirm = {
            kind: 'delete',
            action,
            targets: safe,
            // Rows that are not being deleted but will be gone all the same:
            // they live inside a folder that is.
            alsoGone: rows.filter(
                (row) =>
                    !doomed.has(row.dir) &&
                    [...doomed].some((dir) => {
                        const relative = path.relative(dir, row.dir);
                        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
                    }),
            ),
            back,
            scroll: 0,
            view: 1,
        };
        state.message = '';
        draw();
    };

    const onConfirmKey = (key) => {
        const panel = state.confirm;
        if (!panel || key === 'escape' || key === 'q') {
            state.mode = panel?.back === 'menu' ? 'menu' : 'table';
            state.confirm = null;
            draw();
            return;
        }
        // A click answers for enter everywhere else in repo-master. Not here, and
        // only for the one command: a folder is not to be deleted by a mouse that
        // was somewhere near the box, and the keyboard is where the answer to a
        // question this final should come from.
        if (key === 'enter' || (key === 'click' && panel.kind !== 'delete')) {
            const { kind, action, targets: chosen } = panel;
            state.confirm = null;
            if (kind === 'delete') runDelete(action, chosen);
            else runSync(kind, chosen);
            return;
        }

        // Out of range is the renderer's business, as in the preview.
        const page = Math.max(1, panel.view - 1);
        switch (key) {
            case 'up':
            case 'k':
            case 'wheel-up':
                panel.scroll--;
                break;
            case 'down':
            case 'j':
            case 'wheel-down':
                panel.scroll++;
                break;
            case 'space':
                panel.scroll += page;
                break;
            default:
                return;
        }
        draw();
    };

    // The preview: what a repository's diff column is actually made of, in a box
    // over the table. The table behind it keeps refreshing; the patch does not,
    // because a page of text moving under somebody reading it is no kindness.
    // `r` asks for it again.
    let previewToken = 0;
    const loadPreview = (repo) => {
        const token = ++previewToken;
        state.preview.loading = true;
        draw();

        // Outside the limiter on purpose: this is one repository somebody is
        // waiting on, and it should not queue behind a sweep of all the others.
        gitLib
            .diff(repo.dir, repo.nested)
            .catch((failure) => ({ lines: [], error: failure.message || String(failure) }))
            .then((result) => {
                // A slower read of a repository already closed, or replaced by a
                // newer one, has nothing to say.
                if (token !== previewToken || state.preview?.repo !== repo) return;
                state.preview.loading = false;
                state.preview.lines = result.error
                    ? [`error: ${result.error}`]
                    : result.lines.length > 0
                      ? result.lines
                      : ['no changes'];
                draw();
            });
    };

    const openPreview = (repo) => {
        if (!repo) return;
        state.mode = 'preview';
        state.message = '';
        // The title is the renderer's, and so are `scroll` and `view` once it has
        // seen how tall the box came out.
        state.preview = { repo, title: '', lines: [], scroll: 0, view: 1, loading: true };
        loadPreview(repo);
    };

    const closePreview = () => {
        state.mode = 'table';
        state.preview = null;
        draw();
    };

    const onPreviewKey = (key) => {
        const panel = state.preview;
        if (!panel || key === 'escape' || key === 'q' || key === 'd') {
            closePreview();
            return;
        }
        if (key === 'r') {
            loadPreview(panel.repo);
            return;
        }

        // Out-of-range scrolling is left to the renderer, which is the only part
        // that knows how many lines the box is showing.
        const page = Math.max(1, panel.view - 1);
        switch (key) {
            case 'up':
            case 'k':
            case 'wheel-up':
                panel.scroll--;
                break;
            case 'down':
            case 'j':
            case 'wheel-down':
                panel.scroll++;
                break;
            case 'space':
                panel.scroll += page;
                break;
            case 'g':
                panel.scroll = 0;
                break;
            case 'G':
                panel.scroll = panel.lines.length;
                break;
            default:
                return;
        }
        draw();
    };

    // Typing a line: printable characters go in at the caret, backspace takes one
    // out, ctrl-u empties it, and the arrows move along it. Every other key the
    // table would answer — j, k, q, d — is a character while a line is being
    // typed and nothing more, which is why typing has handlers of its own.
    //
    // A commit message and a search are the same editing, so it is written once.
    // Returns whether the key belonged to the line at all.
    const typed = (field, key) => {
        const set = (value, column) => {
            field.value = value;
            field.column = Math.max(0, Math.min(column, value.length));
            return true;
        };
        const insert = (text) =>
            set(field.value.slice(0, field.column) + text + field.value.slice(field.column), field.column + text.length);

        switch (key) {
            case 'left':
                return set(field.value, field.column - 1);
            case 'right':
                return set(field.value, field.column + 1);
            case 'space':
                return insert(' ');
            case '\x7f': // backspace, and what most terminals send for it
            case '\b':
                if (field.column === 0) return true;
                return set(field.value.slice(0, field.column - 1) + field.value.slice(field.column), field.column - 1);
            case '\x15': // ctrl-u
                return set('', 0);
            case '\x01': // ctrl-a
                return set(field.value, 0);
            case '\x05': // ctrl-e
                return set(field.value, field.value.length);
            default:
                // Anything printable, including a surrogate half of a character
                // that arrived in two pieces — put together in order, they still
                // spell what was typed.
                return key.length === 1 && key >= ' ' ? insert(key) : false;
        }
    };

    const onInputKey = (key) => {
        const field = state.input;
        if (!field) {
            state.mode = 'table';
            draw();
            return;
        }

        switch (key) {
            case 'escape': // back to wherever the command was started from
                state.mode = field.back === 'menu' ? 'menu' : 'table';
                state.input = null;
                draw();
                return;
            case 'enter': {
                const value = field.value.trim();
                if (!value) {
                    field.hint = field.action.prompt.empty || 'a word first';
                    draw();
                    return;
                }
                const { submit } = field;
                state.input = null;
                submit(value);
                return;
            }
            default:
                if (typed(field, key)) {
                    field.hint = '';
                    draw();
                }
        }
    };

    /**
     * The search line, which is not a box. Watching the list shrink to what was
     * meant is the whole point of typing into it, and a box in the middle of the
     * screen would cover the rows being narrowed down — so it is drawn along the
     * bottom, where the keys usually are, and the table stays whole above it.
     */
    const openSearch = () => {
        state.mode = 'search';
        state.search = { value: state.filter, column: state.filter.length };
        state.message = '';
        draw();
    };

    /**
     * A filter changing moves the ground under the cursor: the row it was on may
     * not be in the list any more. It follows that row for as long as the row is
     * still showing, and otherwise starts again at the top.
     */
    const setFilter = (value) => {
        const under = shown()[state.cursor];
        state.filter = value;
        const moved = under ? shown().findIndex((row) => row.dir === under.dir) : -1;
        state.cursor = moved === -1 ? 0 : moved;
    };

    const onSearchKey = (key) => {
        const field = state.search;
        if (!field) {
            state.mode = 'table';
            draw();
            return;
        }

        // Enter keeps what is showing and hands the keys back to the table; esc
        // undoes the search, which is what somebody who has thought better of one
        // wants — the list they had before, not the list they were typing towards.
        if (key === 'enter' || key === 'click') {
            state.mode = 'table';
            state.search = null;
            draw();
            return;
        }
        if (key === 'escape') {
            state.mode = 'table';
            state.search = null;
            setFilter('');
            draw();
            return;
        }
        // The cursor still moves while the search is being typed, so a row can be
        // reached without the keys changing hands. Only by arrow and wheel: j and
        // k are letters here, as they are in any other line being typed.
        if (key === 'up' || key === 'wheel-up') {
            moveCursor(-1, false);
            return;
        }
        if (key === 'down' || key === 'wheel-down') {
            moveCursor(1, false);
            return;
        }

        if (typed(field, key)) {
            setFilter(field.value);
            draw();
        }
    };

    /**
     * `t` is not a command but the way to the ones about worktrees: press it and
     * a box says which letter does what. There is one of them today, and the box
     * is where the next will go.
     */
    const onWorktreeKey = (key) => {
        const chosen = state.menuTargets;
        state.mode = 'table';
        if (key !== 'a' || chosen.length === 0) {
            draw();
            return;
        }
        startAction(command('worktree'), chosen, 'table');
    };

    const onReportKey = (key) => {
        const panel = state.report;
        if (!panel || key === 'escape' || key === 'q' || key === 'enter') {
            state.mode = 'table';
            state.report = null;
            draw();
            return;
        }

        // Out of range is the renderer's business, as in the preview.
        const page = Math.max(1, panel.view - 1);
        switch (key) {
            case 'up':
            case 'k':
            case 'wheel-up':
                panel.scroll--;
                break;
            case 'down':
            case 'j':
            case 'wheel-down':
                panel.scroll++;
                break;
            case 'space':
                panel.scroll += page;
                break;
            default:
                return;
        }
        draw();
    };

    const onMenuKey = (key) => {
        if (key === 'escape' || key === 'q') {
            state.mode = 'table';
            draw();
            return;
        }
        // k and j move here too, the same as they do in the table: a menu is no
        // reason to put a hand back on the arrow keys. So does the wheel, and it
        // stops at the ends the way it does in the table, so the whole of a run
        // — pick a repository, open this, pick a command, run it — can be done
        // without touching the keyboard at all.
        const move = (delta, wrap) => {
            const count = state.actions.length;
            const next = state.menuIndex + delta;
            state.menuIndex = wrap ? (next + count) % count : Math.max(0, Math.min(next, count - 1));
            draw();
        };
        if (key === 'up' || key === 'k') return move(-1, true);
        if (key === 'down' || key === 'j') return move(1, true);
        if (key === 'wheel-up') return move(-1, false);
        if (key === 'wheel-down') return move(1, false);

        // A click runs whatever the wheel left the menu pointing at, and never
        // what the pointer is lying over: the box is a few lines in the middle
        // of the screen, and picking by aim is not what it is for.
        if (key === 'enter' || key === 'click') {
            startAction(state.actions[state.menuIndex], state.menuTargets);
            return;
        }
        // The number keys reach the first nine rows. A tenth command is one more
        // than there are digits, and it is reached the way anything else is —
        // with the arrows, or with the key it carries in the table.
        if (/^[1-9]$/.test(key)) {
            const action = state.actions[Number(key) - 1];
            if (action) {
                state.menuIndex = Number(key) - 1;
                startAction(action, state.menuTargets);
            }
        }
    };

    const onKey = (key) => {
        if (key === 'ctrl-c' || key === 'ctrl-d') {
            finish(130);
            return;
        }
        if (state.busy) return;

        if (state.mode === 'menu') {
            onMenuKey(key);
            return;
        }
        if (state.mode === 'input') {
            onInputKey(key);
            return;
        }
        if (state.mode === 'confirm') {
            onConfirmKey(key);
            return;
        }
        if (state.mode === 'report') {
            onReportKey(key);
            return;
        }
        if (state.mode === 'preview') {
            onPreviewKey(key);
            return;
        }
        if (state.mode === 'search') {
            onSearchKey(key);
            return;
        }
        if (state.mode === 'worktree') {
            onWorktreeKey(key);
            return;
        }

        switch (key) {
            case 'q':
                finish(0);
                return;
            case 'up':
            case 'k':
                moveCursor(-1);
                return;
            case 'down':
            case 'j':
                moveCursor(1);
                return;
            // The wheel moves the cursor rather than the window under it: the
            // row the cursor is on is the row enter and d act on, and a table
            // that scrolled away from it would leave the two pointing apart.
            // The window follows along, which is the scrolling anyone wanted.
            case 'wheel-up':
                moveCursor(-1, false);
                return;
            case 'wheel-down':
                moveCursor(1, false);
                return;
            case 'space': {
                const repo = shown()[state.cursor];
                if (!repo) return;
                if (state.selected.has(repo.dir)) state.selected.delete(repo.dir);
                else state.selected.add(repo.dir);
                moveCursor(1); // space walks down the list, the way ticking boxes does
                return;
            }
            // The keys that start a command start the same command the menu holds
            // a row for, on the same repositories — the ones picked, or the row
            // under the cursor when none are. What each one then does about being
            // asked first is the command's own business and written into it: the
            // editor opens, fetch and pull ask, delete asks in earnest.
            case 'e':
                startAction(command('code'), targets(), 'table');
                return;
            case 'd':
                // The one command that reads a row rather than acting on a
                // selection, so the row under the cursor is what it reads —
                // whatever else may be picked for the commands that do act.
                startAction(command('diff'), shown().slice(state.cursor, state.cursor + 1), 'table');
                return;
            case 'f':
                startAction(command('fetch'), targets(), 'table');
                return;
            case 'p':
                startAction(command('pull'), targets(), 'table');
                return;
            case 'D':
                startAction(command('delete'), targets(), 'table');
                return;
            case 't': {
                const chosen = targets();
                if (chosen.length === 0) return;
                state.menuTargets = chosen; // the box says which repositories it is about
                state.mode = 'worktree';
                state.message = '';
                draw();
                return;
            }
            case '/':
                openSearch();
                return;
            case 'enter':
                openMenu();
                return;
            case 'click':
                // A click is the enter key and nothing besides. The wheel is
                // what picks a row; a click that picked one too would act on
                // whatever the pointer happened to be lying over rather than on
                // the row you had chosen, and the pointer is not where you were
                // looking.
                openMenu();
                return;
            case 'escape':
                // One thing at a time, the newest first: a search is undone
                // before a selection is, because it is the one just made and the
                // one hiding rows. A second esc clears what was picked.
                if (state.filter) setFilter('');
                else state.selected.clear();
                state.message = '';
                draw();
                return;
            case 'r':
                state.message = 'refreshing…';
                draw();
                rescan()
                    .then(refreshAll)
                    .catch(() => {})
                    .then(() => {
                        state.message = '';
                        draw();
                    });
                return;
            default:
        }
    };

    screen = createScreen({ onKey, onResize: draw });
    screen.start();
    draw();

    let watchers = watchAll(rows, refresh, Math.min(options.refresh, 5));
    const noteWatchers = () => {
        state.notes.watch = watchers.fallbacks.length > 0 ? `${watchers.fallbacks.length} polled` : '';
    };
    noteWatchers();

    // A rescan that found something has to be watched too.
    onRowsChanged = () => {
        watchers.close();
        watchers = watchAll(rows, refresh, Math.min(options.refresh, 5));
        noteWatchers();
    };

    refreshAll();

    const ticker = setInterval(draw, TICK_MS);
    const sweeper = setInterval(() => {
        rescan()
            .then(refreshAll)
            .catch(() => {});
    }, options.refresh * 1000);

    const onSignal = () => finish(130);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    // A terminal never closes its own input, but a pipe or a script driving one
    // does, and there is nobody left to press q.
    process.stdin.on('end', () => {
        if (!state.busy) finish(0);
    });

    const code = await quit;

    clearInterval(ticker);
    clearInterval(sweeper);
    if (renderTimer) clearTimeout(renderTimer);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    watchers.close();
    screen.stop();

    // Leave now, rather than when the event loop happens to empty. A sweep of
    // every repository leaves a queue of git reads behind it, and quitting does
    // not cancel them: waiting would hold the terminal with the table already
    // gone and the shell prompt not yet back — which is a freeze, however
    // briefly it lasts. Those reads have nothing left to draw on, so nothing is
    // lost by walking away from them. The screen was put right just above, and a
    // terminal takes those writes synchronously, so none of it is still on its
    // way out. A commit or push is the exception: it is worth finishing, so the
    // loop is left to drain for it — only a signal gets here while one runs, as
    // `q` is not read at all until it is done.
    if (!state.busy) process.exit(code);

    return code;
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => {
            // Not process.exit(): with --once the table may still be on its way
            // down a pipe, and cutting the process short would cut it off too.
            process.exitCode = code;
        })
        .catch((error) => {
            // Whatever went wrong, the terminal is not to be left holding the
            // alternate screen, a hidden cursor or a mouse it reports on.
            process.stdout.write(RESET);
            console.error(`repo-master: ${error && error.message ? error.message : error}`);
            process.exit(1);
        });
}

module.exports = { main, parseArgs };
