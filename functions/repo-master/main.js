#!/usr/bin/env node
// repo-master — one live table for every git repository under a folder.
//
// It finds the repositories (nested checkouts and submodules included), watches
// their working trees, and paints the lot as a table that keeps itself up to
// date. Rows that want attention wear an orange bar. Pick rows with the arrow
// keys, add more with space, press d to read what changed, and press enter to go
// to a repository's folder, open it in VS Code, Claude Code or Codex, or commit
// and push every repository picked with one message.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const gitLib = require('./lib/git.js');
const reposLib = require('./lib/repos.js');
const actionsLib = require('./lib/actions.js');
const { watchAll } = require('./lib/watch.js');
const { createScreen } = require('./lib/screen.js');
const { createPalette, frame } = require('./lib/table.js');
const { limiter, expandHome } = require('./lib/util.js');

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
  up/down or k/j   move                 space   add to the selection
  enter            run a command        d       preview what changed
  esc              clear the selection  r       refresh now
  q                quit

Enter opens the commands in a box over the table. The preview is another such
box, holding the row's diff: up/down or j/k scroll it, space turns the page, r
reads it again and esc closes it.

The first repository picked with space is the main project and wears no mark; the
ones after it are marked +. The commands that open something open the main
project, and claude and codex are handed the marked ones as directories they may
also work in.

commit & push is the exception: it asks for a message in a box, then commits and
pushes every picked repository with it — each one on its own, and none of them
the main project of the others.`);
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
        report: null,
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

            const under = rows[state.cursor]?.dir;
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
            const moved = rows.findIndex((row) => row.dir === under);
            state.cursor = Math.max(0, Math.min(moved === -1 ? state.cursor : moved, rows.length - 1));

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

    const moveCursor = (delta) => {
        if (rows.length === 0) return;
        state.cursor = (state.cursor + delta + rows.length) % rows.length;
        draw();
    };

    // The selection is ordered, not just a set of rows: whichever repository was
    // picked first is the main project, and the rest come along behind it. With
    // nothing picked, the row under the cursor is the main project on its own.
    const targets = () => {
        if (state.selected.size === 0) return rows.slice(state.cursor, state.cursor + 1);
        const byDir = new Map(rows.map((row) => [row.dir, row]));
        return [...state.selected].map((dir) => byDir.get(dir)).filter(Boolean);
    };

    // A command either runs on what was picked or wants a word first. The ones
    // that want a word ask for it in a box of their own, and run from there.
    const startAction = (action) => {
        if (!action) return;
        if (action.prompt) {
            state.mode = 'input';
            state.input = {
                action,
                targets: state.menuTargets,
                title: action.prompt.title,
                footer: action.prompt.footer,
                value: '',
                column: 0,
                hint: '',
            };
            state.message = '';
            draw();
            return;
        }
        runAction(action);
    };

    const runAction = async (action) => {
        const chosen = state.menuTargets;
        state.mode = 'table';
        state.busy = true;
        state.message = '';
        draw();

        let message = '';
        try {
            message = await actionsLib.run(action, chosen, {
                suspend: () => {
                    if (renderTimer) clearTimeout(renderTimer);
                    renderTimer = null;
                    screen.suspend();
                },
                resume: () => screen.resume(),
            });
        } catch (failure) {
            message = failure.message || String(failure);
        }

        state.busy = false;
        state.selected.clear();
        state.message = message || '';
        draw();
    };

    // Committing is the one command the table does itself rather than hand the
    // terminal to somebody else for, so it says how it is getting on: a line per
    // repository in a box, rewritten as each one stages, commits and pushes. The
    // box stays up afterwards to be read; the summary outlives it.
    const runCommit = async (action, repos, message) => {
        const entries = repos.map((repo) => ({ repo, state: 'pending', text: 'waiting…' }));
        state.mode = 'report';
        state.report = {
            title: `${action.label} · "${message}"`,
            entries,
            running: true,
            scroll: 0,
            view: 1,
        };
        state.busy = true;
        state.message = '';
        draw();

        const outcome = await actionsLib.commit(repos, message, (update) => {
            const entry = entries.find((row) => row.repo === update.repo);
            if (entry) Object.assign(entry, { state: update.state, text: update.text });
            requestRender();
        });

        state.report.running = false;
        state.busy = false;
        state.selected.clear();

        const counted = (name) => outcome.filter((result) => result.state === name).length;
        const summary = [
            counted('done') > 0 ? `${counted('done')} pushed` : null,
            counted('skipped') > 0 ? `${counted('skipped')} unchanged` : null,
            counted('failed') > 0 ? `${counted('failed')} failed` : null,
        ].filter(Boolean);
        state.message = `${action.label}: ${summary.join(' · ') || 'nothing to do'}`;
        draw();

        // Every one of those repositories just changed underneath the table.
        refreshAll();
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

    const openPreview = () => {
        const repo = rows[state.cursor];
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
                panel.scroll--;
                break;
            case 'down':
            case 'j':
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

    // Typing into the box: printable characters go in at the caret, backspace
    // takes one out, ctrl-u empties the line, and the arrows move along it. Every
    // other key the table would answer — j, k, q, d — is a character here and
    // nothing more, which is why this has a handler of its own.
    const onInputKey = (key) => {
        const field = state.input;
        if (!field) {
            state.mode = 'table';
            draw();
            return;
        }

        const edit = (value, column) => {
            field.value = value;
            field.column = Math.max(0, Math.min(column, value.length));
            field.hint = '';
            draw();
        };
        const insert = (text) =>
            edit(field.value.slice(0, field.column) + text + field.value.slice(field.column), field.column + text.length);

        switch (key) {
            case 'escape': // back to the menu it was opened from
                state.mode = 'menu';
                state.input = null;
                draw();
                return;
            case 'enter': {
                const message = field.value.trim();
                if (!message) {
                    field.hint = 'a message first';
                    draw();
                    return;
                }
                const { action, targets } = field;
                state.input = null;
                runCommit(action, targets, message);
                return;
            }
            case 'left':
                edit(field.value, field.column - 1);
                return;
            case 'right':
                edit(field.value, field.column + 1);
                return;
            case 'space':
                insert(' ');
                return;
            case '\x7f': // backspace, and what most terminals send for it
            case '\b':
                if (field.column === 0) return;
                edit(field.value.slice(0, field.column - 1) + field.value.slice(field.column), field.column - 1);
                return;
            case '\x15': // ctrl-u
                edit('', 0);
                return;
            case '\x01': // ctrl-a
                edit(field.value, 0);
                return;
            case '\x05': // ctrl-e
                edit(field.value, field.value.length);
                return;
            default:
                // Anything printable, including a surrogate half of a character
                // that arrived in two pieces — put together in order, they still
                // spell what was typed.
                if (key.length === 1 && key >= ' ') insert(key);
        }
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
                panel.scroll--;
                break;
            case 'down':
            case 'j':
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
        // reason to put a hand back on the arrow keys.
        if (key === 'up' || key === 'k') {
            state.menuIndex = (state.menuIndex - 1 + state.actions.length) % state.actions.length;
            draw();
            return;
        }
        if (key === 'down' || key === 'j') {
            state.menuIndex = (state.menuIndex + 1) % state.actions.length;
            draw();
            return;
        }
        if (key === 'enter') {
            startAction(state.actions[state.menuIndex]);
            return;
        }
        if (/^[1-9]$/.test(key)) {
            const action = state.actions[Number(key) - 1];
            if (action) {
                state.menuIndex = Number(key) - 1;
                startAction(action);
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
        if (state.mode === 'report') {
            onReportKey(key);
            return;
        }
        if (state.mode === 'preview') {
            onPreviewKey(key);
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
            case 'space': {
                const repo = rows[state.cursor];
                if (!repo) return;
                if (state.selected.has(repo.dir)) state.selected.delete(repo.dir);
                else state.selected.add(repo.dir);
                moveCursor(1); // space walks down the list, the way ticking boxes does
                return;
            }
            case 'd':
                openPreview();
                return;
            case 'enter': {
                const chosen = targets();
                if (chosen.length === 0) return;
                state.menuTargets = chosen;
                state.menuIndex = 0;
                state.mode = 'menu';
                state.message = '';
                draw();
                return;
            }
            case 'escape':
                state.selected.clear();
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
            process.stdout.write('\x1b[?25h\x1b[?1049l');
            console.error(`repo-master: ${error && error.message ? error.message : error}`);
            process.exit(1);
        });
}

module.exports = { main, parseArgs };
