import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { FigArchive, guidToString } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { renderPng } from '@figtional/fig-render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { Workspace, runUseFigma } from './index.js';
import { imageInfo } from './image-size.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-images-'));
  file = join(dir, 'a.fig');
  writeFileSync(file, syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A solid red PNG of the given size. */
function redPng(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([255, 0, 0, 255], i * 4);
  return PNG.sync.write(png);
}

const run = async (code: string) => {
  const w = new Workspace({ sources: [{ file, writable: true }] });
  const r = await runUseFigma(w, w.resolve('a'), code);
  return { ...r, json: () => JSON.parse(r.text) };
};

describe('images', () => {
  it('reads PNG, GIF and JPEG sizes from their headers', () => {
    expect(imageInfo(redPng(7, 5))).toEqual({ format: 'PNG', width: 7, height: 5 });
    const gif = Buffer.from('474946383961' + '0a00' + '0300', 'hex');
    expect(imageInfo(gif)).toEqual({ format: 'GIF', width: 10, height: 3 });
    // Minimal JPEG header: SOI, APP0 (len 16), SOF0 with height 2, width 4.
    const jpeg = Buffer.from(
      'ffd8' + 'ffe00010' + '00'.repeat(14) + 'ffc0000b08' + '0002' + '0004' + '010111',
      'hex',
    );
    expect(imageInfo(jpeg)).toEqual({ format: 'JPEG', width: 4, height: 2 });
    expect(imageInfo(Buffer.from('not an image'))).toBeUndefined();
  });

  it('creates images from bytes and data URLs, fills a layer and saves the image in the file', async () => {
    const png = redPng(8, 4);
    const b64 = png.toString('base64');
    const r = await run(`
      const fromUrl = await figma.createImageAsync('data:image/png;base64,${b64}');
      const fromBytes = figma.createImage(figma.base64Decode('${b64}'));
      const rect = figma.createRectangle();
      rect.resize(16, 8);
      rect.fills = [{ type: 'IMAGE', imageHash: fromBytes.hash, scaleMode: 'FILL' }];
      let url = null;
      try { await figma.createImageAsync('https://example.com/a.png'); } catch (e) { url = e.message; }
      let bad = null;
      try { figma.createImage(new Uint8Array([1, 2, 3])); } catch (e) { bad = e.message; }
      return { same: fromUrl.hash === fromBytes.hash, hash: fromBytes.hash, size: await fromBytes.getSizeAsync(),
        bytes: (await fromBytes.getBytesAsync()).length, byHash: !!figma.getImageByHash(fromBytes.hash),
        fill: rect.fills[0].imageHash, url, bad, rect: rect.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.same).toBe(true);
    expect(o.hash).toBe(createHash('sha1').update(png).digest('hex'));
    expect(o.size).toEqual({ width: 8, height: 4 });
    expect(o.bytes).toBe(png.length);
    expect(o.byHash).toBe(true);
    expect(o.fill).toBe(o.hash);
    expect(o.url).toMatch(/^NotSupportedInFigtional: createImageAsync with a URL.*no network requests/);
    expect(o.bad).toBe('Image type is unsupported');

    const archive = FigArchive.open(file);
    expect(archive.imageHashes()).toContain(o.hash);
    expect(Buffer.compare(Buffer.from(archive.image(o.hash)!), png)).toBe(0);
    const doc = FigDocument.fromArchive(archive);
    const rect = doc.getNodeById(o.rect)!;
    const paint = rect.data.fillPaints[0];
    expect(Buffer.from(paint.image.hash).toString('hex')).toBe(o.hash);
    expect([paint.originalImageWidth, paint.originalImageHeight]).toEqual([8, 4]);
    // Drawn from the saved image: the centre pixel is red.
    const shot = renderPng(doc, rect);
    const decoded = PNG.sync.read(shot.png);
    const mid = ((decoded.height >> 1) * decoded.width + (decoded.width >> 1)) * 4;
    expect([...decoded.data.subarray(mid, mid + 3)]).toEqual([255, 0, 0]);
    expect(guidToString(rect.data.guid)).toBe(o.rect);
  });

  it('refuses images over 4096 px, like Figma', async () => {
    const big = redPng(4097, 1).toString('base64');
    const r = await run(`figma.createImage(figma.base64Decode('${big}'));`);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Image is too large');
  });
});
