// Drawing the table.
//
// Rows are highlighted by their background, never by recolouring their text: a
// row wanting attention — one whose working tree changed — gets a Claude-orange
// bar, and the rows the user is pointing at or has picked get the pale grey of an
// ordinary selection. The pointing one comes off after a quiet stretch — see
// `state.idle`, and the loop at the foot of frame() that reads it.
//
// A repository that has committed and not pushed gets a bar of its own, in a dark
// grey — far enough below both of those greys to be a mark of its own rather than
// a row that looks half-selected, and dark enough to want pale text rather than
// the dark ink the other three are written in. It is worth seeing without being
// an alarm, the work being committed and only still here, so the orange goes on
// meaning what it has always meant. Which of the two a row wearing both gets is
// decided in needsAttention.
//
// Everything else keeps the terminal's own colours.
'use strict';

const { width, pad, truncate, formatRelative, shortenHome } = require('./util.js');
const { overlay, patchTone } = require('./modal.js');
const reposLib = require('./repos.js');

/** Each colour as a truecolor triple and as its nearest xterm-256 shade. */
const ORANGE = { rgb: [217, 119, 87], xterm: 173 }; // Claude's orange
const CURSOR_GREY = { rgb: [214, 214, 214], xterm: 252 }; // the row under the cursor
const SELECTED_GREY = { rgb: [168, 168, 168], xterm: 248 }; // rows picked with space
const UNPUSHED_GREY = { rgb: [100, 100, 100], xterm: 241 }; // committed, not pushed
const INK = { rgb: [32, 32, 32], xterm: 235 }; // text drawn on top of a pale bar
const PAPER = { rgb: [238, 238, 238], xterm: 255 }; // and on top of a dark one
const GREEN = { rgb: [87, 166, 106], xterm: 71 }; // an added line in the preview
const RED = { rgb: [197, 90, 90], xterm: 167 }; // a removed one

const RESET = '\x1b[0m';

function createPalette(stream) {
    const enabled =
        Boolean(stream.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
    const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '');

    const fg = (colour) =>
        truecolor ? `\x1b[38;2;${colour.rgb.join(';')}m` : `\x1b[38;5;${colour.xterm}m`;
    const bg = (colour) =>
        truecolor ? `\x1b[48;2;${colour.rgb.join(';')}m` : `\x1b[48;5;${colour.xterm}m`;

    /**
     * A row highlight: a coloured bar with the text that can be read on it — dark
     * ink on the pale colours, pale on the one dark enough to swallow it.
     */
    const barCode = (colour, ink = INK) => `${bg(colour)}${fg(ink)}`;

    const wrap = (code) => (text) => (enabled && text ? `${code}${text}${RESET}` : text);
    return {
        enabled,
        orange: wrap(fg(ORANGE)),
        added: wrap(fg(GREEN)),
        removed: wrap(fg(RED)),
        dim: wrap('\x1b[2m'),
        bold: wrap('\x1b[1m'),
        attentionBar: wrap(barCode(ORANGE)),
        cursorBar: wrap(barCode(CURSOR_GREY)),
        selectedBar: wrap(barCode(SELECTED_GREY)),
        unpushedBar: wrap(barCode(UNPUSHED_GREY, PAPER)),
        // The terminal's own cursor is hidden while the table is up, so a box
        // being typed into draws its own out of reversed video.
        caret: wrap('\x1b[7m'),
    };
}

/** `  +- ` in front of a nested repository, one indent per level. */
function treePrefix(depth) {
    return depth === 0 ? '' : `${'  '.repeat(depth)}+- `;
}

/**
 * What a repository has committed here and nowhere else, in the words the status
 * column and the preview's own heading both use. A repository standing ahead of
 * its upstream says how far; one whose branch has never been pushed says only
 * that, because there is no upstream to count against and the answer is "all of
 * it". Null where there is nothing waiting.
 */
function unpushedCell(repo) {
    if (!repo.unpushed) return null;
    return repo.ahead > 0 ? `${repo.ahead} unpushed` : 'unpushed';
}

/**
 * What a row has in it. The working tree comes first where there is something in
 * both — it is the half that is not committed anywhere at all, and the half `c`
 * empties; `P` is for what is left after that.
 */
function statusCell(repo) {
    if (repo.error) return 'error';
    if (!repo.loaded) return '…';
    if (repo.hasChanges) return 'has changes';
    return unpushedCell(repo) || 'no changes';
}

/**
 * `+1203 -30` for the table, and `+1203 lines -30 lines` for the boxes that say
 * it in a sentence. The table takes the short one whatever room it has: a column
 * of counts is read by comparing the numbers down it, and the word repeated on
 * every row of every half is four times as much to look past as there is to
 * read.
 */
function diffCells(repo) {
    if (!repo.loaded || repo.error) return { long: '-', short: '-' };
    if (repo.adds === 0 && repo.dels === 0) return { long: '-', short: '-' };

    const lines = (count) => (count === 1 ? 'line' : 'lines');
    const parts = [];
    const short = [];
    if (repo.adds > 0) {
        parts.push(`+${repo.adds} ${lines(repo.adds)}`);
        short.push(`+${repo.adds}`);
    }
    if (repo.dels > 0) {
        parts.push(`-${repo.dels} ${lines(repo.dels)}`);
        short.push(`-${repo.dels}`);
    }
    return { long: parts.join(' '), short: short.join(' ') };
}

/**
 * Whether a row is one of the ones wanting attention: one with something in its
 * working tree, which is work no repository anywhere has a copy of.
 *
 * A repository that has committed and not pushed is not one of these. It wears
 * the dark grey bar instead — worth seeing, but the work is committed, and an
 * alarm that goes off for both says less about either. A row with both in it
 * wears the orange, the uncommitted half being the more urgent fact.
 */
function needsAttention(repo) {
    return Boolean(repo.hasChanges);
}

/**
 * The keys along the foot of the window: the table's own — moving, picking,
 * searching, refreshing, leaving — and not one command among them. Every command
 * has a row in the menu with its key printed beside it, and the foot was long
 * enough to be cut short by repeating them, which is the worst of both: a line
 * ending in an ellipsis, saying less than the menu says in full.
 *
 * They are written in the order they are worth reading, and cut at a whole one
 * rather than through the middle of a word, for a window narrow enough to need
 * it — where the ellipsis says there is more of this than fits.
 */
function keyLine(entries, columns) {
    if (width(entries.join(' · ')) <= columns) return entries.join(' · ');

    const kept = [...entries];
    while (kept.length > 1 && width(`${kept.join(' · ')} · …`) > columns) kept.pop();
    return truncate(`${kept.join(' · ')} · …`, columns);
}

// The boxes drawn over the table. Each mode builds one panel for modal.js to
// draw — what is in it, how it is coloured, and what the footer says. The table
// itself is drawn either way and goes on refreshing underneath.

/** How wide each box would like to be; the modal narrows them all to fit. */
const MENU_WIDTH = 64;
const PROMPT_WIDTH = 88;
const REPORT_WIDTH = 96;
/** Room a repository's name is given inside a box before it is cut. */
const NAME_WIDTH = 28;

/** `name    what about it`, the names lined up under one another. */
function labelled(entries) {
    const column = Math.min(NAME_WIDTH, Math.max(...entries.map((entry) => width(entry.name)), 0));
    return entries.map((entry) => `${pad(truncate(entry.name, column), column)}  ${entry.text}`);
}

/** A repository's changes in a few words, for the boxes that list them. */
function changeCell(repo) {
    if (!repo.hasChanges) return 'no changes';
    const counts = diffCells(repo);
    return counts.long === '-' ? 'has changes' : counts.long;
}

/**
 * The preview: what a repository has that is only here — the commits that never
 * left the machine, and then the patch. Its title is written from the row as it
 * stands now rather than as it stood when the box opened — the row goes on
 * refreshing underneath, and the heading saying so is the hint that the patch
 * itself wants an `r`.
 */
function previewPanel(state) {
    const panel = state.preview;
    if (!panel) return null;

    const repo = panel.repo;
    const counts = diffCells(repo);
    return Object.assign(panel, {
        title: [repo.name, repo.branch || '…', unpushedCell(repo), counts.long === '-' ? null : counts.long]
            .filter(Boolean)
            .join(' · '),
        paint: patchTone,
        count: !panel.loading, // nothing to count yet, and one placeholder line to miscount
        status: panel.loading ? 'reading…' : '',
        footer: 'up/down scroll · space page · r reload · esc close',
    });
}

/**
 * The menu enter opens: what may be run on the repositories that were picked.
 *
 * Every command that also has a key of its own says so, in a column down the
 * right — this is the one place the whole list is written down, and somebody
 * reading it to find a command is exactly the person who would rather press one
 * key next time.
 */
function menuPanel(state) {
    const [main, ...added] = state.menuTargets;
    const on = main ? main.name : `${state.menuTargets.length} repos`;
    const digits = String(state.actions.length).length;
    const column = Math.max(...state.actions.map((action) => width(action.label)));

    return {
        title: `Run on ${on}${added.length > 0 ? ` + ${added.length} more` : ''}`,
        lines: state.actions.map((action, index) => {
            const row = `${index === state.menuIndex ? '>' : ' '} ${String(index + 1).padStart(digits)}  `;
            return `${row}${action.key ? `${pad(action.label, column)}   ${action.key}` : action.label}`;
        }),
        paint: (line, index) => (index === state.menuIndex ? 'bold' : null),
        footer: `1-${Math.min(9, state.actions.length)} pick · up/down move · enter run · esc cancel`,
        // Only of any use in a window too short for the whole menu, where it
        // keeps the line being pointed at on screen; the modal clamps it.
        scroll: state.menuIndex,
        width: MENU_WIDTH,
    };
}

/**
 * What `t` opens: the worktree commands and the letter each answers to. One
 * command is a thin box, but a chord nobody can see the far half of is worse,
 * and this is where the next one goes.
 */
function worktreePanel(state) {
    const [main, ...added] = state.menuTargets;
    const on = main ? main.name : 'nothing';

    return {
        title: `Worktree · ${on}${added.length > 0 ? ` + ${added.length} more` : ''}`,
        lines: ['  a  add — a branch in a folder of its own, beside this one'],
        paint: () => 'dim',
        footer: 'a add · esc cancel',
        width: MENU_WIDTH,
    };
}

/**
 * The box a word is typed into — a commit message, a branch name — with the
 * repositories it is about listed under it. Nobody should have to remember what
 * they picked while writing the message for it, and what is worth saying about
 * each one depends on what is being asked: a commit is about what changed, a
 * worktree about the folder that is going to appear.
 */
function promptPanel(state) {
    const field = state.input;
    if (!field) return null;

    // The list is asked for the value as it stands, because for some questions
    // the answer is half of what is being listed: a branch being typed is a
    // folder appearing, letter by letter, under the line it is typed on.
    const entries = field.list
        ? field.list(field.value)
        : field.targets.map((repo) => ({ name: repo.name, text: changeCell(repo) }));
    const listed = labelled(entries);
    const count = `${field.targets.length} ${field.targets.length === 1 ? 'repo' : 'repos'}`;

    return {
        title: field.title,
        lines: [field.value, '', ...listed],
        // The field counts its caret in characters, as editing does; the box
        // draws in columns, which is not the same thing in every language.
        caret: { line: 0, column: width(field.value.slice(0, field.column)) },
        // Grey unless the row asked for a colour of its own: a branch name none of
        // this repository's branches match is the one thing in the box worth
        // noticing before enter, and it says so by wearing the orange.
        paint: (line, index) => (index < 2 ? null : entries[index - 2]?.tone || 'dim'),
        status: field.hint || count,
        footer: field.footer,
        width: PROMPT_WIDTH,
    };
}

/** `3 repositories`, the way the boxes head themselves. */
function counting(targets) {
    return `${targets.length} ${targets.length === 1 ? 'repository' : 'repositories'}`;
}

/** A command's label where a sentence starts, which is the head of a box. */
function capitalise(text) {
    return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/**
 * What is about to be done, and to what.
 *
 * The list is the point of it: `p` on a folder of thirty repositories is not a
 * keystroke anybody should be able to make without seeing which thirty. A pull
 * merges into a working tree, so the ones with something uncommitted in them are
 * marked, and named again in the footer. A push writes to somewhere other people
 * read, which is the same argument for being asked.
 */
function syncPanel(ask) {
    const { kind, targets } = ask;
    const dirty = kind === 'pull' ? targets.filter((repo) => repo.hasChanges) : [];

    return Object.assign(ask, {
        title: `${capitalise(ask.action.label)} ${counting(targets)}`,
        lines: labelled(
            targets.map((repo) => ({
                name: repo.name,
                text: `${repo.branch || '…'}${repo.hasChanges ? `  · ${changeCell(repo)} uncommitted` : ''}`,
            })),
        ),
        paint: (line, index) => (kind === 'pull' && targets[index] && targets[index].hasChanges ? 'warn' : 'dim'),
        status: dirty.length > 0 ? `${dirty.length} with uncommitted changes` : '',
        footer: `enter ${kind} · esc cancel`,
        width: REPORT_WIDTH,
    });
}

/**
 * The same box for the two commands that empty a working tree, and what each row
 * stands to lose from it: what changed there, which is exactly what is about to be
 * put aside or thrown away.
 *
 * A stash is drawn quietly, because `git stash pop` is the whole of the undo. A
 * discard is drawn the way the delete box is — the rows orange, the footer saying
 * so — because there is no undoing it and nobody should find that out afterwards.
 */
function clearPanel(ask) {
    const { kind, targets } = ask;
    const dirty = targets.filter((repo) => repo.hasChanges);

    return Object.assign(ask, {
        title: `${kind === 'stash' ? 'Stash' : 'Discard the changes of'} ${counting(targets)}`,
        lines: labelled(
            targets.map((repo) => ({
                name: repo.name,
                text: `${repo.branch || '…'}  · ${changeCell(repo)}`,
            })),
        ),
        paint: (line, index) => (kind === 'discard' && targets[index]?.hasChanges ? 'warn' : 'dim'),
        status: [
            `${dirty.length} with changes`,
            kind === 'discard' ? 'nothing undoes this' : 'git stash pop brings them back',
        ].join(' · '),
        footer: `enter ${kind} · esc cancel`,
        width: REPORT_WIDTH,
    });
}

/**
 * What each repository has to give back, and which entry of it that would be.
 *
 * The list is the point of the box, as it is everywhere else: a repository with
 * nothing stashed says so here rather than in the report, and one holding three
 * says how many it is keeping after this one. Until its stashes have been read
 * there is nothing said about them — saying nothing beats saying something wrong,
 * which is how the branch box waits too.
 *
 * Drawn quietly. A pop takes nothing away: what was put aside comes back to the
 * working tree, and an entry that will not go back in cleanly is kept where it is.
 */
function restorePanel(ask) {
    const { targets, stashes } = ask;
    const held = (repo) => stashes?.get(repo.dir);
    const read = targets.filter((repo) => held(repo));
    const holding = read.filter((repo) => held(repo).length > 0);

    return Object.assign(ask, {
        title: `Restore ${counting(targets)}`,
        lines: labelled(
            targets.map((repo) => {
                const entries = held(repo);
                if (!entries) return { name: repo.name, text: repo.branch || '…' };
                if (entries.length === 0) return { name: repo.name, text: `${repo.branch || '…'}  · nothing stashed` };
                const more = entries.length > 1 ? `  · ${entries.length - 1} more stashed` : '';
                return { name: repo.name, text: `${repo.branch || '…'}  · ${entries[0]}${more}` };
            }),
        ),
        paint: () => 'dim',
        status:
            read.length < targets.length
                ? 'reading…'
                : [`${holding.length} with something stashed`, 'the newest of each'].join(' · '),
        footer: 'enter restore · esc cancel',
        width: REPORT_WIDTH,
    });
}

/**
 * The same box, asked in earnest. Every other question in repo-master is asked
 * about something that can be done again; this one cannot be, so it is drawn to
 * be read rather than answered: every folder named with its path, the whole of
 * it orange, what is uncommitted in each said plainly, and the repositories that
 * are not being deleted but will be gone all the same — the ones living inside a
 * folder that is — named underneath.
 */
function deletePanel(ask) {
    const { targets, alsoGone } = ask;
    const lines = labelled([
        ...targets.map((repo) => ({
            name: repo.name,
            text: `${repo.relPath}${repo.hasChanges ? `  · ${changeCell(repo)} uncommitted` : ''}`,
        })),
        ...alsoGone.map((repo) => ({ name: repo.name, text: `${repo.relPath}  · inside one of them` })),
    ]);

    const dirty = targets.filter((repo) => repo.hasChanges).length;
    const said = [
        dirty > 0 ? `${dirty} with uncommitted changes` : '',
        alsoGone.length > 0 ? `${alsoGone.length} more inside them` : '',
        'nothing undoes this',
    ].filter(Boolean);

    return Object.assign(ask, {
        title: `Delete ${targets.length} ${targets.length === 1 ? 'folder' : 'folders'}`,
        lines,
        paint: (line, index) => (index < targets.length ? 'warn' : 'dim'),
        status: said.join(' · '),
        footer: 'enter delete · esc cancel',
        width: REPORT_WIDTH,
    });
}

/** Which box a question is asked in follows from what kind of command asked it. */
function confirmPanel(state) {
    const ask = state.confirm;
    if (!ask) return null;

    switch (ask.action.kind) {
        case 'delete':
            return deletePanel(ask);
        case 'clear':
            return clearPanel(ask);
        case 'restore':
            return restorePanel(ask);
        default:
            return syncPanel(ask);
    }
}

/** What became of each repository the work was run on, told as it happens. */
function reportPanel(state) {
    const report = state.report;
    if (!report) return null;

    const tones = { pending: 'dim', working: null, done: 'add', skipped: 'dim', failed: 'warn' };
    const counted = (name) => report.entries.filter((entry) => entry.state === name).length;
    const waiting = report.entries.filter((entry) => entry.state === 'working' || entry.state === 'pending').length;

    // What "done" and "skipped" are worth calling depends on what was run: a
    // commit pushes or leaves unchanged, a fetch finds something or does not.
    const words = report.words;
    const summary = [
        counted('done') > 0 ? `${counted('done')} ${words.done}` : null,
        counted('skipped') > 0 ? `${counted('skipped')} ${words.skipped}` : null,
        counted('failed') > 0 ? `${counted('failed')} failed` : null,
    ]
        .filter(Boolean)
        .join(' · ');

    return Object.assign(report, {
        lines: labelled(report.entries.map((entry) => ({ name: entry.repo.name, text: entry.text }))),
        paint: (line, index) => tones[report.entries[index]?.state] ?? null,
        status: report.running
            ? `${report.entries.length - waiting} of ${report.entries.length} done · working…`
            : summary || 'nothing to do',
        // A commit that stayed here leaves a key in the footer to carry it the
        // rest of the way, on the repositories this box is about and no others.
        footer: report.running
            ? ''
            : [report.push ? `P push ${report.push.length === 1 ? 'it' : 'them'}` : null, 'up/down scroll', 'esc close']
                .filter(Boolean)
                .join(' · '),
        width: REPORT_WIDTH,
    });
}

/** The box belonging to whatever the table is in the middle of, if any. */
function panelFor(state) {
    switch (state.mode) {
        case 'preview':
            return previewPanel(state);
        case 'menu':
            return menuPanel(state);
        case 'worktree':
            return worktreePanel(state);
        case 'input':
            return promptPanel(state);
        case 'confirm':
            return confirmPanel(state);
        case 'report':
            return reportPanel(state);
        default:
            return null;
    }
}

/**
 * The columns are sized from the window and nothing else — never from what is in
 * them, which is what used to make the table jump. Measured off the cells, every
 * column moved on any edit: a status turning from "no changes" to "has changes"
 * is a character wider, a diff crossing a thousand lines is another, a branch
 * with a ticket number in its name is eight, and each of them shifted every
 * column to the right of it. Now nothing an edit can do moves a column; only
 * resizing the terminal does.
 *
 * `want` is the width a column is given whenever there is room for it, and is
 * meant to hold the ordinary case: `has changes` in full, a diff of four digits
 * with the word "lines" on both halves. `min` is how far it may be squeezed in a
 * narrow window, and `max` how far a wide one may open it. Anything longer than
 * the width it ends up with is cut with an ellipsis, and can be read in full
 * from the preview.
 */
const COLUMNS = [
    { key: 'repo', title: 'repo', min: 12, want: 24, max: 34 },
    { key: 'path', title: 'path', min: 8, want: 20, max: 40 },
    { key: 'branch', title: 'branch', min: 6, want: 16, max: 24 },
    { key: 'status', title: 'status', min: 6, want: 11, max: 11 },
    { key: 'updated', title: 'last updated', min: 6, want: 12, max: 12 },
    // The diff column is the last one, and the line is trimmed after it, so
    // room given to it is room nobody sees — it takes none of a wide window's
    // spare, which is why its maximum is the width it wants. 14 holds
    // `+999999 -99999`, which is more than a working tree usually has in it.
    { key: 'diff', title: 'diff', min: 4, want: 14, max: 14 },
];

const GAP = 2;
const GUTTER = 2; // '> ' for the cursor, ' +' for a repository added to the main one

/** What the columns come to at a given set of widths, gaps and gutter included. */
function span(widths) {
    return GUTTER + COLUMNS.reduce((sum, column) => sum + widths[column.key], 0) + GAP * (COLUMNS.length - 1);
}

/**
 * Work out how wide each column may be, from the width of the window alone.
 *
 * Everything starts at the width it wants. A window too narrow for that takes
 * the difference off the widest column a character at a time, down to the
 * minimums; a window with room to spare hands it out a character at a time as
 * well, round the columns that have a use for it — the names and the paths and
 * the branches — until they are at their maximums or the room is gone.
 */
function layout(available) {
    const widths = Object.fromEntries(COLUMNS.map((column) => [column.key, column.want]));

    let shrinkable = COLUMNS.filter((column) => !column.fixed);
    while (span(widths) > available) {
        const widest = shrinkable
            .filter((column) => widths[column.key] > column.min)
            .sort((a, b) => widths[b.key] - widths[a.key])[0];
        if (!widest) break;
        widths[widest.key]--;
    }

    // Round-robin rather than filling one column and moving on, so the spare
    // room of a wide window is shared out instead of landing all on the repo.
    let growable = COLUMNS.filter((column) => widths[column.key] < column.max);
    while (growable.length > 0 && span(widths) < available) {
        for (const column of growable) {
            if (span(widths) >= available) break;
            widths[column.key]++;
        }
        growable = growable.filter((column) => widths[column.key] < column.max);
    }
    return widths;
}

function joinRow(cells, widths) {
    return COLUMNS.map((column) => pad(truncate(cells[column.key], widths[column.key]), widths[column.key]))
        .join(' '.repeat(GAP))
        .trimEnd();
}

/**
 * Which slice of the rows to show, given how many lines are left for them.
 * The window follows the cursor and otherwise stays where it was, so a repo
 * changing three rows down does not scroll the table out from under anyone.
 */
function viewport(count, cursor, scroll, budget) {
    if (count <= budget) return { start: 0, end: count };

    let start = scroll;
    if (cursor >= 0) {
        if (cursor < start) start = cursor;
        if (cursor >= start + budget) start = cursor - budget + 1;
    }
    start = Math.max(0, Math.min(start, count - budget));
    return { start, end: start + budget };
}

/**
 * Build the whole screen as an array of lines.
 *
 * @param {object} state Everything the table draws: the rows, the cursor, the
 *   selection, the menu, the preview and the last message. `state.scroll` is
 *   written back, because only the renderer knows how many rows fit.
 * @param {object} palette From createPalette().
 * @param {{columns: number, rows: number}} size
 */
function frame(state, palette, size) {
    const now = Date.now();
    const available = Math.max(40, size.columns);

    // Whatever the table is in the middle of is a box over the finished frame,
    // whichever frame that is: the menu, a message being typed, a preview, a
    // report. The table is drawn first either way, and keeps refreshing behind.
    const done = (lines) => {
        const panel = panelFor(state);
        return panel ? overlay(lines, panel, palette, size) : lines;
    };

    // A search does not throw rows away — they are still watched, still counted
    // in the header — it only decides which of them this frame is of. The cursor
    // and the window count these, and so does everything the keys act on.
    const rows = reposLib.filter(state.rows, state.filter);

    // Only the renderer finds out that the list is shorter than the cursor
    // thought: a row whose branch changed may have walked out of the search
    // between one key and the next. `scroll` is written back for the same
    // reason, a few lines further down.
    if (state.cursor >= rows.length) state.cursor = rows.length - 1;

    const rowCells = rows.map((repo) => ({
        repo: `${treePrefix(repo.depth)}${repo.name}`,
        path: repo.relPath,
        branch: repo.branch || '…',
        status: statusCell(repo),
        updated: repo.hasChanges ? formatRelative(repo.lastChange, now) : '-',
        diff: diffCells(repo).short,
    }));

    const widths = layout(available);

    const header = Object.fromEntries(COLUMNS.map((column) => [column.key, column.title]));

    // The table is as wide as the window, however little the columns need of
    // it: the rules and the highlighted rows reach the right-hand edge. The
    // columns are laid out against `available` instead, which stops shrinking
    // at a floor, so a very narrow window cuts the table off rather than
    // squeezing it into nothing.
    const tableWidth = Math.max(1, size.columns);
    const rule = '-'.repeat(tableWidth);

    // Every line is cut to the window as well, and cut before it is coloured:
    // a line wrapping onto the next one would push the whole frame down, and
    // an escape sequence counted as width, or cut in half, is worse still.
    const fit = (text) => truncate(text, tableWidth);

    const changed = state.rows.filter((repo) => repo.hasChanges).length;
    // Only when there are any: a folder where everything has been pushed has
    // nothing to say about pushing, and the line is short enough to read as it is.
    const unpushed = state.rows.filter((repo) => repo.unpushed).length;

    const summary = [
        `watching ${shortenHome(state.root)}`,
        `${state.rows.length} ${state.rows.length === 1 ? 'repo' : 'repos'}`,
        `${changed} changed`,
    ];
    if (unpushed > 0) summary.push(`${unpushed} unpushed`);
    // The header counts every repository whatever is showing, and then says how
    // much of that this is: a filtered table that only counted itself would let
    // somebody read "2 repos · 0 changed" off a folder of thirty.
    if (state.filter) summary.push(`“${state.filter}” · ${rows.length} showing`);
    summary.push(...Object.values(state.notes).filter(Boolean));

    const head = [
        palette.bold(fit(`repo master v${state.version}`)),
        palette.dim(fit(summary.join(' · '))),
        palette.dim(rule),
        palette.dim(fit(`${' '.repeat(GUTTER)}${joinRow(header, widths)}`)),
    ];

    const tail = [palette.dim(rule)];

    // The search is typed on the line the keys are usually written on. It is not
    // a box, because the list narrowing under it is the whole point of typing,
    // and a box in the middle of the screen would cover the rows being looked
    // for. What is left of the keys goes after it.
    if (state.mode === 'search' && state.search) {
        const field = state.search;
        const before = `/${field.value.slice(0, field.column)}`;
        const rest = field.value.slice(field.column);
        // The terminal's own cursor is hidden while the table is up, so the
        // character the caret stands on wears reversed video, as it does in a box.
        const caret = palette.enabled ? palette.caret(rest[0] || ' ') : rest[0] || '_';
        tail.push(fit(`${before}${caret}${rest.slice(1)}${palette.dim('   enter keep · esc clear')}`));
    } else if (state.interactive) {
        tail.push(
            palette.dim(
                keyLine(
                    [
                        'up/down move',
                        'space select',
                        'enter menu',
                        '/ search',
                        state.filter ? 'esc clear search' : 'esc clear',
                        'R refresh',
                        'q quit',
                    ],
                    tableWidth,
                ),
            ),
        );
    }

    // A row that says "error" owes an explanation; the cursor asks for it.
    const under = rows[state.cursor];
    const message = state.message || (under && under.error ? `${under.name}: ${under.error}` : '');
    if (message) tail.push(palette.orange(fit(message)));

    /**
     * The finished frame, with the closing rule and the keys pushed down to the
     * foot of the window.
     *
     * They belong to the window rather than to the table: a folder of three
     * repositories would otherwise leave them a third of the way down the
     * screen with nothing underneath, and they would jump about as repositories
     * came and went or a search narrowed the list. Blank rows make up the
     * difference, so the one place to look for them is the bottom.
     *
     * On paper there is no window to reach the foot of, and trailing blank lines
     * down a pipe are somebody else's problem — so this is only done for a
     * terminal.
     */
    const settle = (body) => {
        const lines = [...head, ...body, ...tail];
        if (!state.interactive) return done(lines);

        // The height screen.draw() paints into: one line short of the window,
        // which is the line it keeps free.
        const height = Math.max(1, size.rows - 1);
        const gap = Math.max(0, height - lines.length);
        return done([...head, ...body, ...Array(gap).fill(''), ...tail]);
    };

    if (rows.length === 0) {
        const empty = state.filter
            ? `  nothing matching “${state.filter}” — esc clears it`
            : `  no git repositories under ${shortenHome(state.root)}`;
        return settle([palette.dim(fit(empty))]);
    }

    // Whatever is left over after the fixed parts belongs to the rows, minus a
    // line for the "there is more" note when they do not all fit.
    const spare = Math.max(1, size.rows - 1 - head.length - tail.length);
    const budget = rows.length > spare ? Math.max(1, spare - 1) : spare;

    // Every box names the repositories it is about, and none of them takes the
    // cursor bar with it: the table behind goes on saying where you were.
    const view = viewport(rows.length, state.cursor, state.scroll || 0, budget);
    state.scroll = view.start;

    // The repository picked first is the main project and wears no mark; the ones
    // picked after it are marked `+`, because that is what they are to it.
    const [mainDir] = state.selected;

    const body = [];
    for (let index = view.start; index < view.end; index++) {
        const repo = rows[index];
        const cursor = index === state.cursor;
        const selected = state.selected.has(repo.dir);
        const gutter = `${cursor ? '>' : ' '}${selected && repo.dir !== mainDir ? '+' : ' '}`;
        const text = fit(`${gutter}${joinRow(rowCells[index], widths)}`);

        // A background only reaches as far as the text does, so a highlighted
        // row is padded out to the width of the table to draw as a full bar.
        // Without colour there is no bar to fill, and no reason to trail spaces.
        const bar = palette.enabled ? pad(text, tableWidth) : text;
        // A table nobody has touched for a minute is being read rather than
        // used, and the cursor bar is then the one thing on it that is not
        // about a repository: it covers whatever colour the row would be
        // wearing to say what is in it. So it comes off until somebody is back,
        // and the row underneath says its own piece. The `>` in the gutter is
        // still there — the cursor has not moved, only stopped being drawn over
        // the row it is on.
        if (cursor && !state.idle) body.push(palette.cursorBar(bar));
        else if (selected) body.push(palette.selectedBar(bar));
        else if (needsAttention(repo)) body.push(palette.attentionBar(bar));
        else if (repo.unpushed) body.push(palette.unpushedBar(bar));
        else body.push(text);
    }

    const above = view.start;
    const below = rows.length - view.end;
    if (above > 0 || below > 0) {
        const more = [];
        if (above > 0) more.push(`${above} above`);
        if (below > 0) more.push(`${below} below`);
        body.push(palette.dim(fit(`  … ${more.join(' · ')}`)));
    }

    return settle(body);
}

module.exports = { createPalette, frame, needsAttention };
