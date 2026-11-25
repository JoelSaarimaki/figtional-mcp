#!/usr/bin/env node
/**
 * Smoke test for an unpacked release folder (made by `npm run package`):
 *
 *   node scripts/smoke-release.mjs <figtional-x.y.z folder> [file.fig]
 *
 * Checks that the launcher and bundle start, that the PNG renderer's native binary loads on this
 * platform, that `setup --print` works, and that the MCP server answers over stdio. With a .fig
 * file it also dumps it and takes a screenshot through the MCP server. Uses only Node.js, so it
 * runs on every CI platform.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const [dirArg, figArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node scripts/smoke-release.mjs <release folder> [file.fig]');
  process.exit(2);
}
const dir = resolve(dirArg);
const bundle = join(dir, 'lib', 'figtional.mjs');
const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
const scratch = mkdtempSync(join(tmpdir(), 'figtional smoke ä-'));
let failures = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`ok    ${name}`),
      (e) => {
        failures++;
        console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
      },
    );
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

await check('bundle prints its version', () => {
  const out = run(process.execPath, [bundle, '--version']).trim();
  if (out !== version) throw new Error(`got "${out}", expected "${version}"`);
});

await check('launcher runs', () => {
  const out =
    process.platform === 'win32'
      ? run(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `""${join(dir, 'figtional.cmd')}" --version"`],
          {
            windowsVerbatimArguments: true,
          },
        )
      : run(join(dir, 'figtional'), ['--version']);
  if (out.trim() !== version) throw new Error(`got "${out.trim()}"`);
});

await check(`PNG renderer loads (${process.platform}-${process.arch})`, () => {
  const require = createRequire(bundle);
  const { Resvg } = require('@resvg/resvg-js');
  const png = new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
  )
    .render()
    .asPng();
  if (png[1] !== 0x50) throw new Error('not a PNG');
});

await check('setup --print', () => {
  const out = run(process.execPath, [bundle, 'setup', '--print', '--yes', scratch]);
  if (!out.includes('figtional.mjs') || !out.includes('mcpServers')) throw new Error(out);
});

if (figArg) {
  const fig = resolve(figArg);
  await check('dump', () => {
    if (!run(process.execPath, [bundle, 'dump', fig]).includes('Pages:')) throw new Error('no pages');
  });
}

await check('MCP server answers', async () => {
  const sources = figArg ? [resolve(figArg)] : [scratch];
  const client = mcpClient(process.execPath, [bundle, 'mcp', ...sources]);
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    if (init.serverInfo?.version !== version) throw new Error(`server version ${init.serverInfo?.version}`);
    client.notify('notifications/initialized', {});
    const { tools } = await client.request('tools/list', {});
    const names = tools.map((t) => t.name);
    for (const t of ['get_metadata', 'get_design_context', 'get_screenshot', 'use_figma']) {
      if (!names.includes(t)) throw new Error(`missing tool ${t}`);
    }
    if (figArg) {
      const fileKey = basename(figArg).replace(/\.fig$/i, '');
      const meta = await client.request('tools/call', {
        name: 'get_metadata',
        arguments: { fileKey, nodeId: '0:1' },
      });
      const text = meta.content?.[0]?.text ?? '';
      const id = /id="(\d+:\d+)"/.exec(text.replace(/id="0:1"/, ''))?.[1];
      if (!id) throw new Error(`get_metadata: ${text.slice(0, 300)}`);
      const shot = await client.request('tools/call', {
        name: 'get_screenshot',
        arguments: { fileKey, nodeId: id },
      });
      const image = shot.content?.find((c) => c.type === 'image');
      if (!image) throw new Error(`get_screenshot: ${JSON.stringify(shot).slice(0, 300)}`);
      console.log(`      screenshot of ${id}: ${Math.round((image.data.length * 3) / 4 / 1024)} kB`);
    }
  } finally {
    client.close();
  }
});

if (figArg) {
  await check('use_figma edits a copy and measures text', async () => {
    const out = join(scratch, 'out');
    const client = mcpClient(process.execPath, [bundle, 'mcp', '--writable', '--out', out, resolve(figArg)]);
    try {
      await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      });
      client.notify('notifications/initialized', {});
      const r = await client.request('tools/call', {
        name: 'use_figma',
        arguments: {
          fileKey: basename(figArg).replace(/\.fig$/i, ''),
          code: `await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
const t = figma.createText();
t.characters = 'Smoke test';
return { width: t.width, height: t.height };`,
        },
      });
      const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
      if (r.isError) throw new Error(text);
      const { width } = JSON.parse(/\{.*\}/s.exec(text)?.[0] ?? '{}');
      if (!(width > 10)) throw new Error(`text was not measured: ${text}`);
      console.log(`      text width ${Math.round(width)} px`);
    } finally {
      client.close();
    }
  });
}

await check('viewer serves its page', async () => {
  const child = spawn(
    process.execPath,
    [bundle, 'serve', '--port', '0', figArg ? resolve(figArg) : scratch],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const port = await new Promise((res, rej) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
        if (m) res(m[1]);
      });
      child.on('exit', (code) => rej(new Error(`viewer exited (${code}): ${out}`)));
      setTimeout(() => rej(new Error('viewer did not start')), 30_000).unref();
    });
    const base = `http://127.0.0.1:${port}`;
    for (const path of ['/', '/app.js', '/app.css', '/api/files']) {
      const r = await fetch(base + path);
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    }
    if (figArg) {
      const files = await (await fetch(`${base}/api/files`)).json();
      if (!JSON.stringify(files).includes(basename(figArg).replace(/\.fig$/i, '')))
        throw new Error('file not listed');
    }
  } finally {
    child.kill();
  }
});

rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

function mcpClient(cmd, args) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: dirname(bundle) });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`server exited (${code}): ${stderr.trim()}`));
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  return {
    request(method, params) {
      const id = nextId++;
      send({ id, method, params });
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        setTimeout(() => rej(new Error(`${method} timed out`)), 60_000).unref();
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
