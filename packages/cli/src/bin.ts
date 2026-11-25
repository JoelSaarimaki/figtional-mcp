#!/usr/bin/env node
import * as zlib from 'node:zlib';

// .fig files are zstd-compressed; node:zlib has zstd from Node.js 22.15. Check before loading the
// rest, so an old Node.js gets a clear message instead of a module-linking error.
if (!('zstdDecompressSync' in zlib)) {
  process.stderr.write(
    `figtional: needs Node.js 22.15 or newer, but this is Node.js ${process.versions.node} (${process.execPath}).\n` +
      'Install the current LTS version from https://nodejs.org and try again.\n',
  );
  process.exit(1);
}

const { main } = await import('./main.js');
main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`figtional: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
