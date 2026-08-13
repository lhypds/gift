// The terminal: an alternate screen to draw on, keys read one at a time, and a
// way to hand the whole thing over to another program and take it back again.
'use strict';

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR_LINE = '\x1b[K';
const CLEAR_BELOW = '\x1b[0J';

/**
 * Mouse reporting, asked for so that the wheel can turn the list and a click can
 * answer for the enter key. 1000 sends the buttons, and 1006 sends them in the
 * form that still makes sense past column 223 — which the table has no use for,
 * since it never asks where a click landed, but a report it cannot parse is
 * worse than a wide one. The cost of having the mode on is that selecting text
 * with a drag needs a modifier held down (option in iTerm2, shift most other
 * places), so it goes off again the moment the screen is given up, and any
 * program borrowing the terminal gets it back as it was.
 */
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l';

/** Everything the screen turns on, spelled backwards: the state to leave behind. */
const RESET = DISABLE_MOUSE + SHOW_CURSOR + LEAVE_ALT;

/**
 * The wheel out of a mouse report's button field. Bit 64 marks a wheel rather
 * than a button, and the low two bits say which way it turned; the bits between
 * are the modifier keys, which the table has no use for.
 */
function wheelFrom(button) {
    if (!(button & 64)) return null;
    return { 0: 'wheel-up', 1: 'wheel-down' }[button & 3] || null;
}

/**
 * What a mouse report is worth to the table: a wheel turn, or the left button
 * going down. Where it went down is not asked for — a click is the enter key
 * here, and enter has no coordinates — so the report is read for its button
 * alone. The middle and right buttons, and the release that ends a click, are
 * nothing here and are dropped rather than guessed at.
 */
function report(keys, button) {
    const wheel = wheelFrom(button);
    if (wheel) keys.push(wheel);
    else if (!(button & 64) && (button & 3) === 0) keys.push('click');
}

/** Turn a chunk of stdin into key names, the mouse's among them. */
function decode(chunk) {
    const keys = [];
    let i = 0;

    while (i < chunk.length) {
        const rest = chunk.slice(i);

        if (rest === '\x1b') {
            keys.push('escape');
            break;
        }
        // Arrow keys, in both the normal and the application cursor forms.
        const arrow = rest.match(/^\x1b(?:\[|O)([ABCD])/);
        if (arrow) {
            keys.push({ A: 'up', B: 'down', C: 'right', D: 'left' }[arrow[1]]);
            i += arrow[0].length;
            continue;
        }
        // A mouse report in the form 1006 asks for: ESC [ < button ; x ; y and
        // then M for a press or m for a release. A wheel only ever presses, and
        // taking the release too would turn the list twice for one flick.
        const sgr = rest.match(/^\x1b\[<(\d+);\d+;\d+([Mm])/);
        if (sgr) {
            i += sgr[0].length;
            if (sgr[2] === 'M') report(keys, Number(sgr[1]));
            continue;
        }
        // The older form, from a terminal that would not have 1006: ESC [ M and
        // three bytes, each carried 32 up out of the control range.
        if (rest.startsWith('\x1b[M') && rest.length >= 6) {
            report(keys, rest.charCodeAt(3) - 32);
            i += 6;
            continue;
        }
        if (rest.startsWith('\x1b[')) {
            // Some other escape sequence (page up, a mouse report we have no use
            // for): skip to its final byte rather than reading it as a run of
            // letters.
            const end = rest.slice(2).search(/[\x40-\x7e]/);
            i += end === -1 ? rest.length : end + 3;
            continue;
        }

        const character = chunk[i];
        i++;
        switch (character) {
            case '\r':
            case '\n':
                keys.push('enter');
                break;
            case ' ':
                keys.push('space');
                break;
            case '\x03':
                keys.push('ctrl-c');
                break;
            case '\x04':
                keys.push('ctrl-d');
                break;
            case '\x1b':
                keys.push('escape');
                break;
            default:
                keys.push(character);
        }
    }
    return keys;
}

/**
 * @param {(key: string) => void} onKey
 * @param {() => void} onResize
 */
function createScreen({ onKey, onResize }) {
    const output = process.stdout;
    const input = process.stdin;
    let running = false;

    const handleData = (chunk) => {
        for (const key of decode(chunk)) onKey(key);
    };
    const handleResize = () => onResize();

    const listen = () => {
        if (input.isTTY) input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        input.on('data', handleData);
    };
    const unlisten = () => {
        input.off('data', handleData);
        if (input.isTTY) input.setRawMode(false);
        input.pause();
    };

    return {
        start() {
            if (running) return;
            running = true;
            output.write(ENTER_ALT + HIDE_CURSOR + ENABLE_MOUSE);
            listen();
            output.on('resize', handleResize);
        },

        stop() {
            if (!running) return;
            running = false;
            output.off('resize', handleResize);
            unlisten();
            output.write(RESET);
        },

        /** Give the terminal back — another program is about to use it. */
        suspend() {
            if (!running) return;
            running = false;
            unlisten();
            output.write(RESET);
        },

        /** Take it back after that program exits. */
        resume() {
            if (running) return;
            running = true;
            output.write(ENTER_ALT + HIDE_CURSOR + ENABLE_MOUSE);
            listen();
        },

        get running() {
            return running;
        },

        size() {
            return { columns: output.columns || 100, rows: output.rows || 30 };
        },

        /** Repaint from the top, clearing whatever the last frame left behind. */
        draw(lines) {
            if (!running) return;
            const visible = lines.slice(0, Math.max(1, (output.rows || 30) - 1));
            const body = visible.map((line) => `${line}${CLEAR_LINE}`).join('\n');
            output.write(`${HOME}${body}\n${CLEAR_BELOW}`);
        },
    };
}

module.exports = { createScreen, decode, RESET };
