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

/** Turn a chunk of stdin into key names. */
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
        if (rest.startsWith('\x1b[')) {
            // Some other escape sequence (page up, a mouse report): skip to its
            // final byte rather than reading it as a run of letters.
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
            output.write(ENTER_ALT + HIDE_CURSOR);
            listen();
            output.on('resize', handleResize);
        },

        stop() {
            if (!running) return;
            running = false;
            output.off('resize', handleResize);
            unlisten();
            output.write(SHOW_CURSOR + LEAVE_ALT);
        },

        /** Give the terminal back — another program is about to use it. */
        suspend() {
            if (!running) return;
            running = false;
            unlisten();
            output.write(SHOW_CURSOR + LEAVE_ALT);
        },

        /** Take it back after that program exits. */
        resume() {
            if (running) return;
            running = true;
            output.write(ENTER_ALT + HIDE_CURSOR);
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

module.exports = { createScreen, decode };
