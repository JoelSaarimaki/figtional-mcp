import { request } from 'node:http';
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { afterAll, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { REF, hasRef } from '../../../test/references.js';
import { AssetServer, codeTarget, designContext, designContextText } from './index.js';

const assets = new AssetServer(0);
afterAll(() => assets.close());
const doc = () => FigDocument.fromArchive(FigArchive.fromBytes(syntheticFig()));

function fetchStatus(url: string, host?: string) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { host: '127.0.0.1', port: u.port, path: u.pathname, headers: host ? { host } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('design context', () => {
  it('chooses the output style from client hints', () => {
    expect(codeTarget()).toBe('react-tailwind');
    expect(codeTarget('typescript', 'react')).toBe('react-tailwind');
    expect(codeTarget('html,css', '')).toBe('html-css');
    expect(codeTarget('', 'html')).toBe('html-css');
  });

  it('React + Tailwind with node ids, names, text and image assets', async () => {
    const d = doc();
    const r = await designContext(d, 'a', d.getNodeById('1:2')!, assets, { target: 'react-tailwind' });
    expect(r.code).toContain('export default function Screen()');
    expect(r.code).toContain('data-node-id="1:2"');
    expect(r.code).toContain('bg-[#ffffff]');
    expect(r.code).toContain('>Hello</p>');
    expect(r.code).toContain("font-['Inter',sans-serif]");
    expect(r.assets).toHaveLength(1);
    expect(r.code).toMatch(/const img\w+ = "http:\/\/localhost:\d+\/assets\/[0-9a-f]{40}\.png";/);
    // The image is served by the local asset server, only for localhost hosts.
    const ok = await fetchStatus(r.assets[0]!.url);
    expect(ok.status).toBe(200);
    expect([...ok.body]).toEqual([1, 2, 3, 4]);
    expect((await fetchStatus(r.assets[0]!.url, 'evil.example')).status).toBe(403);
    expect((await fetchStatus(r.assets[0]!.url.replace(/[0-9a-f]{40}/, 'f'.repeat(40)))).status).toBe(404);
  });

  it('corner radius becomes rounded-[…], not a border', async () => {
    const d = doc();
    const node = d.getNodeById('1:2')!;
    node.data.cornerRadius = 20;
    const r = await designContext(d, 'a', node, assets, { target: 'react-tailwind' });
    expect(r.code).toContain('rounded-[20px]');
    expect(r.code).not.toMatch(/border-r-\[|border-undefined|border-\[\]/);

    Object.assign(node.data, {
      rectangleCornerRadiiIndependent: true,
      rectangleTopLeftCornerRadius: 20,
      rectangleTopRightCornerRadius: 0,
      rectangleBottomRightCornerRadius: 8,
      rectangleBottomLeftCornerRadius: 0,
    });
    const mixed = await designContext(d, 'a', node, assets, { target: 'react-tailwind' });
    expect(mixed.code).toContain('rounded-[20px_0px_8px_0px]');
    expect(mixed.code).not.toContain('border-');
  });

  it('HTML with inline CSS', async () => {
    const d = doc();
    const r = await designContext(d, 'a', d.getNodeById('1:2')!, assets, { target: 'html-css' });
    expect(r.code).toMatch(
      /^<div style="position: relative; width: 390px; height: 800px;[^"]*background-color: #ffffff/,
    );
    expect(r.code).toContain('<p style="');
    expect(r.code).toContain('>Hello</p>');
  });

  it('frames the response like Figma MCP and truncates large output', async () => {
    const d = doc();
    const text = await designContextText(d, 'a', d.getNodeById('1:2')!, assets, 'react-tailwind');
    expect(text).toContain('SUPER CRITICAL');
    const big = await designContext(d, 'a', d.getNodeById('1:2')!, assets, {
      target: 'react-tailwind',
      maxChars: 50,
    });
    expect(big.truncated).toBe(true);
  });

  it.skipIf(!hasRef('responsive'))(
    'reference: auto layout becomes flexbox, vectors become SVG assets',
    async () => {
      const d = FigDocument.fromArchive(FigArchive.open(REF.responsive));
      const r = await designContext(d, 'r', d.getNodeById('2:12')!, assets, { target: 'react-tailwind' });
      expect(r.code).toContain('flex flex-col');
      expect(r.code).toMatch(/gap-\[\d+px\]/);
      const svg = r.assets.find((a) => a.url.endsWith('.svg'))!;
      const res = await fetchStatus(svg.url);
      expect(res.body.toString()).toMatch(/^<svg /);
    },
  );
});
