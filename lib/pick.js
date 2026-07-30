// The menu behind `gift run`: print the function list and read a choice.
'use strict';

const readline = require('node:readline');

const functions = require('./functions.js');

/** How wide the menu is allowed to get, whatever the terminal reports. */
function menuWidth() {
    return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}

function pad(text, width) {
    return text + ' '.repeat(Math.max(0, width - text.length));
}

/** One line per function: number, name, and as much description as fits. */
function menuLines(available) {
    const numberWidth = String(available.length).length;
    const nameWidth = Math.max(...available.map((f) => f.name.length));
    // What is left for the description after '  1  name  ', one column short of
    // the full width so no line ends exactly at the edge and wraps.
    const room = menuWidth() - numberWidth - nameWidth - 7;

    return available.map((fn, index) => {
        let line = `  ${pad(String(index + 1), numberWidth)}  ${pad(fn.name, nameWidth)}`;
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
            process.stdout.write('\n'); // the prompt line has no newline yet
            finish(null);
        };

        rl.on('SIGINT', giveUp); // Ctrl-C
        rl.on('close', giveUp); // Ctrl-D — a no-op once an answer came in
        rl.question(question, finish);
    });
}

/**
 * Show the function list and let the user pick one. Keeps asking until the
 * answer names a function or backs out.
 *
 * @returns {Promise<{status: 'ok', fn: object} | {status: 'cancelled'}
 *          | {status: 'empty'} | {status: 'no-tty'}>}
 */
async function pick() {
    // Without a terminal there is nobody to ask; the caller says so and exits.
    if (!process.stdin.isTTY) return { status: 'no-tty' };

    const available = functions.list();
    if (available.length === 0) return { status: 'empty' };

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

// `ask` is shared with `gift hook`, which asks for a hook's fields one at a time.
module.exports = { pick, choose, menuLines, ask };
