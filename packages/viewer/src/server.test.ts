import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@figtional/mcp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { createViewerServer } from './index.js';

let dir: string;
let port: number;
let server: ReturnType<typeof createViewerServer>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-viewer-'));
  writeFileSync(join(dir, 'a.fig'), syntheticFig({ fileName: 'Viewer Test' }));
  writeFileSync(join(dir, 'secret.fig'), syntheticFig());
  server = createViewerServer(new Workspace({ sources: [{ file: join(dir, 'a.fig') }] }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function get(path: string, host = '127.0.0.1') {
  return new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `${host}:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          type: String(res.headers['content-type']),
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}
const json = async (path: string) => JSON.parse((await get(path)).body.toString());

describe('viewer server', () => {
  it('binds to loopback only and rejects foreign Host headers', async () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect((await get('/api/files', 'evil.example')).status).toBe(403);
  });

  it('serves the client and only configured files', async () => {
    const index = await get('/');
    expect(index.type).toContain('text/html');
    expect(await json('/api/files')).toEqual([{ key: 'a', name: 'Viewer Test', writable: false }]);
    expect((await get('/api/file?file=secret')).status).toBe(404);
    expect((await get('/../secret.fig')).status).toBe(404);
  });

  it('describes pages, children and nodes', async () => {
    const info = await json('/api/file?file=a');
    expect(info.pages).toEqual([{ id: '0:1', name: 'Page 1', divider: false }]);
    const page = await json('/api/page?file=a&page=0:1');
    expect(page.items.map((i: any) => i.name)).toEqual(['Screen']); // hidden frame skipped
    const kids = await json('/api/children?file=a&node=1:2');
    expect(kids.map((k: any) => k.name)).toEqual(['Photo', 'Title']);
    const node = await json('/api/node?file=a&node=1-4');
    expect(node).toMatchObject({
      id: '1:4',
      type: 'TEXT',
      path: ['0:1', '1:2'],
      text: { characters: 'Hello' },
    });
  });

  it('hit-tests: top level by default, deepest with deep=1', async () => {
    expect(await json('/api/hit?file=a&page=0:1&x=30&y=110')).toEqual({ id: '1:4' });
    expect(await json('/api/hit?file=a&page=0:1&x=300&y=700')).toEqual({ id: '1:2' });
    expect(await json('/api/hit?file=a&page=0:1&x=-50&y=-50')).toEqual({ id: null });
  });

  it('renders PNGs and refuses writes', async () => {
    const png = await get('/api/render?file=a&node=1:2&scale=0.5');
    expect(png.type).toBe('image/png');
    expect(png.body.readUInt32BE(16)).toBe(195);
    const post = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/files', method: 'POST' }, (res) =>
        resolve(res.statusCode!),
      );
      req.end();
    });
    expect(post).toBe(405);
  });
});
