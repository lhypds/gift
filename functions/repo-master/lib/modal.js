// The modal: a box drawn over the table.
//
// Everything that interrupts the table is drawn by this one box — the preview of
// a repository's changes, the menu enter opens, the field a commit message is
// typed into, and the report of what came of it. They differ only in what they
// hand over: a title, some lines, a footer, how the lines are coloured, and
// where the caret sits when there is one.
//
// The box is cut into the lines of the frame rather than replacing them, so the
// table goes on showing either side of it — a row is a row, and one behind a box
// has not stopped being there. The lines it cuts into are already coloured, and
// a cut through the middle of an escape sequence would spill that colour across
// the rest of the screen, so the cutting is done by `slice` below, which knows
// where the colours start and picks them up again on the far side.
'use strict';

const { width, charWidth, pad, truncate } = require('./util.js');

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
 *
 * A double-width character with the border falling through it cannot be halved,
 * so the half that would have shown is drawn as a space and the character goes
 * under the box with the rest of its row.
 */
function slice(line, from, to) {
    let column = 0;
    let head = '';
    let tail = '';

    for (const { state, text } of runs(line)) {
        let before = '';
        let after = '';

        for (const character of text) {
            const start = column;
            const end = start + charWidth(character);
            column = end;

            if (end <= from) before += character;
            else if (start >= to) after += character;
            else {
                if (start < from) before += ' '.repeat(from - start);
                if (end > to) after += ' '.repeat(end - to);
            }
        }

        if (before) head += state ? `${state}${before}${RESET}` : before;
        if (after) tail += state ? `${state}${after}${RESET}` : after;
    }

    return { head: head + ' '.repeat(Math.max(0, from - column)), tail };
}

/** The colours a panel may ask a line for, by name. */
function tone(name, palette) {
    switch (name) {
        case 'add':
            return palette.added;
        case 'del':
            return palette.removed;
        case 'dim':
            return palette.dim;
        case 'bold':
            return palette.bold;
        case 'warn':
            return palette.orange;
        default:
            return null;
    }
}

/** A patch in git's own colours: added green, removed red, the rest quiet. */
function patchTone(line) {
    if (line.startsWith('diff --git ')) return 'bold';
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) return 'dim';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return null;
}

/** A border with a label sunk into it: `+- title ---------+`. */
function rule(label, outer, palette, emphasis) {
    const text = label ? ` ${truncate(label, Math.max(1, outer - 6))} ` : '';
    const fill = Math.max(0, outer - 3 - width(text));
    return `${palette.dim('+-')}${emphasis(text)}${palette.dim(`${'-'.repeat(fill)}+`)}`;
}

/** Everything past the first `columns` columns of a line. */
function dropColumns(text, columns) {
    let used = 0;
    let out = '';

    for (const character of text) {
        if (used >= columns) {
            out += character;
            continue;
        }
        used += charWidth(character);
        // A double-width character cut in half leaves the half that survived as
        // a space, so the columns after it still land where they should.
        if (used > columns) out += ' '.repeat(used - columns);
    }
    return out;
}

/** The line with the character standing at `column` drawn as the caret. */
function withCaret(cell, column, palette) {
    let used = 0;
    let out = '';

    for (const character of cell) {
        if (used === column) {
            // The terminal's own cursor is hidden while the table is up, so the
            // character wears reversed video instead. Without colour to reverse,
            // a caret over a space would vanish; an underscore stands in.
            out += palette.enabled ? palette.caret(character) : character === ' ' ? '_' : character;
        } else {
            out += character;
        }
        used += charWidth(character);
    }
    return out;
}

/**
 * One line inside the box.
 *
 * `caret` is the column the cursor stands at, for the line being typed into. The
 * text is slid sideways to keep the caret in view, because a message may be
 * longer than the box is wide.
 */
function row(text, inner, palette, toneName, caret) {
    let body = String(text);
    let column = caret;

    if (column != null) {
        const from = Math.max(0, column - inner + 1);
        body = dropColumns(body, from);
        column -= from;
    }

    const colour = tone(toneName, palette);
    let cell = pad(truncate(body, inner), inner);

    if (column != null) cell = withCaret(cell, column, palette);
    else if (colour) cell = colour(cell);

    const gap = ' '.repeat(PADDING);
    return `${palette.dim('|')}${gap}${cell}${gap}${palette.dim('|')}`;
}

/**
 * What the footer says before the keys: whatever the panel is busy with, and
 * where in the content we are once there is more of it than the box shows.
 * `count` asks for the size of something being read rather than chosen — a patch
 * says how many lines it is, a menu of five commands has no business doing so.
 */
function position(panel, scroll, view, total) {
    const where =
        total > view
            ? `${scroll + 1}-${scroll + view} of ${total}`
            : panel.count
              ? `${total} ${total === 1 ? 'line' : 'lines'}`
              : '';
    return [panel.status, where].filter(Boolean).join(' · ');
}

/**
 * Put the panel over the frame.
 *
 * @param {string[]} base The lines the table drew.
 * @param {object} panel What to draw: `title`, `lines`, `footer`, an optional
 *   `status` and `paint(line, index)` naming a tone, an optional
 *   `caret: {line, column}`, and `width` for how wide the box would like to be.
 *   `scroll` and `view` are written back, because only the renderer knows how
 *   tall the box turned out to be.
 * @param {object} palette From createPalette().
 * @param {{columns: number, rows: number}} size
 */
function overlay(base, panel, palette, size) {
    // One line short of the window, the same line screen.draw() keeps free.
    const height = Math.max(1, size.rows - 1);
    const canvas = base.slice(0, height);
    while (canvas.length < height) canvas.push('');

    // Wide enough to read what is in it, narrow enough to leave the table
    // showing — and never wider than the window, however narrow the window is. A
    // box that overran it would wrap, and a wrapped line pushes the whole frame
    // down.
    const span = Math.max(1, size.columns);
    const want = Math.min(MAX_WIDTH, panel.width || MAX_WIDTH);
    const outer = Math.min(span, Math.max(MIN_WIDTH, Math.min(span - MARGIN * 2, want)));
    const inner = Math.max(1, outer - 2 - PADDING * 2);

    const lines = panel.lines.length > 0 ? panel.lines : [''];
    const room = Math.max(1, height - 4); // a line of table above and below the box
    const view = Math.min(lines.length, room);
    const scroll = Math.max(0, Math.min(panel.scroll || 0, lines.length - view));
    panel.scroll = scroll;
    panel.view = view;

    const box = [rule(panel.title, outer, palette, palette.bold)];
    for (let index = scroll; index < scroll + view; index++) {
        const caret = panel.caret && panel.caret.line === index ? panel.caret.column : null;
        const toneName = panel.paint ? panel.paint(lines[index], index) : null;
        box.push(row(lines[index], inner, palette, toneName, caret));
    }
    const footer = [position(panel, scroll, view, lines.length), panel.footer].filter(Boolean).join(' · ');
    box.push(rule(footer, outer, palette, palette.dim));

    const left = Math.max(0, Math.floor((size.columns - outer) / 2));
    const top = Math.max(0, Math.floor((height - box.length) / 2));
    for (let index = 0; index < box.length && top + index < height; index++) {
        const { head, tail } = slice(canvas[top + index], left, left + outer);
        canvas[top + index] = `${head}${box[index]}${tail}`;
    }
    return canvas;
}

module.exports = { overlay, patchTone };
