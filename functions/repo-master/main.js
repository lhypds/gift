#!/usr/bin/env node
// repo-master — one live table for every git repository under a folder.
//
// It finds the repositories (nested checkouts and submodules included), watches
// their working trees, asks GitHub how many pull requests are open, and paints
// the lot as a table that keeps itself up to date. Rows that want attention are
// orange. Pick rows with the arrow keys, add more with space, and press enter to
// open them in VS Code, Claude Code or Codex.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const gitLib = require('./lib/git.js');
const ghLib = require('./lib/gh.js');
const reposLib = require('./lib/repos.js');
const actionsLib = require('./lib/actions.js');
const { watchAll } = require('./lib/watch.js');
const { createScreen } = require('./lib/screen.js');
const { createPalette, frame } = require('./lib/table.js');
const { limiter, expandHome } = require('./lib/util.js');

const VERSION = '0.0.1';

const DEFAULTS = {
    depth: 4,
    prInterval: 10, // seconds between rounds of `gh pr list`
    prRate: 60, // and never more than this many calls a minute
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
  --pr-interval=SEC    Seconds between pull request rounds    (default ${DEFAULTS.prInterval})
  --pr-rate=N          Most \`gh\` calls a minute, whatever the interval (default ${DEFAULTS.prRate})
  --refresh=SEC        Seconds between full git sweeps        (default ${DEFAULTS.refresh})
  --no-pr              Do not ask GitHub about pull requests
  --once               Print the table once and exit
  -h, --help           Show this help

Keys:
  up/down or k/j   move            space   add to the selection
  enter            run a command   esc     clear the selection
  r                refresh now     q       quit`);
}

function parseArgs(argv, env) {
    const options = {
        dir: env.GIFT_REPO_MASTER_REPO_ROOT || '',
        depth: Number(env.GIFT_REPO_MASTER_DEPTH) || DEFAULTS.depth,
        prInterval: Number(env.GIFT_REPO_MASTER_PR_INTERVAL) || DEFAULTS.prInterval,
        prRate: Number(env.GIFT_REPO_MASTER_PR_RATE) || DEFAULTS.prRate,
        refresh: Number(env.GIFT_REPO_MASTER_REFRESH) || DEFAULTS.refresh,
        pr: true,
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
        else if (argument === '--no-pr') options.pr = false;
        else if (argument.startsWith('--repo-root=')) options.dir = argument.slice(12);
        else if (argument.startsWith('--dir=')) options.dir = argument.slice(6); // the older spelling
        else if (argument.startsWith('--depth=')) options.depth = number(argument.slice(8), '--depth', 1) ?? options.depth;
        else if (argument.startsWith('--pr-interval='))
            options.prInterval = number(argument.slice(14), '--pr-interval', 1) ?? options.prInterval;
        else if (argument.startsWith('--pr-rate=')) options.prRate = number(argument.slice(10), '--pr-rate', 1) ?? options.prRate;
        else if (argument.startsWith('--refresh=')) options.refresh = number(argument.slice(10), '--refresh', 1) ?? options.refresh;
        else if (argument.startsWith('-')) options.error = `unknown option: ${argument}`;
        else if (!options.positional) options.positional = argument;
        else options.error = `unexpected argument: ${argument}`;
    }

    if (options.positional) options.dir = options.positional;
    return options;
}

/** A blank row, before git or gh has said anything about it. */
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
        pr: {
            count: null,
            numbers: null,
            baseline: null,
            hasNew: false,
            unknown: false,
            failures: 0,
            giveUp: false,
            reason: '',
        },
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
        actions: actionsLib.actions(process.env),
        notes: { gh: '', pr: '', watch: '' },
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
    // watchers, the poller and the selection all keep pointing at the same
    // objects.
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

    // Pull requests. Without gh there is nothing to ask, and the header says so
    // rather than leaving a column of zeroes that means nothing.
    let poller = null;
    if (options.pr && rows.some(ghLib.pollable)) {
        const auth = await ghLib.available();
        if (!auth.ok) {
            state.notes.gh = auth.reason;
            for (const repo of rows) repo.pr.unknown = true;
        } else if (options.once) {
            const ghGate = limiter(GIT_CONCURRENCY);
            await Promise.all(
                rows.filter(ghLib.pollable).map((repo) =>
                    ghGate(async () => {
                        const result = await ghLib.openPullRequests(repo);
                        if (result.ok) {
                            repo.pr.count = result.numbers.length;
                            repo.pr.baseline = new Set(result.numbers);
                        } else {
                            repo.pr.unknown = true;
                        }
                    }),
                ),
            );
        } else {
            poller = ghLib.createPoller({
                repos: () => rows,
                interval: options.prInterval,
                maxPerMinute: options.prRate,
                onUpdate: () => {
                    // Say so when there are too many repositories to ask about
                    // as often as the user asked.
                    state.notes.pr = poller.stretched() ? `pr every ${poller.interval()}s` : '';
                    requestRender();
                },
            });
        }
    } else if (options.pr) {
        state.notes.pr = 'no GitHub remotes';
    }

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

    const targets = () =>
        state.selected.size > 0 ? rows.filter((repo) => state.selected.has(repo.dir)) : rows.slice(state.cursor, state.cursor + 1);

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

    const onMenuKey = (key) => {
        if (key === 'escape' || key === 'q') {
            state.mode = 'table';
            draw();
            return;
        }
        if (key === 'up') {
            state.menuIndex = (state.menuIndex - 1 + state.actions.length) % state.actions.length;
            draw();
            return;
        }
        if (key === 'down') {
            state.menuIndex = (state.menuIndex + 1) % state.actions.length;
            draw();
            return;
        }
        if (key === 'enter') {
            runAction(state.actions[state.menuIndex]);
            return;
        }
        if (/^[1-9]$/.test(key)) {
            const action = state.actions[Number(key) - 1];
            if (action) {
                state.menuIndex = Number(key) - 1;
                runAction(action);
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
    poller?.start();

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
    poller?.stop();
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
