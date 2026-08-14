// The one question repo-master asks before the table goes up: which folder.
//
// A table of every repository under one folder is nothing at all until it knows
// which folder, and that is normally written down once — repo_root under
// functions.repo-master in gift's config.json — and never thought about again.
// Until it is, the old answer was to watch whatever directory the command
// happened to be run in, which is a table of the one repository you were already
// standing in as often as not. So the question is asked instead, in words, on
// the plain terminal before the screen is taken over, and the answer is kept: it
// is a first-run question rather than a prompt, and comes back only if the
// setting is emptied again.
//
// Nobody is asked who cannot answer — a pipe, a cron job, `--once` — and nobody
// is asked who has already said, on the command line or in the configuration.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { expandHome, shortenHome } = require('./util.js');

/** Where the answer is kept: functions.repo-master.repo_root in config.json. */
const FUNCTION = 'repo-master';
const KEY = 'repo_root';

/**
 * Something to ask questions with, for as many as it takes.
 *
 * One readline interface serves the whole conversation rather than one each:
 * closing an interface hands back the input it had already read and nobody is
 * there to catch it, so a second question opened on a fresh one is a question
 * whose answer was thrown away.
 *
 * Lines that arrive between questions are kept rather than dropped. readline
 * hands over a line the moment it has one, and only a question already waiting
 * catches it — so an answer typed while the last one was being looked at, and
 * every line after the first of a piped input, would otherwise be read by nobody
 * and the next question asked of an input with nothing left in it.
 *
 * `ask` resolves with the answer, or null when the user gave up with Ctrl-C or
 * Ctrl-D rather than answering — and with null from then on, so a caller looping
 * on it stops rather than asking an input that has ended.
 */
function createAsker({ input = process.stdin, output = process.stdout } = {}) {
    const rl = readline.createInterface({ input, output });

    const readAhead = [];
    rl.on('line', (line) => readAhead.push(line)); // only fires with no question waiting

    let ended = false;
    const onEnd = () => {
        ended = true;
    };
    rl.on('close', onEnd);

    return {
        ask(question) {
            return new Promise((resolve) => {
                // An answer that came in early is still an answer to this
                // question. A terminal echoed it as it was typed; a pipe echoed
                // nothing, so the line is written out to keep the record of the
                // conversation readable.
                if (readAhead.length) {
                    const early = readAhead.shift();
                    if (!input.isTTY) output.write(`${question}${early}\n`);
                    resolve(early);
                    return;
                }
                if (ended) {
                    resolve(null);
                    return;
                }

                let done = false;
                const finish = (answer) => {
                    if (done) return;
                    done = true;
                    resolve(answer);
                };
                const giveUp = () => {
                    // Ctrl-C closes the interface on its way out, so this is
                    // reached twice for the one giving up. An answer ends the
                    // prompt line itself; a giving up leaves it hanging, and the
                    // newline here is what finishes it — once.
                    if (done) return;
                    output.write('\n');
                    finish(null);
                };

                rl.once('SIGINT', giveUp); // Ctrl-C
                rl.once('close', giveUp); // Ctrl-D, or the input running out
                rl.question(question, (answer) => {
                    rl.off('SIGINT', giveUp);
                    rl.off('close', giveUp);
                    finish(answer);
                });
            });
        },

        /** Give the input back, for the screen that is about to want it. */
        close() {
            rl.off('close', onEnd);
            rl.close();
        },
    };
}

/**
 * What was typed, as a folder to watch. A relative answer is relative to where
 * the question was asked, and a leading `~` is a literal character until it is
 * expanded here.
 *
 * @returns {{root: string} | {error: string}}
 */
function check(answer, cwd) {
    const target = path.resolve(cwd, expandHome(String(answer).trim()));

    let stats;
    try {
        stats = fs.statSync(target);
    } catch {
        return { error: `There is no ${shortenHome(target)}.` };
    }
    if (!stats.isDirectory()) return { error: `${shortenHome(target)} is a file, not a folder.` };
    return { root: target };
}

/**
 * Write the answer down, so it is asked once rather than every run.
 *
 * gift's configuration has one writer — utils/config.js, which knows the file's
 * shape, its permissions and the order values are read in — and this is the only
 * place repo-master reaches outside its own folder for anything. A function
 * folder that has been copied somewhere on its own still runs; it just has
 * nowhere to keep the answer, and says so.
 *
 * @returns {{file: string} | {error: string}}
 */
function remember(root) {
    let config;
    try {
        config = require('../../../utils/config.js');
    } catch {
        return { error: 'gift\'s config.json is not reachable from here' };
    }

    try {
        const result = config.set(FUNCTION, KEY, root);
        return result.ok ? { file: result.file } : { error: result.error };
    } catch (failure) {
        return { error: failure.message || String(failure) };
    }
}

/**
 * Ask for the folder to watch and write it down. Wrong answers are worth another
 * question rather than an exit — a typed path is easy to mistype — and giving up
 * is Ctrl-C, which the caller reports as nothing to watch.
 *
 * @returns {Promise<{status: 'ok', root: string} | {status: 'cancelled'}>}
 */
async function askForRoot({ cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
    const here = path.resolve(cwd);
    const asker = createAsker({ input, output });

    output.write('repo-master watches every git repository under one folder, and does not know\n');
    output.write('which folder yet. Answer once and it is written down — `gift config` changes it\n');
    output.write('later, and a path given to the command wins over it for the one run.\n\n');

    try {
        for (;;) {
            const answer = await asker.ask(`Folder to watch [${shortenHome(here)}]: `);
            if (answer === null) return { status: 'cancelled' };

            // Enter alone takes the directory the command was run in, which is
            // what repo-master watched before there was a question to answer.
            const checked = check(answer.trim() || here, here);
            if (checked.error) {
                output.write(`${checked.error} Type another, or Ctrl-C to give up.\n`);
                continue;
            }

            const written = remember(checked.root);
            output.write(
                written.error
                    ? `Watching ${shortenHome(checked.root)} — it could not be written down (${written.error}), so this run alone.\n`
                    : `Watching ${shortenHome(checked.root)} — written down in ${written.file}.\n`,
            );
            return { status: 'ok', root: checked.root };
        }
    } finally {
        asker.close();
    }
}

module.exports = { askForRoot, createAsker, check, remember };
