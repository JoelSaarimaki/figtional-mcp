import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { renderSvg } from '@figtional/fig-render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { Workspace, runUseFigma } from './index.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-extras-'));
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

describe('node properties', () => {
  it('stroke caps, corner smoothing and layout grids', async () => {
    const r = await run(`
      const line = figma.createLine(); line.strokeCap = 'ROUND';
      const f = figma.createFrame(); f.cornerRadius = 12; f.cornerSmoothing = 0.6;
      f.layoutGrids = [
        { pattern: 'COLUMNS', alignment: 'STRETCH', count: 12, gutterSize: 16, offset: 24, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } },
        { pattern: 'GRID', sectionSize: 8, visible: true, color: { r: 0, g: 0, b: 1, a: 0.1 } },
      ];
      const style = figma.createGridStyle(); style.name = 'Grid/12';
      style.layoutGrids = [f.layoutGrids[0]];
      let bad = null;
      try { f.cornerSmoothing = 2; } catch (e) { bad = e.message; }
      return { cap: line.strokeCap, smoothing: f.cornerSmoothing, grids: f.layoutGrids, styleGrids: style.layoutGrids, bad, f: f.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.cap).toBe('ROUND');
    expect(o.smoothing).toBe(0.6);
    expect(o.bad).toMatch(/between 0 and 1/);
    expect(o.grids[0]).toEqual({
      pattern: 'COLUMNS',
      alignment: 'STRETCH',
      gutterSize: 16,
      count: 12,
      offset: 24,
      visible: true,
      color: { r: 1, g: 0, b: 0, a: 0.1 },
    });
    expect(o.grids[1]).toEqual({
      pattern: 'GRID',
      sectionSize: 8,
      visible: true,
      color: { r: 0, g: 0, b: 1, a: 0.1 },
    });
    expect(o.styleGrids).toEqual([o.grids[0]]);
    // Stored like Figma's grids.
    expect(reload().getNodeById(o.f)!.data.layoutGrids[0]).toMatchObject({
      type: 'STRETCH',
      axis: 'X',
      numSections: 12,
      pattern: 'STRIPES',
    });
  });

  it('truncates text at maxLines with an ellipsis', async () => {
    const r = await run(`
      const t = figma.createText(); t.textAutoResize = 'HEIGHT'; t.resize(60, 20);
      t.characters = 'one two three four five six seven eight nine ten';
      const full = t.height;
      t.textTruncation = 'ENDING'; t.maxLines = 2;
      return { full, capped: t.height, id: t.id, maxLines: t.maxLines, truncation: t.textTruncation };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.capped).toBeLessThan(o.full);
    expect(o.maxLines).toBe(2);
    expect(o.truncation).toBe('ENDING');
    const doc = reload();
    const svg = renderSvg(doc, doc.getNodeById(o.id)!).svg;
    // Outlines, or SVG text ending in an ellipsis where no font is installed.
    expect(svg.includes('<path') || svg.includes('…')).toBe(true);
  });

  it('stores private and shared plugin data', async () => {
    const r = await run(`
      const f = figma.createFrame();
      f.setPluginData('status', 'draft');
      f.setSharedPluginData('tokens', 'fill', '"primary"');
      const before = [f.getPluginData('status'), f.getPluginDataKeys(), f.getSharedPluginData('tokens', 'fill'), f.getSharedPluginDataKeys('tokens')];
      f.setPluginData('status', '');
      let ns = null;
      try { f.setSharedPluginData('x', 'k', 'v'); } catch (e) { ns = e.message; }
      return { before, after: f.getPluginDataKeys(), ns, id: f.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.before).toEqual(['draft', ['status'], '"primary"', ['fill']]);
    expect(o.after).toEqual([]);
    expect(o.ns).toMatch(/Invalid namespace/);
    expect(reload().getNodeById(o.id)!.data.pluginData).toEqual([
      { pluginID: '', value: '"primary"', key: 'tokens-fill' },
    ]);
  });

  it('lists and resets instance overrides, and sets mainComponent', async () => {
    const r = await run(`
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      const c = figma.createComponent(); c.layoutMode = 'HORIZONTAL'; c.paddingLeft = 8;
      const t = figma.createText(); t.characters = 'Hi'; c.appendChild(t);
      const other = figma.createComponent(); other.name = 'Other';
      const i = c.createInstance();
      i.paddingLeft = 20;
      i.children[0].characters = 'Hello';
      const overrides = i.overrides;
      i.resetOverrides();
      const reset = { pad: i.paddingLeft, text: i.children[0].characters, overrides: i.overrides };
      i.mainComponent = other;
      return { overrides, reset, main: i.mainComponent.name, inst: i.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.overrides.map((x: any) => x.id)).toContain(o.inst);
    expect(o.overrides.find((x: any) => x.id === o.inst).overriddenFields).toContain('paddingLeft');
    expect(o.overrides.some((x: any) => x.overriddenFields.includes('characters'))).toBe(true);
    expect(o.reset).toEqual({ pad: 8, text: 'Hi', overrides: [] });
    expect(o.main).toBe('Other');
  });
});
