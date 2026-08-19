#!/usr/bin/env node
// repo-master — one live table for every git repository under a folder.
//
// It finds the repositories (nested checkouts and submodules included), watches
// their working trees, and paints the lot as a table that keeps itself up to
// date. Rows that want attention wear an orange bar. Pick rows with the arrow
// keys or find them with /, add more with space, and press enter for the menu of
// what may be done to them: open them in an editor or an agent, read what
// changed, fetch, pull, push, switch or make a branch, merge, rebase, branch a
// worktree off one, commit and push the lot, stash what is uncommitted, put a
// stash back or throw the changes away, or delete a folder outright. The commands
// worth reaching for carry a key of their own, and the menu prints it beside them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const gitLib = require('./lib/git.js');
const reposLib = require('./lib/repos.js');
const ignoreLib = require('./lib/ignore.js');
const actionsLib = require('./lib/actions.js');
const usageLib = require('./lib/usage.js');
const setupLib = require('./lib/setup.js');
const { watchAll } = require('./lib/watch.js');
const { createScreen, RESET } = require('./lib/screen.js');
const { createPalette, frame } = require('./lib/table.js');
const { limiter, expandHome, shortenHome } = require('./lib/util.js');

const VERSION = '0.0.1';

const DEFAULTS = {
    depth: 4,
    refresh: 30, // full sweep, in case a file watcher missed something
    ignoreFile: ignoreLib.FILE, // read in the watched folder, when it is there
};

/** How many git processes may run at once, however many repositories there are. */
const GIT_CONCURRENCY = 4;
/** Redraws are coalesced this long, so a burst of edits paints once. */
const RENDER_MS = 60;
/** How long a line under the table is worth reading before it is in the way. */
const MESSAGE_MS = 3000;
/** The clock the "last updated" column is read against moves on its own. */
const TICK_MS = 5000;

function usage() {
    console.log(`Usage: gift repo-master [DIR] [options]

Watch every git repository under DIR and show them as a live table. Without a
directory it watches the configured repo_root — functions.repo-master in gift's
config.json. With nothing configured either, it asks for the folder here, before
the table goes up, and writes down the answer; where there is nobody to ask — a
pipe, --once — it watches the current directory.

Options:
  --repo-root=PATH     Folder to watch; same as the positional argument (--dir also works)
  --depth=N            How many folders deep to search        (default ${DEFAULTS.depth})
  --refresh=SEC        Seconds between full git sweeps        (default ${DEFAULTS.refresh})
  --ignore-file=PATH   Folders to leave out of the table      (default ${DEFAULTS.ignoreFile} in the watched folder)
  --once               Print the table once and exit
  -h, --help           Show this help

Keys:
  up/down or k/j   move                  space   add to the selection
  enter            the command menu      /       search the table
  e                open with code        v       pick a file, open with vim
  c                open with claude      d       read the diff
  f                fetch                 p       pull
  P                push                  s       stash the changes
  u                discard the changes   b       switch branch
  n                new branch            m       merge a branch in
  r                rebase onto a branch  D       delete the folder
  t then a         add a worktree        R       refresh now
  esc              clear                 q       quit

Every one of those keys runs a command the enter menu also holds a row for, on
the repositories picked with space — or the row under the cursor when none are.
The menu prints each command's key beside it, so nothing has to be learned twice.

The ones that open something open the main project — the first repository picked
— and claude and codex are handed the rest as directories they may also work in.
vim, claude and codex want a terminal of their own and borrow this one: the table
steps aside and comes back when they exit. vim is opened on a file rather than the
folder, and fzf asks which one in the borrowed terminal first: fd lists the files
.gitignore does not rule out, bat shows whichever one the cursor is on, and your
own $FZF_DEFAULT_COMMAND is the list instead where you have set one. Picking
nothing opens nothing.
The ones that reach a remote, the ones that empty a working tree or fill it back
up, and the one that deletes a folder are asked for first in a box naming every
repository they are about: enter runs it, esc backs out. Pulling marks the ones
with uncommitted changes, which is where a pull goes wrong; discarding and
deleting mark all of them, because nothing undoes either, and the delete box says
what else is inside the folders. What came of each is reported in a box of its own.

P pushes what is already committed and commits nothing, for the commits that were
made in an editor or an agent and never left the machine. A branch level with its
upstream is left alone; one that has never been pushed is given an upstream.

s puts the changes of everything picked aside — git stash push -u, so untracked
files go with them and the working tree comes out clean — and u throws the same
changes away instead. A discard does not come back at all, which is why its box is
drawn the way the delete box is and answered by the keyboard alone. Neither one
touches ignored files, and neither touches a repository nested inside another:
those have rows of their own.

restore stash is what brings a stash back: git stash pop in every picked
repository, the newest entry of each and no more. It has no key of its own and is
run from the menu, and its box says what each repository has to give back before
enter — the entry it would pop, how many it is keeping after that one, and which
repositories have nothing stashed at all. A pop that conflicts is left standing
the way a merge is: git keeps the entry, and the row says how many files are
waiting.

b, n, m and r are the four that take a branch name, and all four ask for it in the
one box: b checks a branch out, n makes one off whatever is checked out, m merges
a branch into what is checked out, and r rebases what is checked out onto another.
The box lists every picked repository under the line as the name is typed, saying
which branch each is on and whether it has heard of the name — here, on origin, or
nowhere — so a name that is in two of your three repositories is seen before enter
rather than after it. A branch only origin has is made here and set to follow it.
Nothing throws work away: a merge or a rebase that hits a conflict stops where git
stopped, says how many files are waiting, and names the way back out.

t then a adds a worktree: a box asks for a branch, and each picked repository
gets a folder beside it named for the two of them — ~/projects/gift-feature-x for
feature-x in ~/projects/gift — which is a row of its own as soon as it exists. A
branch that is already here is checked out, one that is only on origin is
followed, and a new name is a new branch off HEAD.

A .gitignore in the watched folder is the folders the table is to leave out —
git's own syntax, one to a line, # for a comment, ! to let one back in, * and **
where a name is a shape. A folder it rules out is neither scanned nor listed, and
neither is anything inside it, so an archive of finished work costs nothing to
walk past. The header says how many were left out. --ignore-file names the file
where .gitignore is the wrong one to write in.

/ narrows the table to the repositories whose name, path or branch holds what is
typed. The list narrows as it is typed; enter keeps it and gives the keys back,
esc undoes it. Everything else goes on as before behind it — rows are watched and
counted whether or not the search is showing them.

The mouse does the whole of a run on its own: the wheel moves through the table
and through the menu, and a click is the enter key — it opens the menu on the
row the wheel left the cursor on, and runs the command the wheel left the menu
pointing at. Where the pointer is lying makes no difference to either. The wheel
scrolls the diff and the reports as well. A delete and a discard are the two
things a click will not answer for. Selecting text with the mouse needs a modifier
held down while the table is up — option in iTerm2, shift most other places.

commit & push treats every picked repository as a project of its own: it asks for
a message in a box, then commits and pushes each of them with it, none the main
project of the others.`);
}

function parseArgs(argv, env) {
    const options = {
        dir: env.GIFT_REPO_MASTER_REPO_ROOT || '',
        depth: Number(env.GIFT_REPO_MASTER_DEPTH) || DEFAULTS.depth,
        refresh: Number(env.GIFT_REPO_MASTER_REFRESH) || DEFAULTS.refresh,
        // An empty one is somebody turning this off rather than somebody saying
        // nothing, so the environment answers even when the answer is nothing.
        ignoreFile: env.GIFT_REPO_MASTER_IGNORE_FILE ?? DEFAULTS.ignoreFile,
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
        else if (argument.startsWith('--ignore-file=')) options.ignoreFile = argument.slice(14);
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

/**
 * What the header says about the folders the ignore file left out. A table of
 * eleven repositories out of a folder of thirty should say so somewhere, and
 * this is the line where it costs nothing; a folder with no ignore file, or one
 * that ruled nothing out, says nothing.
 */
function ignoredNote(count) {
    return count > 0 ? `${count} ignored` : '';
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

    const interactive = !options.once && process.stdin.isTTY && process.stdout.isTTY;

    // Which folder to watch. A path on the command line answers for this run and
    // the configured repo_root answers for every run; with neither, there is a
    // question to ask, and here — before the screen is taken over — is where
    // there is still a terminal in words to ask it on. The answer is written
    // down, so it is asked the first time and not again. Nobody who cannot
    // answer is asked: down a pipe, or with --once, the old fallback stands and
    // the directory the command was run in is the folder.
    if (!options.dir && interactive) {
        const asked = await setupLib.askForRoot();
        if (asked.status !== 'ok') {
            console.log('Nothing to watch.');
            return 130;
        }
        options.dir = asked.root;
    }

    const root = path.resolve(options.dir ? expandHome(options.dir) : process.cwd());
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        console.error(`repo-master: ${root} is not a folder`);
        return 1;
    }

    // The folders to leave out, read fresh on every sweep rather than held: the
    // file is edited to change what the table shows, and a table that went on
    // showing what the file said when it started would want restarting to be
    // believed.
    let ignores = await ignoreLib.load(root, options.ignoreFile);

    const scanned = await reposLib.discover(root, options.depth, ignores);
    const found = reposLib.arrange(root, scanned.dirs);
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
        actions: usageLib.sort(actionsLib.actions(process.env)),
        notes: { ignored: ignoredNote(scanned.ignored), watch: '' },
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

    /**
     * Say something on the line under the table, and take it back three seconds
     * later. What is said there is what has just happened — what a command did,
     * what it would not do — and something that just happened stops being news:
     * a line about a push that finished a minute ago is only in the way of the
     * table it sits under, and of the next thing worth saying.
     *
     * `fades: false` is for the one kind of line that is not an outcome but a
     * state — something is going on — where whoever put it up takes it down when
     * the work is over, however long that turns out to be. Saying nothing takes
     * back whatever was there, which is what the boxes do on their way open.
     */
    let messageTimer = null;
    const say = (text, { fades = true } = {}) => {
        if (messageTimer) clearTimeout(messageTimer);
        messageTimer = null;
        state.message = text || '';
        if (!state.message || !fades) return;
        messageTimer = setTimeout(() => {
            messageTimer = null;
            state.message = '';
            draw();
        }, MESSAGE_MS);
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
    let onRowsChanged = () => { };
    let scanning = false;
    const rescan = async () => {
        if (scanning) return false;
        scanning = true;
        try {
            ignores = await ignoreLib.load(root, options.ignoreFile);
            const swept = await reposLib.discover(root, options.depth, ignores);
            state.notes.ignored = ignoredNote(swept.ignored);

            const discovered = reposLib.arrange(root, swept.dirs);
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

    const markUsed = (action) => {
        try {
            const counts = usageLib.record(action.id);
            state.actions = usageLib.sort(state.actions, counts);
        } catch {
            // Usage history must never stop the command it is observing.
        }
    };

    const openMenu = () => {
        const chosen = targets();
        if (chosen.length === 0) return;
        state.menuTargets = chosen;
        state.menuIndex = 0;
        state.mode = 'menu';
        say('');
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
                openPreview(chosen[0], action);
                return;
            case 'sync':
                askSync(action, chosen, back);
                return;
            case 'clear':
                askClear(action, chosen, back);
                return;
            case 'restore':
                askRestore(action, chosen, back);
                return;
            case 'delete':
                askDelete(action, chosen, back);
                return;
            case 'branch':
                askBranch(action, chosen, back);
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
    const ask = (action, chosen, back, submit, list = null, extra = {}) => {
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
            ...extra,
        };
        say('');
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
        markUsed(action);
        state.mode = 'table';
        state.busy = true;
        say('');
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

        say(message || '');
        draw();
    };

    let reportTimer = null;

    /** Take the box down, and leave under the table the one line it came to. */
    const closeReport = () => {
        const panel = state.report;
        if (reportTimer) clearTimeout(reportTimer);
        reportTimer = null;
        state.mode = 'table';
        state.report = null;
        if (panel?.summary) say(panel.summary);
        draw();
    };

    /** It was going to close itself; somebody started reading it. */
    const holdReport = () => {
        if (reportTimer) clearTimeout(reportTimer);
        reportTimer = null;
    };

    // Committing, fetching and pulling are the things the table does itself
    // rather than hand the terminal to somebody else for, so they say how they
    // are getting on: a line per repository in a box, rewritten as each one
    // moves.
    //
    // What the box does when the work is over depends on what came of it. One
    // with nothing but good news in it has been read by the time it is drawn —
    // the row says `fetched`, and that is the whole of it — so it takes itself
    // away after the three seconds any other line about something that just
    // happened gets, and leaves the summary under the table in its place. A
    // failure is the one thing in a box worth going back over, so a box with one
    // in it waits to be closed instead. So does one somebody is scrolling: that
    // is reading rather than waiting, and reading is not to be interrupted.
    //
    // @param {string} title What the box is called.
    // @param {string} label What the summary line calls the work afterwards.
    // @param {object[]} repos
    // @param {{done: string, skipped: string}} words How to count the outcomes up.
    // @param {(onUpdate: Function) => Promise<object[]>} start Kicks the work off.
    // @param {() => void} [after] What to put right afterwards. Refreshing the
    //   rows is enough for work done inside them; work that makes or unmakes a
    //   folder has to go looking for rows as well.
    const runReport = async (action, title, label, repos, words, start, after = refreshAll) => {
        markUsed(action);
        const entries = repos.map((repo) => ({ repo, state: 'pending', text: 'waiting…' }));
        state.mode = 'report';
        state.report = { title, entries, words, running: true, scroll: 0, view: 1 };
        state.busy = true;
        say('');
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
        // The line the box comes to, said when it goes rather than now: while it
        // is up it is already saying that and more, a repository at a time.
        state.report.summary = `${label}: ${summary.join(' · ') || 'nothing to do'}`;
        if (counted('failed') === 0) reportTimer = setTimeout(closeReport, MESSAGE_MS);
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
            .catch(() => { });
    };

    const runCommit = (action, repos, message) =>
        runReport(
            action,
            `${action.label} · "${message}"`,
            action.label,
            repos,
            { done: 'pushed', skipped: 'unchanged' },
            (onUpdate) => actionsLib.commit(repos, message, onUpdate),
        );

    /** `3 repositories`, for the boxes that head themselves with how many. */
    const counting = (repos) => `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`;

    const runSync = (kind, repos) =>
        runReport(
            command(kind),
            `${actionsLib.SYNC[kind].label} · ${counting(repos)}`,
            actionsLib.SYNC[kind].label,
            repos,
            actionsLib.SYNC[kind].words,
            (onUpdate) => actionsLib.sync(repos, kind, onUpdate),
        );

    // Stashing and discarding both leave a working tree emptier than they found
    // it, which is what the rows count, so a refresh afterwards is the whole of
    // what has to be put right: no folder came or went.
    const runClear = (kind, repos) =>
        runReport(
            command(kind),
            `${actionsLib.CLEAR[kind].label} · ${counting(repos)}`,
            actionsLib.CLEAR[kind].label,
            repos,
            actionsLib.CLEAR[kind].words,
            (onUpdate) => actionsLib.clear(repos, kind, onUpdate),
        );

    // A restore fills a working tree back up, which is the same column the stash
    // that emptied it moved: a refresh of the rows is the whole of what has to be
    // put right afterwards.
    const runRestore = (action, repos) =>
        runReport(
            action,
            `${action.label} · ${counting(repos)}`,
            action.label,
            repos,
            { done: 'restored', skipped: 'nothing stashed' },
            (onUpdate) => actionsLib.restore(repos, onUpdate),
        );

    // Switching, branching, merging and rebasing all move a repository without
    // moving a folder: the branch column changes, or what is on that branch does,
    // and refreshing the rows is the whole of what has to be put right.
    const runBranch = (kind, repos, name) =>
        runReport(
            command(kind),
            `${actionsLib.BRANCH[kind].label} · ${name}`,
            actionsLib.BRANCH[kind].label,
            repos,
            actionsLib.BRANCH[kind].words,
            (onUpdate) => actionsLib.branch(repos, kind, name, onUpdate),
        );

    // A worktree is a folder that was not there before, and a folder under the
    // watched root is a row: the rescan is what turns the one into the other,
    // rather than leaving it to the next sweep half a minute later.
    const runWorktree = (action, repos, branch) =>
        runReport(
            action,
            `${action.label} · ${branch}`,
            action.label,
            repos,
            { done: 'added', skipped: 'left alone' },
            (onUpdate) => actionsLib.worktrees(repos, branch, onUpdate),
            rescanAfter,
        );

    const runDelete = (action, repos) =>
        runReport(
            action,
            `${action.label} · ${repos.length} ${repos.length === 1 ? 'folder' : 'folders'}`,
            action.label,
            repos,
            { done: 'deleted', skipped: 'gone already' },
            (onUpdate) => actionsLib.remove(repos, onUpdate),
            rescanAfter,
        );

    // Fetching, pulling and pushing are asked for before they are done, because
    // they reach a remote, a pull writes into a working tree and a push writes to
    // somewhere other people read. The box is what goes between: it names every
    // repository about to be reached for, and pulling marks the ones with
    // uncommitted changes, which is where a pull goes wrong.
    const askSync = (action, chosen, back) => {
        state.mode = 'confirm';
        state.confirm = { kind: action.sync, action, targets: chosen, back, scroll: 0, view: 1 };
        say('');
        draw();
    };

    /**
     * Stashing and discarding are asked for in the same box, because both empty a
     * working tree — and the second one is asked for in earnest, the way deleting
     * is, because a discard is the one of the two with nothing to undo it.
     *
     * Nothing to clear is not worth a box asking whether to clear it: a keystroke
     * on a folder of repositories with nothing in them says so on the message line
     * and leaves the table where it was.
     */
    const askClear = (action, chosen, back) => {
        if (chosen.every((repo) => repo.loaded && !repo.hasChanges)) {
            state.mode = 'table';
            say(`${action.label}: nothing changed in ${chosen.length === 1 ? chosen[0].name : counting(chosen)}`);
            draw();
            return;
        }

        state.mode = 'confirm';
        state.confirm = { kind: action.clear, action, targets: chosen, back, scroll: 0, view: 1 };
        say('');
        draw();
    };

    /**
     * A restore is asked for in a box of its own, the way the commands that empty
     * a working tree are: a pop writes into one, and which repositories it is
     * about to write into is worth reading before enter rather than after it.
     *
     * What each one has to give back is read while the box is up. A stash list is
     * a git process per repository — a whole sweep's worth for a box of thirty —
     * so it is read once when the box opens rather than on every refresh, and the
     * rows fill themselves in as the answers arrive.
     */
    const askRestore = (action, chosen, back) => {
        const panel = {
            kind: 'restore',
            action,
            targets: chosen,
            back,
            scroll: 0,
            view: 1,
            // Filled in as each repository answers. A repository not in it yet is
            // one the box has nothing to say about.
            stashes: new Map(),
        };

        state.mode = 'confirm';
        state.confirm = panel;
        say('');
        draw();
        loadStashes(panel);
    };

    // A box closed and opened again reads afresh — stashes come and go — and a
    // slower read of a box no longer up has nothing to say.
    const loadStashes = (panel) => {
        for (const repo of panel.targets) {
            gate(() => gitLib.stashList(repo.dir))
                .then((found) => {
                    if (state.confirm !== panel) return;
                    panel.stashes.set(repo.dir, found);
                    requestRender();
                })
                .catch(() => { });
        }
    };

    // The branch names the box needs to mark the repositories it is about. They
    // are read once when the box opens rather than once per keystroke — a name is
    // typed a letter at a time and git is a process a time — and put back into the
    // box as each answer arrives, so the marks fill in under the line being typed.
    // A box closed and opened again reads afresh: branches come and go.
    let branchToken = 0;
    const loadBranches = (field, chosen) => {
        const token = ++branchToken;
        for (const repo of chosen) {
            gate(() => gitLib.branches(repo.dir))
                .then((found) => {
                    // A slower read of a box already closed, or of an older one,
                    // has nothing to say.
                    if (token !== branchToken || state.input !== field) return;
                    field.branches.set(repo.dir, found);
                    requestRender();
                })
                .catch(() => { });
        }
    };

    /**
     * What each picked repository would make of the name being typed: which branch
     * it is on now, which way the work runs, and whether it has heard of the name
     * at all — here, on origin, or nowhere.
     *
     * The mark is the point of the box. `feature-x` is in two of your three
     * repositories more often than it is in all three, and the row that says `no
     * such branch` before enter is pressed is worth more than the report that says
     * it afterwards. Until the branches are read there is no mark: saying nothing
     * about a name beats saying something wrong about it.
     */
    const branchLines = (kind, chosen, typed) => {
        const name = typed.trim();

        return chosen.map((repo) => {
            const here = repo.branch || '…';
            const found = state.input?.branches?.get(repo.dir);

            // Nothing typed yet: how many branches there are to type the name of.
            if (!name) {
                const count = found ? `  · ${found.local.length} ${found.local.length === 1 ? 'branch' : 'branches'}` : '';
                return { name: repo.name, text: `${here}${count}` };
            }

            // The name of the branch already checked out means something
            // different to each of the four, and all four say it here rather than
            // leave it to the report: switching there is being there already, and
            // merging or rebasing a branch into itself is not work at all.
            if (name === repo.branch) {
                const itself = kind === 'merge' || kind === 'rebase';
                return {
                    name: repo.name,
                    text: `${here}  · ${itself ? 'the branch it is on' : kind === 'create' ? 'here already' : 'already there'}`,
                    tone: itself || kind === 'create' ? 'warn' : undefined,
                };
            }

            // What the name is so far, which is not the same question as what it
            // is. A name is typed a letter at a time, and every letter of
            // `feature-x` before the last is a name no repository has: marking
            // those in orange would be an alarm going off through the whole of
            // typing. So a name still on its way to one of this repository's
            // branches counts them instead, and only a name that has left them all
            // behind is the warning it looks like.
            const exact = !found ? '' : found.local.includes(name) ? 'here' : found.remote.includes(name) ? 'on origin' : '';
            const ahead = !found || exact ? [] : [...new Set([...found.local, ...found.remote])].filter((branch) => branch.startsWith(name));

            const missing = kind === 'create' ? Boolean(exact) : Boolean(found) && !exact && ahead.length === 0;
            const mark = kind === 'create'
                ? exact && 'here already'
                : exact || (!found ? '' : ahead.length > 0 ? `${ahead.length} start with it` : 'no such branch');
            // A merge and a rebase both run into the working tree, so what is
            // uncommitted in it is worth naming — that is where either goes wrong.
            const dirty = (kind === 'merge' || kind === 'rebase') && repo.hasChanges ? '  · uncommitted' : '';

            const work =
                kind === 'merge' ? `${name} → ${here}` : kind === 'rebase' ? `${here} onto ${name}` : `${here} → ${name}`;
            return {
                name: repo.name,
                text: `${work}${mark ? `  · ${mark}` : ''}${dirty}`,
                tone: missing ? 'warn' : undefined,
            };
        });
    };

    /**
     * The four commands that take a branch name ask for it in the one box, the way
     * `commit & push` asks for a message: type it, watch what each repository
     * would do with it appear underneath, and press enter.
     *
     * There is no second box asking whether it was meant. The list under the line
     * is that question, asked while the answer is still being typed — and none of
     * the four throws work away: a switch git cannot make it refuses, a merge and
     * a rebase that hit a conflict stop and say so, and a branch name already
     * taken is git's to turn down.
     */
    const askBranch = (action, chosen, back) => {
        const kind = action.branch;
        ask(
            action,
            chosen,
            back,
            (name) => runBranch(kind, chosen, name),
            (typed) => branchLines(kind, chosen, typed),
            { branches: new Map() },
        );
        loadBranches(state.input, chosen);
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
            say(`${action.label}: ${shortenHome(root)} is the folder being watched`);
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
        say('');
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
        // only for the two commands nothing undoes: neither a folder nor a day's
        // uncommitted work is to be thrown away by a mouse that was somewhere near
        // the box, and the keyboard is where the answer to a question that final
        // should come from. A stash is not one of them — it keeps what it takes.
        const final = panel.kind === 'delete' || panel.kind === 'discard';
        if (key === 'enter' || (key === 'click' && !final)) {
            const { kind, action, targets: chosen } = panel;
            state.confirm = null;
            // Which work was asked about follows from the kind of command, as the
            // box it was asked in did; `kind` is which of that command's pair.
            if (action.kind === 'delete') runDelete(action, chosen);
            else if (action.kind === 'clear') runClear(kind, chosen);
            else if (action.kind === 'restore') runRestore(action, chosen);
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

    const openPreview = (repo, action = command('diff')) => {
        if (!repo) return;
        markUsed(action);
        state.mode = 'preview';
        say('');
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
        say('');
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
            closeReport();
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
        holdReport();
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
            // editor opens, the ones that reach a remote or empty a working tree
            // ask, delete and discard ask in earnest.
            case 'e':
                startAction(command('code'), targets(), 'table');
                return;
            case 'v':
                startAction(command('vim'), targets(), 'table');
                return;
            case 'c':
                startAction(command('claude'), targets(), 'table');
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
            // The same letter in both cases for the two halves of the same
            // errand: take what is there, hand over what is here.
            case 'P':
                startAction(command('push'), targets(), 'table');
                return;
            case 's':
                startAction(command('stash'), targets(), 'table');
                return;
            case 'u':
                startAction(command('discard'), targets(), 'table');
                return;
            // The four that take a branch name. Each one opens the same box and
            // asks for it; what the name then means is the command's own business.
            case 'b':
                startAction(command('switch'), targets(), 'table');
                return;
            case 'n':
                startAction(command('create'), targets(), 'table');
                return;
            case 'm':
                startAction(command('merge'), targets(), 'table');
                return;
            case 'r':
                startAction(command('rebase'), targets(), 'table');
                return;
            case 'D':
                startAction(command('delete'), targets(), 'table');
                return;
            case 't': {
                const chosen = targets();
                if (chosen.length === 0) return;
                state.menuTargets = chosen; // the box says which repositories it is about
                state.mode = 'worktree';
                say('');
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
                say('');
                draw();
                return;
            // Refreshing wears the capital because rebasing wanted the small
            // letter, and between the two it is refreshing that can be waited for:
            // the table sweeps itself every half minute and watches every working
            // tree besides, so this is only ever asking for the sweep sooner.
            case 'R':
                // Not an outcome but a state: the sweep it stands for is what
                // takes it back down, however long the folder takes to read.
                say('refreshing…', { fades: false });
                draw();
                rescan()
                    .then(refreshAll)
                    .catch(() => { })
                    .then(() => {
                        say('');
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
            .catch(() => { });
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
    if (messageTimer) clearTimeout(messageTimer);
    if (reportTimer) clearTimeout(reportTimer);
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
