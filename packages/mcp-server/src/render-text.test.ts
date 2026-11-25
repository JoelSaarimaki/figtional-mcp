import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { renderPng, renderSvg } from '@figtional/fig-render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { AssetServer, Workspace, designContext, runUseFigma } from './index.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-rtext-'));
  file = join(dir, 'a.fig');
  writeFileSync(file, syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (code: string) => {
  const w = new Workspace({ sources: [{ file, writable: true }] });
  const r = await runUseFigma(w, w.resolve('a'), code);
  return { ...r, json: () => JSON.parse(r.text) };
};
const reload = () => FigDocument.fromArchive(FigArchive.open(file));
/** Dark pixels in a render (how much "ink" the text has). */
const ink = (png: Buffer) => {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3]! > 128 && p.data[i]! < 128) n++;
  return n;
};

describe('rendering edited text and strokes', () => {
  it('draws weights, styled ranges and text case of new text', async () => {
    const r = await run(`
      for (const style of ['Regular', 'Semi Bold']) await figma.loadFontAsync({ family: 'Inter', style });
      const mk = (chars, style) => { const t = figma.createText(); t.fontName = { family: 'Inter', style };
        t.fontSize = 32; t.characters = chars; return t.id; };
      const regular = mk('Weight', 'Regular');
      const semibold = mk('Weight', 'Semi Bold');
      const ranged = figma.createText(); ranged.fontSize = 32; ranged.characters = 'redblack';
      ranged.setRangeFills(0, 3, [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]);
      const upper = figma.createText(); upper.fontSize = 32; upper.characters = 'abc'; upper.textCase = 'UPPER';
      const lower = figma.createText(); lower.fontSize = 32; lower.characters = 'abc';
      return { regular, semibold, ranged: ranged.id, upper: [upper.id, upper.width], lower: lower.width };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    const doc = reload();
    const node = (id: string) => doc.getNodeById(id)!;
    const svg = (id: string) => renderSvg(doc, node(id)).svg;
    if (!svg(o.regular).includes('<path')) return; // no fonts installed at all: nothing to compare
    expect(ink(renderPng(doc, node(o.semibold), { scale: 2 }).png)).toBeGreaterThan(
      ink(renderPng(doc, node(o.regular), { scale: 2 }).png),
    );
    expect(svg(o.ranged)).toContain('fill="#ff0000"');
    expect(svg(o.ranged)).toContain('fill="#000000"');
    // UPPER is measured and drawn in capitals, so it is wider than the same lower-case text.
    expect(o.upper[1]).toBeGreaterThan(o.lower);
  });

  it('draws dashed strokes and outputs dashed borders', async () => {
    const r = await run(`
      const f = figma.createFrame(); f.resize(100, 40); f.fills = [];
      f.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; f.strokeWeight = 2; f.dashPattern = [4, 2];
      return f.id;
    `);
    expect(r.ok, r.text).toBe(true);
    const doc = reload();
    const frame = doc.getNodeById(JSON.parse(r.text))!;
    expect(renderSvg(doc, frame).svg).toContain('stroke-dasharray="4 2"');
    const assets = new AssetServer(0);
    try {
      const ctx = await designContext(doc, 'a', frame, assets, { target: 'html-css' });
      expect(ctx.code).toContain('dashed');
    } finally {
      assets.close();
    }
  });
});
