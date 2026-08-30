// "Does this text count?" — the question the clipboard, website and file
// triggers all have to answer, asked the same way in all three so that one
// answer learned in `gift create` carries across them.
//
//     "match": "^TODO:",  "matchType": "regex"
//
// Four ways to say it, and none of them is a shell pattern: the text being
// tested came from outside gift, and never reaches a shell.
//
//     any        anything at all — fire on every change (the default)
//     contains   the text appears somewhere, case-insensitively
//     exact      the whole text is this, once trimmed
//     regex      a JavaScript regular expression, with capture groups handed
//                to the script as GIFT_MATCH_1, GIFT_MATCH_2, …
'use strict';

const TYPES = ['any', 'contains', 'exact', 'regex'];

/**
 * Read the two fields as they are written. An empty `match` is `any` however
 * the type is spelled — there is nothing to compare against — so a hook that
 * means "fire on every change" cannot be written as one that never fires.
 *
 * @throws {Error} when the type is not one of the four, or the regex will not
 *         compile — which is worth catching while it can still be retyped,
 *         rather than at the first change that goes missing.
 */
function normalize(spec = {}) {
    const match = spec.match === undefined || spec.match === null ? '' : String(spec.match);
    let matchType = String(spec.matchType || (match ? 'contains' : 'any')).toLowerCase();

    if (!TYPES.includes(matchType)) {
        throw new Error(`has an unknown "matchType" '${spec.matchType}' — try one of: ${TYPES.join(', ')}`);
    }
    if (!match) matchType = 'any';
    if (matchType === 'regex') compile(match); // reject a pattern that will not compile

    return { match, matchType };
}

function compile(pattern) {
    try {
        return new RegExp(pattern);
    } catch (err) {
        throw new Error(`has a "match" that is not a regular expression — ${err.message}`);
    }
}

/**
 * Test one piece of text.
 *
 * @returns {{text: string, groups: string[]} | null} what matched and the
 *          regex capture groups, or null when it did not match at all.
 */
function test(text, spec) {
    const value = String(text ?? '');
    switch (spec.matchType) {
        case 'any':
            return { text: '', groups: [] };
        case 'contains':
            return value.toLowerCase().includes(spec.match.toLowerCase())
                ? { text: spec.match, groups: [] }
                : null;
        case 'exact':
            return value.trim() === spec.match.trim() ? { text: value.trim(), groups: [] } : null;
        case 'regex': {
            const found = compile(spec.match).exec(value);
            if (!found) return null;
            return { text: found[0], groups: found.slice(1).map((g) => (g === undefined ? '' : g)) };
        }
        default:
            return null;
    }
}

/** The environment a match contributes: what matched, and its capture groups. */
function env(result) {
    if (!result) return {};
    const values = { GIFT_MATCH: result.text || '' };
    result.groups.forEach((group, index) => {
        values[`GIFT_MATCH_${index + 1}`] = group;
    });
    return values;
}

/** How the match reads in `gift list` — 'anything' rather than an empty cell. */
function describe(spec) {
    if (spec.matchType === 'any') return 'anything (every change fires)';
    return `${spec.matchType} ${JSON.stringify(spec.match)}`;
}

module.exports = { TYPES, normalize, test, env, describe };
