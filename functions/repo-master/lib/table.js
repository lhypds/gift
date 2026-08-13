// Drawing the table.
//
// A row is orange when it wants attention — the working tree changed, or a pull
// request appeared that was not there when repo-master started. Everything else
// keeps the terminal's own colour.
'use strict';

const { width, pad, truncate, formatRelative, shortenHome } = require('./util.js');

/** Claude's orange, as a truecolor triple and as its nearest xterm-256 shade. */
const ORANGE_RGB = [217, 119, 87];
const ORANGE_256 = 173;

const RESET = '\x1b[0m';

function createPalette(stream) {
    const enabled =
        Boolean(stream.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
    const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '');
    const orangeCode = truecolor ? `\x1b[38;2;${ORANGE_RGB.join(';')}m` : `\x1b[38;5;${ORANGE_256}m`;

    const wrap = (code) => (text) => (enabled && text ? `${code}${text}${RESET}` : text);
    return {
        enabled,
        orange: wrap(orangeCode),
        dim: wrap('\x1b[2m'),
        bold: wrap('\x1b[1m'),
        boldOrange: wrap(`\x1b[1m${orangeCode}`),
        inverse: wrap('\x1b[7m'),
    };
}

/** `  +- ` in front of a nested repository, one indent per level. */
function treePrefix(depth) {
    return depth === 0 ? '' : `${'  '.repeat(depth)}+- `;
}

function statusCell(repo) {
    if (repo.error) return 'error';
    if (!repo.loaded) return '…';
    return repo.hasChanges ? 'has changes' : 'no changes';
}

function prCell(repo) {
    if (repo.pr.unknown || repo.pr.count === null) return '-';
    return repo.pr.hasNew ? `${repo.pr.count} new` : String(repo.pr.count);
}

/** `+1203 lines -30 lines`, or the same thing without the word when squeezed. */
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

/** Whether a row is one of the ones the user is meant to notice. */
function needsAttention(repo) {
    return Boolean(repo.hasChanges) || Boolean(repo.pr.hasNew);
}

/**
 * `max` is what keeps one outlier from eating the table: a remote whose path is
 * a hundred URL-encoded characters would otherwise set the width of the repo
 * column for everybody. Past the maximum a cell is cut with an ellipsis, however
 * much room the terminal has.
 */
const COLUMNS = [
    { key: 'repo', title: 'repo', min: 12, max: 34 },
    { key: 'path', title: 'path', min: 8, max: 40 },
    { key: 'branch', title: 'branch', min: 6, max: 24 },
    { key: 'pr', title: 'pr', min: 2, fixed: true },
    { key: 'status', title: 'status', min: 6, max: 11 },
    { key: 'updated', title: 'last updated', min: 6, max: 12 },
    { key: 'diff', title: 'diff', min: 4, max: 24 },
];

const GAP = 2;
const GUTTER = 2; // '> ' for the cursor, ' *' for a selected row

/**
 * Work out how wide each column may be. Everything starts at its natural width;
 * if that does not fit the terminal the diff column drops the word "lines"
 * first, and then the widest column gives up a character at a time.
 */
function layout(cells, available) {
    const widths = {};
    for (const column of COLUMNS) {
        const natural = Math.max(width(column.title), ...cells.map((row) => width(row[column.key])));
        widths[column.key] = column.max ? Math.min(natural, column.max) : natural;
    }

    const total = () => GUTTER + COLUMNS.reduce((sum, column) => sum + widths[column.key], 0) + GAP * (COLUMNS.length - 1);

    let shrinkable = COLUMNS.filter((column) => !column.fixed);
    while (total() > available) {
        const widest = shrinkable
            .filter((column) => widths[column.key] > column.min)
            .sort((a, b) => widths[b.key] - widths[a.key])[0];
        if (!widest) break;
        widths[widest.key]--;
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
 *   selection, the menu and the last message. `state.scroll` is written back,
 *   because only the renderer knows how many rows fit.
 * @param {object} palette From createPalette().
 * @param {{columns: number, rows: number}} size
 */
function frame(state, palette, size) {
    const now = Date.now();
    const available = Math.max(40, size.columns);

    const rowCells = state.rows.map((repo) => {
        const diff = diffCells(repo);
        return {
            repo: `${treePrefix(repo.depth)}${repo.name}`,
            path: repo.relPath,
            branch: repo.branch || '…',
            pr: prCell(repo),
            status: statusCell(repo),
            updated: repo.hasChanges ? formatRelative(repo.lastChange, now) : '-',
            diff: diff.long,
            short: diff.short,
        };
    });

    // Try the long diff wording; fall back to the short one if that is what
    // stops the table fitting.
    let widths = layout(rowCells, available);
    const naturalDiff = Math.max(width('diff'), ...rowCells.map((row) => width(row.diff)), 0);
    if (widths.diff < naturalDiff) {
        for (const row of rowCells) row.diff = row.short;
        widths = layout(rowCells, available);
    }

    const header = Object.fromEntries(COLUMNS.map((column) => [column.key, column.title]));
    const tableWidth = Math.min(
        available,
        GUTTER + COLUMNS.reduce((sum, column) => sum + widths[column.key], 0) + GAP * (COLUMNS.length - 1),
    );
    const rule = '-'.repeat(tableWidth);

    const changed = state.rows.filter((repo) => repo.hasChanges).length;
    const openPulls = state.rows.reduce((sum, repo) => sum + (repo.pr.count || 0), 0);

    const summary = [
        `Watching ${shortenHome(state.root)}`,
        `${state.rows.length} ${state.rows.length === 1 ? 'repo' : 'repos'}`,
        `${changed} changed`,
        `${openPulls} open ${openPulls === 1 ? 'PR' : 'PRs'}`,
    ];
    summary.push(...Object.values(state.notes).filter(Boolean));

    const head = [
        palette.bold(`Repo Master v${state.version}`),
        palette.dim(summary.join(' · ')),
        palette.dim(rule),
        palette.dim(`${' '.repeat(GUTTER)}${joinRow(header, widths)}`),
    ];

    const tail = [palette.dim(rule)];

    if (state.mode === 'menu') {
        const count = state.menuTargets.length;
        tail.push(`Run on ${count} ${count === 1 ? 'repo' : 'repos'}:`);
        state.actions.forEach((action, index) => {
            const label = `${index === state.menuIndex ? '>' : ' '} ${index + 1}  ${action.label}`;
            tail.push(index === state.menuIndex ? palette.bold(label) : label);
        });
        tail.push(palette.dim('1-3 or up/down then enter · esc cancel'));
    } else if (state.interactive) {
        tail.push(
            palette.dim(
                ['up/down move', 'space select', 'enter run', 'esc clear', 'r refresh', 'q quit'].join(' · '),
            ),
        );
    }

    // A row that says "error" owes an explanation; the cursor asks for it.
    const under = state.rows[state.cursor];
    const message = state.message || (under && under.error ? `${under.name}: ${under.error}` : '');
    if (message) tail.push(palette.orange(truncate(message, available)));

    if (state.rows.length === 0) {
        return [...head, palette.dim(`  no git repositories under ${shortenHome(state.root)}`), ...tail];
    }

    // Whatever is left over after the fixed parts belongs to the rows, minus a
    // line for the "there is more" note when they do not all fit.
    const spare = Math.max(1, size.rows - 1 - head.length - tail.length);
    const budget = state.rows.length > spare ? Math.max(1, spare - 1) : spare;
    const view = viewport(state.rows.length, state.mode === 'table' ? state.cursor : -1, state.scroll || 0, budget);
    state.scroll = view.start;

    const body = [];
    for (let index = view.start; index < view.end; index++) {
        const repo = state.rows[index];
        const cursor = state.mode === 'table' && index === state.cursor;
        const selected = state.selected.has(repo.dir);
        const gutter = `${cursor ? '>' : ' '}${selected ? '*' : ' '}`;
        const text = truncate(`${gutter}${joinRow(rowCells[index], widths)}`, available);

        const attention = needsAttention(repo);
        if (cursor && attention) body.push(palette.boldOrange(text));
        else if (cursor) body.push(palette.bold(text));
        else if (attention) body.push(palette.orange(text));
        else body.push(text);
    }

    const above = view.start;
    const below = state.rows.length - view.end;
    if (above > 0 || below > 0) {
        const more = [];
        if (above > 0) more.push(`${above} above`);
        if (below > 0) more.push(`${below} below`);
        body.push(palette.dim(`  … ${more.join(' · ')}`));
    }

    return [...head, ...body, ...tail];
}

module.exports = { createPalette, frame, needsAttention };
