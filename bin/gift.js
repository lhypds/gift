#!/usr/bin/env node
// Entry point for the `gift` command. Keep this thin — logic lives in cli.js.
'use strict';

const { main } = require('../cli.js');

main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((err) => {
        console.error(`gift: ${err && err.message ? err.message : err}`);
        process.exitCode = 1;
    });
