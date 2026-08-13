// The menu behind `gift run`: show the function list and take a choice.
//
// With a terminal at both ends the list is live — `>` marks the row the keys are
// pointing at, up/down or j/k move it, enter runs it, and a number key runs its
// row straight away for anyone whose fingers already know the list. Everywhere
// else, down a pipe or on a terminal too short to hold the list, there is no
// cursor to move and the same question is asked in words instead.
'use strict';

const readline = require('node:readline');

const functions = require('../functions.js');

/** How wide the menu is allowed to get, whatever the terminal reports. */
function menuWidth() {
    return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}

function pad(text, width) {
    return text + ' '.repeat(Math.max(0, width - text.length));
}

/**
 * One line per function: the cursor, a number, the name, and as much description
 * as fits. `cursor` is the row the keys are on, or -1 when nothing is pointing
 * at anything — the list is then printed as it always was.
 */
function menuLines(available, cursor = -1) {
    const numberWidth = String(available.length).length;
    const nameWidth = Math.max(...available.map((f) => f.name.length));
    // What is left for the description after '> 1  name  ', one column short of
    // the full width so no line ends exactly at the edge and wraps.
    const room = menuWidth() - numberWidth - nameWidth - 7;

    return available.map((fn, index) => {
        const mark = index === cursor ? '>' : ' ';
        let line = `${mark} ${pad(String(index + 1), numberWidth)}  ${pad(fn.name, nameWidth)}`;
        if (fn.description) {
            const description =
                room > 12 && fn.description.length > room
                    ? `${fn.description.slice(0, room - 1)}…`
                    : fn.description;
            line += `  ${description}`;
        }
        return line.trimEnd();
    });
}

/**
 * Turn what the user typed into a choice. A number picks by position; anything
 * else is a name, or enough of one — the same rule as `gift <function>`. An
 * empty answer, `q` or `quit` backs out.
 *
 * @returns {{status: 'ok', fn: object} | {status: 'cancelled'}
 *          | {status: 'invalid', message: string}}
 */
function choose(answer, available) {
    const token = String(answer).trim();
    if (token === '' || token === 'q' || token === 'quit') return { status: 'cancelled' };

    if (/^\d+$/.test(token)) {
        const index = Number(token) - 1;
        if (index >= 0 && index < available.length) {
            return { status: 'ok', fn: available[index] };
        }
        return {
            status: 'invalid',
            message: `There is no ${token} in the list — pick 1 to ${available.length}.`,
        };
    }

    const byName = available.find((f) => f.name === token);
    if (byName) return { status: 'ok', fn: byName };

    const matches = available.filter((f) => f.name.startsWith(token));
    if (matches.length === 1) return { status: 'ok', fn: matches[0] };
    if (matches.length > 1) {
        const names = matches.map((m) => m.name).join(', ');
        return { status: 'invalid', message: `'${token}' matches ${names} — type more of the name.` };
    }
    return { status: 'invalid', message: `No function called '${token}'.` };
}

/**
 * Ask one question. Resolves with the answer, or null if the user gave up with
 * Ctrl-C or Ctrl-D instead of answering.
 */
function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        let done = false;
        const finish = (answer) => {
            if (done) return;
            done = true;
            rl.close();
            resolve(answer);
        };
        const giveUp = () => {
            // Answering closes the interface too, and that close is not a giving
            // up: readline has already ended the prompt line, so a newline here
            // would leave a blank one behind.
            if (done) return;
            process.stdout.write('\n'); // the prompt line has no newline yet
            finish(null);
        };

        rl.on('SIGINT', giveUp); // Ctrl-C
        rl.on('close', giveUp); // Ctrl-D — a no-op once an answer came in
        rl.question(question, finish);
    });
}

/** Turn a chunk of stdin into key names, ignoring escape sequences we have no use for. */
function decode(chunk) {
    const keys = [];
    let index = 0;

    while (index < chunk.length) {
        const rest = chunk.slice(index);

        // Arrow keys, in both the normal and the application cursor forms.
        const arrow = rest.match(/^\x1b(?:\[|O)([ABCD])/);
        if (arrow) {
            keys.push({ A: 'up', B: 'down', C: 'right', D: 'left' }[arrow[1]]);
            index += arrow[0].length;
            continue;
        }
        if (rest.startsWith('\x1b[')) {
            // Some other sequence — a page key, a mouse report. Skip to its
            // final byte rather than reading it as a run of letters.
            const end = rest.slice(2).search(/[\x40-\x7e]/);
            index += end === -1 ? rest.length : end + 3;
            continue;
        }

        const character = chunk[index];
        index++;
        if (character === '\r' || character === '\n') keys.push('enter');
        else if (character === '\x1b') keys.push('escape');
        else if (character === '\x03') keys.push('ctrl-c');
        else if (character === '\x04') keys.push('ctrl-d');
        else keys.push(character);
    }
    return keys;
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[K';
const CLEAR_BELOW = '\x1b[0J';

/**
 * The live list. Paints the rows and repaints them in place as the keys move the
 * cursor, and leaves the chosen row on screen as a record of what was picked.
 *
 * @returns {Promise<{status: 'ok', fn: object} | {status: 'cancelled'}>}
 */
function select(available) {
    return new Promise((resolve) => {
        const input = process.stdin;
        const output = process.stdout;

        const digits = Math.min(available.length, 9);
        const hint = ['up/down or j/k move', digits > 1 ? `1-${digits} pick` : null, 'enter run', 'q quit']
            .filter(Boolean)
            .join(' · ');

        let cursor = 0;
        let painted = 0;

        // Whatever the menu would like to be, a line wider than the terminal
        // wraps, and a wrapped line puts the repaint one row out for good.
        const clip = (line) => {
            const room = Math.max(1, (output.columns || 80) - 1);
            return line.length > room ? `${line.slice(0, room - 1)}…` : line;
        };

        const draw = (withHint = true) => {
            const lines = menuLines(available, cursor);
            if (withHint) lines.push('', hint);

            // Back up over the last paint and write the block again. Each line
            // clears what was longer before it; CLEAR_BELOW takes the hint away
            // on the last paint, when the block has grown shorter.
            const body = lines.map((line) => `${clip(line)}${CLEAR_LINE}`).join('\n');
            output.write(`${painted > 0 ? `\x1b[${painted}A` : ''}${body}\n${CLEAR_BELOW}`);
            painted = lines.length;
        };

        let done = false;
        const finish = (choice) => {
            if (done) return;
            done = true;
            draw(false); // the hint has had its say; the chosen row stays
            input.off('data', onData);
            if (input.isTTY) input.setRawMode(false);
            input.pause();
            output.write(SHOW_CURSOR);
            resolve(choice);
        };

        function onData(chunk) {
            for (const key of decode(chunk)) {
                if (done) return;
                switch (key) {
                    case 'up':
                    case 'k':
                        cursor = (cursor - 1 + available.length) % available.length;
                        draw();
                        break;
                    case 'down':
                    case 'j':
                        cursor = (cursor + 1) % available.length;
                        draw();
                        break;
                    case 'enter':
                        finish({ status: 'ok', fn: available[cursor] });
                        break;
                    case 'q':
                    case 'escape':
                    case 'ctrl-c':
                    case 'ctrl-d':
                        finish({ status: 'cancelled' });
                        break;
                    default:
                        if (/^[1-9]$/.test(key) && Number(key) <= available.length) {
                            cursor = Number(key) - 1;
                            finish({ status: 'ok', fn: available[cursor] });
                        }
                }
            }
        }

        output.write(HIDE_CURSOR);
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        input.on('data', onData);
        draw();
    });
}

/** Ask in words: the list, then a question, until an answer names a function. */
async function prompt(available) {
    console.log('functions:');
    for (const line of menuLines(available)) console.log(line);
    console.log('');

    for (;;) {
        const answer = await ask(`Choose a function [1-${available.length}], or q to quit: `);
        if (answer === null) return { status: 'cancelled' };

        const choice = choose(answer, available);
        if (choice.status === 'invalid') {
            console.log(choice.message);
            continue;
        }
        return choice;
    }
}

/**
 * Show the function list and let the user pick one.
 *
 * @returns {Promise<{status: 'ok', fn: object} | {status: 'cancelled'}
 *          | {status: 'empty'} | {status: 'no-tty'}>}
 */
async function pick() {
    // Without a terminal there is nobody to ask; the caller says so and exits.
    if (!process.stdin.isTTY) return { status: 'no-tty' };

    const available = functions.list();
    if (available.length === 0) return { status: 'empty' };

    // The live list repaints itself by moving the cursor back up over its own
    // rows, which only lands where it was aimed while every row is still on
    // screen. Too many functions for the window, or a stdout that is not a
    // terminal at all, and the question gets asked in words.
    const tall = available.length + 3 > (process.stdout.rows || 24) - 1;
    if (!process.stdout.isTTY || tall) return prompt(available);

    console.log('functions:');
    return select(available);
}

// `ask` is shared with `gift create`, which asks for a hook's fields one at a time.
module.exports = { pick, ask, choose, menuLines, decode };
