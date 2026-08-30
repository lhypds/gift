// Reading the clipboard, on whatever this machine is.
//
// There is no portable way to do it and no dependency worth adding for it, so
// this shells out to the tool the platform already has. The command is chosen
// once at startup rather than per read: which one is there does not change while
// the server runs, and probing four of them every second would be silly.
//
//     macOS    pbpaste
//     Wayland  wl-paste
//     X11      xclip, or xsel
//     Windows  powershell Get-Clipboard
//
// A headless Linux box has none of them, and says so once at startup instead of
// failing quietly every second forever.
'use strict';

const { spawn, spawnSync } = require('node:child_process');

/**
 * The readers worth trying, in the order they are preferred. Wayland first on
 * Linux when the session says so: wl-paste and xclip can both be installed, and
 * under Wayland it is wl-paste that sees the real clipboard.
 */
function candidates() {
    switch (process.platform) {
        case 'darwin':
            return [{ command: 'pbpaste', args: [] }];
        case 'win32':
            return [{
                command: 'powershell',
                args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
            }];
        default: {
            const x11 = [
                { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
                { command: 'xsel', args: ['--clipboard', '--output'] },
            ];
            const wayland = { command: 'wl-paste', args: ['--no-newline'] };
            return process.env.WAYLAND_DISPLAY ? [wayland, ...x11] : [...x11, wayland];
        }
    }
}

function isInstalled(command) {
    const probe = process.platform === 'win32'
        ? spawnSync('where', [command], { stdio: 'ignore' })
        : spawnSync('command', ['-v', command], { stdio: 'ignore', shell: true });
    return !probe.error && probe.status === 0;
}

/**
 * The reader this machine can use.
 *
 * @returns {{command: string, args: string[]} | {error: string}}
 */
function reader() {
    const tried = candidates();
    for (const candidate of tried) {
        if (isInstalled(candidate.command)) return candidate;
    }
    const names = tried.map((c) => c.command).join(', ');
    return { error: `no clipboard tool found — install one of: ${names}` };
}

/**
 * Read the clipboard once.
 *
 * Asynchronously, and never more than one read at a time: the poll is on a
 * timer in the same process that serves the dashboard, and a spawnSync every
 * second would stall it.
 *
 * A non-zero exit is not an error worth reporting — an empty clipboard is how
 * some of these tools spell it — so it reads as empty.
 */
function read({ command, args }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (err) {
            resolve({ error: err.message });
            return;
        }

        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            out += chunk;
        });
        child.on('error', (err) => resolve({ error: err.message }));
        child.on('close', () => resolve({ text: out }));
    });
}

module.exports = { reader, read, candidates };
