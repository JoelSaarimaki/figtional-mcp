#!/usr/bin/env node
/**
 * Builds the download packages for a release (see CONTRIBUTING.md "Versions and releases"):
 *
 *   release/figtional-<version>.zip    Figtional for Windows, macOS and Linux in one folder
 *   release/figtional-<version>.mcpb   Claude Desktop extension (double-click to install)
 *
 *   npm run package
 *
 * Our code and its pure-JS dependencies are bundled into one file (lib/figtional.mjs). The only
 * native dependency, @resvg/resvg-js (PNG rendering), is shipped with the prebuilt binaries of
 * every supported platform, downloaded from the npm registry and checked against the integrity
 * hashes in package-lock.json. So one machine (any OS) builds packages that run everywhere; the
 * user only needs Node.js 22.15 or newer.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pkg = readJson(join(root, 'package.json'));
const version = pkg.version;
const outDir = join(root, 'release');
const work = join(outDir, 'work');
const stage = join(work, `figtional-${version}`);
const cacheDir = join(root, 'node_modules', '.cache', 'figtional-release');

/** Platforms Figtional is packaged for (resvg binary package suffixes). */
const RESVG_PLATFORMS = [
  'win32-x64-msvc',
  'win32-arm64-msvc',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
];

const log = (s) => process.stdout.write(s + '\n');

// Launchers and instructions that go into the zip.
function cmd(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

const nodeMissing =
  'Figtional needs Node.js 22.15 or newer. Install the LTS version from https://nodejs.org and try again.';

const launcherCmd = `@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo ${nodeMissing}
  exit /b 1
)
node "%~dp0lib\\figtional.mjs" %*
`;

const setupCmd = `@echo off
title Figtional setup
where node >nul 2>nul
if errorlevel 1 (
  echo ${nodeMissing}
  echo.
  pause
  exit /b 1
)
cd /d "%USERPROFILE%"
node "%~dp0lib\\figtional.mjs" setup
echo.
pause
`;

const launcherSh = `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "${nodeMissing}" >&2
  exit 1
fi
exec node "$DIR/lib/figtional.mjs" "$@"
`;

const setupCommand = `#!/bin/sh
# Double-click in Finder to connect Figtional to your AI apps.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Finder doesn't load your shell profile: look where Node.js installers put it.
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
cd "$HOME"
if ! command -v node >/dev/null 2>&1; then
  echo "${nodeMissing}"
else
  node "$DIR/lib/figtional.mjs" setup
fi
echo
echo "Press Enter to close this window."
read -r _
`;

const readmeTxt = `Figtional ${version}
${'='.repeat(10 + version.length)}

A local stand-in for the Figma MCP server, backed by .fig files on your computer.
Docs: https://github.com/JoelSaarimaki/figtional-mcp

1. Install Node.js 22.15 or newer (the LTS version): https://nodejs.org
2. Keep this folder somewhere permanent (for example in your Documents folder).
   Your AI apps run Figtional from here, so if you move it, run the setup again.
3. Run the setup and answer its questions:
     Windows:  double-click "Set up Figtional.cmd"
     macOS:    double-click "Set up Figtional.command"
               (if macOS refuses to open it: right-click it, choose Open, then Open)
     Linux:    ./figtional setup
   It asks which folder holds your .fig files (the AI can open nothing else), whether the AI
   may edit them, and which apps to connect: Claude Code, Claude Desktop, Cursor, VS Code.
4. Restart the app (or start a new Claude Code session) and ask it about your designs.

To look at the files yourself, in a terminal in this folder:
     Windows:  figtional.cmd serve --open "C:\\path\\to\\designs"
     macOS / Linux:  ./figtional serve --open ~/path/to/designs

Get .fig files from Figma with File > Save local copy.
Claude Desktop users can install figtional-${version}.mcpb instead of this folder.
`;

// 1. Compile.
log('Compiling…');
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
  cwd: root,
  stdio: 'inherit',
});

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(stage, 'lib'), { recursive: true });

// 2. Bundle. kiwi.js and fonts.js load CommonJS/lazy modules through createRequire(); turning
//    that into a plain require() lets esbuild bundle them. The banner gives the bundled CommonJS
//    code a real require() for Node's built-in modules.
log('Bundling…');
const stripCreateRequire = {
  name: 'strip-create-require',
  setup(b) {
    b.onLoad({ filter: /[\\/]packages[\\/][^\\/]+[\\/]dist[\\/].*\.js$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      return {
        contents: src.replace(/^const require = createRequire\(import\.meta\.url\);$/m, ''),
        loader: 'js',
      };
    });
  },
};
// unicode-properties (used by fontkit) reads data.trie next to its module on Node; its browser
// variant has the same data inlined, which works from a bundle.
const inlineUnicodeData = {
  name: 'inline-unicode-data',
  setup(b) {
    b.onResolve({ filter: /^#binary-trie$/ }, (args) => ({
      path: join(dirname(args.importer), 'binaryTrie.browser.js'),
    }));
  },
};
const result = await build({
  entryPoints: [join(root, 'packages', 'cli', 'dist', 'bin.js')],
  outfile: join(stage, 'lib', 'figtional.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@resvg/resvg-js'],
  plugins: [stripCreateRequire, inlineUnicodeData],
  banner: {
    js: "import { createRequire as __figtionalCreateRequire } from 'node:module';\nconst require = __figtionalCreateRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// 3. Files next to the bundle. lib/../package.json gives the version; lib/../static the viewer.
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'figtional',
      version,
      description: pkg.description,
      license: pkg.license,
      private: true,
      type: 'module',
      engines: pkg.engines,
    },
    null,
    2,
  ) + '\n',
);
cpSync(join(root, 'packages', 'viewer', 'static'), join(stage, 'static'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

// 4. resvg with every platform's binary.
log('Collecting PNG renderer binaries…');
const lock = readJson(join(root, 'package-lock.json'));
const resvgDir = join(stage, 'node_modules', '@resvg');
for (const f of ['index.js', 'js-binding.js', 'package.json', 'LICENSE']) {
  const src = join(root, 'node_modules', '@resvg', 'resvg-js', f);
  if (existsSync(src)) cpSync(src, join(resvgDir, 'resvg-js', f));
}
mkdirSync(cacheDir, { recursive: true });
for (const platform of RESVG_PLATFORMS) {
  const name = `@resvg/resvg-js-${platform}`;
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.resolved || !entry.integrity) throw new Error(`${name} is missing from package-lock.json`);
  const tgz = await download(entry.resolved, entry.integrity);
  extractPackage(tgz, join(resvgDir, `resvg-js-${platform}`));
}

// 5. Licences of everything inside the bundle.
writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'), thirdPartyLicenses(result.metafile));

// 6. Launchers and instructions for the zip.
const zipOnly = new Map([
  ['figtional.cmd', { text: cmd(launcherCmd), mode: 0o644 }],
  ['Set up Figtional.cmd', { text: cmd(setupCmd), mode: 0o644 }],
  ['figtional', { text: launcherSh, mode: 0o755 }],
  ['Set up Figtional.command', { text: setupCommand, mode: 0o755 }],
  ['README.txt', { text: readmeTxt.replace(/\n/g, '\r\n'), mode: 0o644 }],
]);

// 7. Archives.
const { writeZip } = await import(new URL('../packages/fig-format/dist/zip.js', import.meta.url).href);
const files = listFiles(stage);

const zipPath = join(outDir, `figtional-${version}.zip`);
writeArchive(
  zipPath,
  [
    ...files.map((f) => ({
      name: `figtional-${version}/${f}`,
      data: readFileSync(join(stage, f)),
      mode: 0o644,
    })),
    ...[...zipOnly].map(([name, { text, mode }]) => ({
      name: `figtional-${version}/${name}`,
      data: Buffer.from(text),
      mode,
    })),
  ],
  writeZip,
);

const manifest = mcpbManifest();
const mcpbPath = join(outDir, `figtional-${version}.mcpb`);
writeArchive(
  mcpbPath,
  [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 },
    ...files.map((f) => ({ name: f, data: readFileSync(join(stage, f)), mode: 0o644 })),
  ],
  writeZip,
);
// Check the manifest with Anthropic's MCPB tool.
mkdirSync(join(work, 'mcpb'), { recursive: true });
writeFileSync(join(work, 'mcpb', 'manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js'),
    'validate',
    join(work, 'mcpb', 'manifest.json'),
  ],
  { stdio: 'inherit' },
);

rmSync(work, { recursive: true, force: true });
for (const p of [zipPath, mcpbPath]) {
  const size = (statSync(p).size / 1024 / 1024).toFixed(1);
  log(`${relative(root, p)}  ${size} MB  sha256 ${sha256(readFileSync(p))}`);
}

// ---------------------------------------------------------------------------------------------

async function download(url, integrity) {
  const [algo, expected] = integrity.split(/-(.*)/s);
  const cached = join(cacheDir, url.split('/').pop());
  let data = existsSync(cached) ? readFileSync(cached) : undefined;
  const ok = (d) => createHash(algo).update(d).digest('base64') === expected;
  if (!data || !ok(data)) {
    log(`  downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    if (!ok(data)) throw new Error(`${url}: integrity check failed`);
    writeFileSync(cached, data);
  }
  return data;
}

/** Extracts an npm package tarball (its `package/` folder) into `dest`. */
function extractPackage(tgz, dest) {
  const tar = gunzipSync(tgz);
  let off = 0;
  let longName;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = undefined;
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type !== '0' && type !== '\0') continue;
    name = name.replace(/^package\//, '');
    if (!name || name.split('/').includes('..')) throw new Error(`unsafe path in tarball: ${name}`);
    const out = join(dest, ...name.split('/'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

function writeArchive(path, entries, writeZip) {
  const chunks = [];
  writeZip(
    entries.map((e) => ({ name: e.name, data: e.data, method: 8, unixMode: e.mode })),
    { write: (b) => chunks.push(Buffer.from(b)) },
  );
  writeFileSync(path, Buffer.concat(chunks));
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function thirdPartyLicenses(metafile) {
  const pkgs = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
    if (!m) continue;
    const dir = join(root, input.replace(/\\/g, '/').slice(0, m.index + m[0].length));
    if (!pkgs.has(dir)) pkgs.set(dir, m[1]);
  }
  const parts = [
    'Figtional bundles the following open-source packages into lib/figtional.mjs.',
    'node_modules/@resvg contains resvg-js (MPL-2.0), with its own licence file.',
    '',
  ];
  for (const [dir, name] of [...pkgs].sort((a, b) => a[1].localeCompare(b[1]))) {
    let info = {};
    try {
      info = readJson(join(dir, 'package.json'));
    } catch {
      /* ignore */
    }
    const licenseFile = existsSync(dir)
      ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
      : undefined;
    parts.push('='.repeat(78));
    parts.push(`${name} ${info.version ?? ''}  (${info.license ?? 'see package'})`);
    parts.push('='.repeat(78));
    parts.push(licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : '(no licence file)');
    parts.push('');
  }
  return parts.join('\n');
}

function mcpbManifest() {
  return {
    manifest_version: '0.3',
    name: 'figtional',
    display_name: 'Figtional',
    version,
    description:
      "A local stand-in for the Figma MCP server: Figma MCP's tools, backed by .fig files in one folder you choose.",
    long_description:
      "Figtional lets Claude practise with Figma MCP safely. It offers the same tools as Figma's MCP server (get_metadata, get_design_context, get_screenshot, get_variable_defs, use_figma, and more), but reads Figma files you have exported as .fig files instead of your Figma account. Claude can only open the .fig files in the folder you choose, and only edits them if you allow it. Edited files can be imported back into Figma.",
    author: { name: 'Joel Saarimäki', url: 'https://github.com/JoelSaarimaki' },
    repository: { type: 'git', url: 'https://github.com/JoelSaarimaki/figtional-mcp' },
    homepage: 'https://github.com/JoelSaarimaki/figtional-mcp',
    documentation: 'https://github.com/JoelSaarimaki/figtional-mcp#readme',
    support: 'https://github.com/JoelSaarimaki/figtional-mcp/issues',
    license: 'MIT',
    keywords: ['figma', 'fig', 'design', 'mcp', 'local'],
    server: {
      type: 'node',
      entry_point: 'lib/figtional.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/lib/figtional.mjs', 'mcp', '${user_config.designs_folder}'],
        env: {
          FIGTIONAL_RECURSIVE: '${user_config.include_subfolders}',
          FIGTIONAL_WRITABLE: '${user_config.allow_editing}',
        },
      },
    },
    user_config: {
      designs_folder: {
        type: 'directory',
        title: 'Designs folder',
        description: 'Folder with your exported .fig files. Claude can open these files and nothing else.',
        required: true,
      },
      include_subfolders: {
        type: 'boolean',
        title: 'Include subfolders',
        description: "Also give access to .fig files in the folder's subfolders.",
        default: true,
      },
      allow_editing: {
        type: 'boolean',
        title: 'Allow editing',
        description:
          'Let Claude change the files with use_figma (a .bak copy is kept). Off: read-only, the safe choice for practising.',
        default: false,
      },
    },
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: '>=22.15.0' },
    },
  };
}
