#!/usr/bin/env node
import { main } from './main.js';

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`figtional: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
