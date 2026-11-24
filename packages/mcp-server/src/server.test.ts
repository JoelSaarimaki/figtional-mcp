import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { REF, hasRef } from '../../../test/references.js';
import {
  EXTRA_TOOLS,
  FileNotAvailableError,
  Workspace,
  createServer,
  parseFigmaUrl,
  slugify,
} from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-ws-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, name = 'Synthetic') => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, syntheticFig({ fileName: name }));
  return p;
};

describe('Workspace scoping', () => {
  it('single file and explicit key', () => {
    const a = put('A File.fig');
    put('Other.fig');
    const ws = new Workspace({ sources: [{ file: a }] });
    expect(ws.listFiles().map((f) => f.key)).toEqual(['a-file']);
    expect(() => ws.resolve('other')).toThrow(FileNotAvailableError);
    const ws2 = new Workspace({ sources: [{ file: a, key: 'App' }] });
    expect(ws2.resolve('app').path).toContain('A File.fig');
  });

  it('folder: non-recursive by default, recursive on request, only .fig, no hidden files', () => {
    put('one.fig');
    put('TWO.FIG');
    put('sub/three.fig');
    put('.hidden.fig');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(new Workspace({ sources: [{ dir }] }).listFiles().map((f) => f.key)).toEqual(['one', 'two']);
    expect(new Workspace({ sources: [{ dir, recursive: true }] }).listFiles().map((f) => f.key)).toEqual([
      'one',
      'sub--three',
      'two',
    ]);
  });

  it('folder is live: new files appear without restart', () => {
    put('one.fig');
    const ws = new Workspace({ sources: [{ dir }] });
    expect(ws.listFiles()).toHaveLength(1);
    put('two.fig');
    expect(ws.resolve('two').key).toBe('two');
  });

  it('excludes the out dir inside a recursive folder', () => {
    put('one.fig');
    put('edited/one.fig');
    const ws = new Workspace({ sources: [{ dir, recursive: true }], outDir: join(dir, 'edited') });
    expect(ws.listFiles().map((f) => f.key)).toEqual(['one']);
  });

  it('ignores symlinks that lead outside the folder', () => {
    const inside = join(dir, 'inside');
    const outside = join(dir, 'outside');
    put('outside/secret.fig');
    put('inside/ok.fig');
    let linked = false;
    try {
      symlinkSync(outside, join(inside, 'link'), 'junction');
      symlinkSync(join(outside, 'secret.fig'), join(inside, 'secret-link.fig'), 'file');
      linked = true;
    } catch {
      // Symlinks may need privileges on Windows; the junction alone is still a useful test.
    }
    const keys = new Workspace({ sources: [{ dir: inside, recursive: true }] }).listFiles().map((f) => f.key);
    expect(keys).toEqual(['ok']);
    if (!linked) console.warn('symlink test partially skipped (no privileges)');
  });

  it('handles key collisions deterministically', () => {
    const a = put('x/My File.fig');
    const b = put('y/my-file.fig');
    const ws = new Workspace({ sources: [{ file: a }, { file: b }] });
    expect(
      ws
        .listFiles()
        .map((f) => f.key)
        .sort(),
    ).toEqual(['my-file', 'my-file-2']);
    expect(ws.warnings()).toHaveLength(1);
  });

  it('writable is opt-in', () => {
    const a = put('a.fig');
    expect(new Workspace({ sources: [{ file: a }] }).listFiles()[0]!.writable).toBe(false);
    expect(new Workspace({ sources: [{ file: a }], writable: true }).listFiles()[0]!.writable).toBe(true);
  });
});

describe('URLs and keys', () => {
  it('parses Figma URLs', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/abc/Name?node-id=1-2')).toEqual({
      fileKey: 'abc',
      nodeId: '1:2',
      editorType: 'design',
    });
    expect(parseFigmaUrl('https://figma.com/design/abc/branch/br1/Name')?.fileKey).toBe('br1');
    expect(parseFigmaUrl('https://www.figma.com/board/xyz/B')?.editorType).toBe('figjam');
    expect(parseFigmaUrl('https://example.com/design/abc')).toBeUndefined();
    expect(parseFigmaUrl('abc')).toBeUndefined();
  });

  it('slugifies', () => {
    expect(slugify('Futurice.com UI')).toBe('futurice-com-ui');
    expect(slugify('Työpaikka rope')).toBe('tyopaikka-rope');
    expect(slugify('***')).toBe('file');
  });
});

async function connect(ws: Workspace, extraTools?: boolean | string[]) {
  const server = createServer(ws, extraTools === undefined ? {} : { extraTools });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const t = r.content?.[0]?.text as string;
    return { isError: r.isError === true, text: t, json: () => JSON.parse(t) };
  };
  return { client, call };
}

describe('MCP tools', () => {
  it('lists Figma-compatible tools only, unless extras are enabled', async () => {
    const ws = new Workspace({ sources: [{ file: put('a.fig') }] });
    const { client } = await connect(ws);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'whoami',
        'get_metadata',
        'get_variable_defs',
        'search_design_system',
        'get_libraries',
      ]),
    );
    expect(names.some((n) => n.startsWith('figtional_'))).toBe(false);

    const withExtras = await connect(ws, true);
    const all = (await withExtras.client.listTools()).tools.map((t) => t.name);
    for (const t of EXTRA_TOOLS) expect(all).toContain(t);
    const some = await connect(ws, ['figtional_find_nodes']);
    expect(
      (await some.client.listTools()).tools.filter((t) => t.name.startsWith('figtional_')).map((t) => t.name),
    ).toEqual(['figtional_find_nodes']);
  });

  it('whoami reports plans and scope', async () => {
    const ws = new Workspace({ sources: [{ file: put('a.fig', 'My Design') }] });
    const { call } = await connect(ws);
    const who = (await call('whoami')).json();
    expect(who.plans[0].key).toBeDefined();
    expect(who.figtional.files).toEqual([
      expect.objectContaining({ fileKey: 'a', name: 'My Design', writable: false }),
    ]);
  });

  it('get_metadata: pages without nodeId, XML with nodeId, URL input, errors', async () => {
    const ws = new Workspace({ sources: [{ file: put('a.fig') }] });
    const { call } = await connect(ws);
    expect((await call('get_metadata', { fileKey: 'a' })).json()).toEqual([{ guid: '0:1', name: 'Page 1' }]);

    const xml = (await call('get_metadata', { fileKey: 'a', nodeId: '1-2' })).text;
    expect(xml).toBe(
      [
        '<frame id="1:2" name="Screen" x="0" y="0" width="390" height="800">',
        '  <rounded-rectangle id="1:3" name="Photo" x="20" y="20" width="100" height="50" />',
        '  <text id="1:4" name="Title" x="20" y="100" width="200" height="30" />',
        '</frame>',
      ].join('\n'),
    );
    const viaUrl = await call('get_metadata', { fileKey: 'https://www.figma.com/design/a/X?node-id=1-4' });
    expect(viaUrl.text).toContain('id="1:4"');
    const defsViaUrl = await call('get_variable_defs', {
      fileKey: 'https://www.figma.com/design/a/X?node-id=1-4',
    });
    expect(defsViaUrl.isError).toBe(false);
    const noNode = await call('get_variable_defs', { fileKey: 'a' });
    expect(noNode).toMatchObject({ isError: true, text: 'invalid nodeId' });

    const page = (await call('get_metadata', { fileKey: 'a', nodeId: '0:1' })).text;
    expect(page).toContain(
      '<frame id="1:5" name="Hidden" x="500" y="0" width="10" height="10" hidden="true" />',
    );

    const missing = await call('get_metadata', { fileKey: 'nope', nodeId: '1:2' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('not available');
    expect(missing.text).toContain('a');
    const badNode = await call('get_metadata', { fileKey: 'a', nodeId: '9:9' });
    expect(badNode.isError).toBe(true);
  });

  it('get_screenshot returns a PNG image of the node', async () => {
    const ws = new Workspace({ sources: [{ file: put('a.fig') }] });
    const server = createServer(ws);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const r: any = await client.callTool({
      name: 'get_screenshot',
      arguments: { fileKey: 'a', nodeId: '1:2' },
    });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const png = Buffer.from(r.content[0].data, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(390);
    const empty: any = await client.callTool({
      name: 'get_screenshot',
      arguments: { fileKey: 'a', nodeId: '' },
    });
    expect(empty.content[0].text).toBe('invalid nodeId');
  });

  it('get_design_context returns code for layers and refuses pages like Figma', async () => {
    const ws = new Workspace({ sources: [{ file: put('a.fig') }] });
    const { call } = await connect(ws);
    const r = await call('get_design_context', { fileKey: 'a', nodeId: '1:2', clientFrameworks: 'react' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('data-node-id="1:2"');
    const page = await call('get_design_context', { fileKey: 'a', nodeId: '0:1' });
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/^You currently have nothing selected/);
  });

  it('extra tools: find nodes and node JSON', async () => {
    const ws = new Workspace({ sources: [{ file: put('a.fig') }] });
    const { call } = await connect(ws, true);
    expect((await call('figtional_find_nodes', { fileKey: 'a', text: 'hello' })).json()).toEqual([
      { id: '1:4', name: 'Title', type: 'TEXT', page: 'Page 1' },
    ]);
    expect(
      (await call('figtional_get_node_json', { fileKey: 'a', nodeId: '1:4' })).json().unknownFutureField,
    ).toBe('keep me');
  });

  it.skipIf(!hasRef('prototyping'))('reference: variable defs and design system search', async () => {
    const ws = new Workspace({ sources: [{ file: REF.prototyping }] });
    const { call } = await connect(ws);
    const key = ws.listFiles()[0]!.key;
    const search = (
      await call('search_design_system', { fileKey: key, queries: [{ entity: 'style', query: 'grey' }] })
    ).json();
    expect(search.results[0].styles.length).toBeGreaterThan(0);
    const comp = (
      await call('search_design_system', {
        fileKey: key,
        queries: [{ entity: 'component', query: 'button' }],
      })
    ).json();
    expect(comp.results[0].components[0].name).toMatch(/button/i);
  });
});
