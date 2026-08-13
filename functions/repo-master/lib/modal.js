// The modal: a box drawn over the table, holding the preview of a repository's
// changes.
//
// The box is cut into the lines of the frame rather than replacing them, so the
// table goes on showing either side of it — a row is a row, and one behind a box
// has not stopped being there. The lines it cuts into are already coloured, and
// a cut through the middle of an escape sequence would spill that colour across
// the rest of the screen, so the cutting is done by `slice` below, which knows
// where the colours start and picks them up again on the far side.
'use strict';

const { width, pad, truncate } = require('./util.js');

const MARGIN = 6; // columns of the table left showing either side of the box
const MAX_WIDTH = 120;
const MIN_WIDTH = 24;
const PADDING = 1; // a space between the border and the text

const RESET = '\x1b[0m';
/** The colour sequences the table draws with, and nothing else. */
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A drawn line as runs of text, each with the colour in force over it. A reset
 * ends every run the table writes, so the state is no more than the codes seen
 * since the last one.
 */
function runs(line) {
    const out = [];
    let state = '';
    let index = 0;

    for (const match of line.matchAll(SGR)) {
        if (match.index > index) out.push({ state, text: line.slice(index, match.index) });
        state = match[0] === RESET ? '' : state + match[0];
        index = match.index + match[0].length;
    }
    if (index < line.length) out.push({ state, text: line.slice(index) });
    return out;
}

/**
 * The two ends of a line the box will stand in the middle of: everything left of
 * column `from`, and everything from column `to` on, each still wearing the
 * colours it had. A line too short to reach the box is padded out to it, so the
 * box starts where it means to.
 */
function slice(line, from, to) {
    let column = 0;
    let head = '';
    let tail = '';

    for (const { state, text } of runs(line)) {
        const characters = [...text];
        const start = column;
        column += characters.length;

        const before = characters.slice(0, Math.max(0, from - start)).join('');
        if (before) head += state ? `${state}${before}${RESET}` : before;

        const after = characters.slice(Math.max(0, to - start)).join('');
        if (after) tail += state ? `${state}${after}${RESET}` : after;
    }

    return { head: head + ' '.repeat(Math.max(0, from - column)), tail };
}

/** A patch in git's own colours: added green, removed red, the rest quiet. */
function paint(line, palette) {
    if (line.startsWith('diff --git ')) return palette.bold;
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) return palette.dim;
    if (line.startsWith('+')) return palette.added;
    if (line.startsWith('-')) return palette.removed;
    return null;
}

/** A border with a label sunk into it: `+- title ---------+`. */
function rule(label, outer, palette, emphasis) {
    const text = label ? ` ${truncate(label, Math.max(1, outer - 6))} ` : '';
    const fill = Math.max(0, outer - 3 - width(text));
    return `${palette.dim('+-')}${emphasis(text)}${palette.dim(`${'-'.repeat(fill)}+`)}`;
}

function row(text, inner, palette) {
    const colour = paint(text, palette);
    const cell = pad(truncate(text, inner), inner);
    const gap = ' '.repeat(PADDING);
    return `${palette.dim('|')}${gap}${colour ? colour(cell) : cell}${gap}${palette.dim('|')}`;
}

/** Where in the patch we are, and how to get elsewhere. */
function footer(panel, scroll, view, total) {
    const where = panel.loading
        ? 'reading…'
        : total <= view
          ? `${total} ${total === 1 ? 'line' : 'lines'}`
          : `${scroll + 1}-${scroll + view} of ${total}`;
    return `${where} · up/down scroll · space page · r reload · esc close`;
}

/**
 * Put the panel over the frame.
 *
 * @param {string[]} base The lines the table drew.
 * @param {object} panel `state.preview`: title, lines, scroll, loading. `scroll`
 *   and `view` are written back, because only the renderer knows how tall the
 *   box turned out to be.
 * @param {object} palette From createPalette().
 * @param {{columns: number, rows: number}} size
 */
function overlay(base, panel, palette, size) {
    // One line short of the window, the same line screen.draw() keeps free.
    const height = Math.max(1, size.rows - 1);
    const canvas = base.slice(0, height);
    while (canvas.length < height) canvas.push('');

    // Wide enough to read a patch in, narrow enough to leave the table showing —
    // and never wider than the window, however narrow the window is. A box that
    // overran it would wrap, and a wrapped line pushes the whole frame down.
    const span = Math.max(1, size.columns);
    const outer = Math.min(span, Math.max(MIN_WIDTH, Math.min(span - MARGIN * 2, MAX_WIDTH)));
    const inner = Math.max(1, outer - 2 - PADDING * 2);

    const lines = panel.lines.length > 0 ? panel.lines : [''];
    const room = Math.max(1, height - 4); // a line of table above and below the box
    const view = Math.min(lines.length, room);
    const scroll = Math.max(0, Math.min(panel.scroll || 0, lines.length - view));
    panel.scroll = scroll;
    panel.view = view;

    const box = [
        rule(panel.title, outer, palette, palette.bold),
        ...lines.slice(scroll, scroll + view).map((line) => row(line, inner, palette)),
        rule(footer(panel, scroll, view, lines.length), outer, palette, palette.dim),
    ];

    const left = Math.max(0, Math.floor((size.columns - outer) / 2));
    const top = Math.max(0, Math.floor((height - box.length) / 2));
    for (let index = 0; index < box.length && top + index < height; index++) {
        const { head, tail } = slice(canvas[top + index], left, left + outer);
        canvas[top + index] = `${head}${box[index]}${tail}`;
    }
    return canvas;
}

module.exports = { overlay };
