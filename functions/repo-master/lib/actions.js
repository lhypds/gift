// What pressing enter does: open the chosen repositories in an editor or an
// agent.
//
// VS Code is a windowed program and simply gets launched. `claude` and `codex`
// are terminals themselves, so one repository borrows this terminal — the table
// steps aside and comes back when the tool exits — and several repositories get
// a window each.
'use strict';

const { spawn, execFile } = require('node:child_process');

const { shellQuote } = require('./util.js');

/** The three commands, and how each one wants to be started. */
function actions(env) {
    return [
        {
            id: 'vscode',
            label: 'open with vscode',
            command: env.GIFT_REPO_MASTER_VSCODE || 'code',
            kind: 'windowed',
        },
        {
            id: 'claude',
            label: 'open with claude code',
            command: env.GIFT_REPO_MASTER_CLAUDE || 'claude',
            kind: 'terminal',
        },
        {
            id: 'codex',
            label: 'open with codex',
            command: env.GIFT_REPO_MASTER_CODEX || 'codex',
            kind: 'terminal',
        },
    ];
}

/** Launch and forget: the program opens its own window. */
function launch(command, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
        child.on('error', (error) => {
            resolve(error.code === 'ENOENT' ? `${command}: not found in PATH` : `${command}: ${error.message}`);
        });
        child.on('spawn', () => {
            child.unref();
            resolve(null);
        });
    });
}

/** Run in this terminal and wait for it to finish. The caller hides the table first. */
function runHere(command, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, [], { cwd, stdio: 'inherit' });
        child.on('error', (error) => {
            resolve(error.code === 'ENOENT' ? `${command}: not found in PATH` : `${command}: ${error.message}`);
        });
        child.on('close', () => resolve(null));
    });
}

function osascript(script) {
    return new Promise((resolve) => {
        execFile('osascript', ['-e', script], { timeout: 20000 }, (error, _stdout, stderr) => {
            if (error) resolve((stderr || error.message).trim().split('\n')[0]);
            else resolve(null);
        });
    });
}

function appleQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Terminals that can be told to run a command in a new window, in order of preference. */
const LINUX_TERMINALS = [
    (line) => ['x-terminal-emulator', ['-e', 'sh', '-c', line]],
    (line) => ['gnome-terminal', ['--', 'sh', '-c', line]],
    (line) => ['konsole', ['-e', 'sh', '-c', line]],
    (line) => ['xfce4-terminal', ['-e', `sh -c ${shellQuote(line)}`]],
    (line) => ['alacritty', ['-e', 'sh', '-c', line]],
    (line) => ['xterm', ['-e', 'sh', '-c', line]],
];

/**
 * Open a new terminal window sitting in `cwd` and running `command`.
 * Returns null on success, or a sentence saying why not.
 */
async function openInNewTerminal(command, cwd, env) {
    const line = `cd ${shellQuote(cwd)} && exec ${command}`;

    // An explicit template wins, for terminals nobody here has heard of.
    const template = env.GIFT_REPO_MASTER_TERMINAL;
    if (template) {
        const filled = template.includes('{cmd}')
            ? template.replace(/\{cmd\}/g, line).replace(/\{dir\}/g, cwd)
            : `${template} ${shellQuote(line)}`;
        return launch('sh', ['-c', filled], cwd);
    }

    if (process.platform === 'darwin') {
        if (process.env.TERM_PROGRAM === 'iTerm.app') {
            return osascript(
                `tell application "iTerm"
                    set newWindow to (create window with default profile)
                    tell current session of newWindow to write text ${appleQuote(line)}
                end tell`,
            );
        }
        return osascript(
            `tell application "Terminal"
                activate
                do script ${appleQuote(line)}
            end tell`,
        );
    }

    for (const build of LINUX_TERMINALS) {
        const [command_, args] = build(line);
        const error = await launch(command_, args, cwd);
        if (!error) return null;
    }
    return 'no terminal emulator found — set GIFT_REPO_MASTER_TERMINAL';
}

/**
 * Run one action against the chosen repositories.
 *
 * @param {object} action One of actions().
 * @param {object[]} repos Rows to act on.
 * @param {object} hooks
 * @param {() => void} hooks.suspend Hide the table; the terminal is about to be borrowed.
 * @param {() => void} hooks.resume Bring it back.
 * @param {object} env
 * @returns {Promise<string|null>} A message to show, or null when all went well.
 */
async function run(action, repos, { suspend, resume }, env = process.env) {
    const problems = [];

    if (action.kind === 'windowed') {
        for (const repo of repos) {
            const error = await launch(action.command, [repo.dir], repo.dir);
            if (error) problems.push(error);
        }
    } else if (repos.length === 1) {
        suspend();
        try {
            const error = await runHere(action.command, repos[0].dir);
            if (error) problems.push(error);
        } finally {
            resume();
        }
    } else {
        for (const repo of repos) {
            const error = await openInNewTerminal(action.command, repo.dir, env);
            if (error) problems.push(error);
        }
    }

    if (problems.length === 0) {
        const what = repos.length === 1 ? repos[0].name : `${repos.length} repos`;
        return action.kind === 'windowed' || repos.length > 1 ? `${action.label}: ${what}` : null;
    }
    return [...new Set(problems)].join(' · ');
}

module.exports = { actions, run, openInNewTerminal };
