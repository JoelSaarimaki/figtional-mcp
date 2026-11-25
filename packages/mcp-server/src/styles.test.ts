import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FigArchive, guidToString } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { REF, hasRef } from '../../../test/references.js';
import { Workspace, runUseFigma } from './index.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-styles-'));
  file = join(dir, 'a.fig');
  writeFileSync(file, syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (code: string, key = 'a') => {
  const w = new Workspace({ sources: [{ file, writable: true }] });
  const r = await runUseFigma(w, w.resolve(key), code);
  return { ...r, json: () => JSON.parse(r.text) };
};
const reload = () => FigDocument.fromArchive(FigArchive.open(file));

describe('paint and effect styles', () => {
  it('creates, applies, updates through the style, detaches and removes', async () => {
    const r = await run(`
      const brand = figma.createPaintStyle();
      brand.name = 'Brand/Primary';
      brand.description = 'Main colour';
      brand.paints = [{ type: 'SOLID', color: { r: 0, g: 0.4, b: 1 } }];
      const rect = figma.createRectangle();
      await rect.setFillStyleIdAsync(brand.id);
      const applied = { id: rect.fillStyleId, b: rect.fills[0].color.b };
      brand.paints = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
      const afterStyleEdit = rect.fills[0].color.r;
      const other = figma.createRectangle();
      await other.setFillStyleIdAsync(brand.id);
      other.fills = [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }];
      let syncSetter = null;
      try { rect.fillStyleId = brand.id; } catch (e) { syncSetter = e.message; }
      const shadow = figma.createEffectStyle();
      shadow.name = 'Shadow/M';
      shadow.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, radius: 8, visible: true, blendMode: 'NORMAL' }];
      await rect.setEffectStyleIdAsync(shadow.id);
      const temp = figma.createPaintStyle();
      temp.paints = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      const third = figma.createRectangle();
      await third.setFillStyleIdAsync(temp.id);
      temp.remove();
      const local = (await figma.getLocalPaintStylesAsync()).map(s => s.name);
      const byId = (await figma.getStyleByIdAsync(brand.id)).name;
      let wrongType = null;
      try { await rect.setFillStyleIdAsync(shadow.id); } catch (e) { wrongType = e.message; }
      return { applied, afterStyleEdit, otherId: other.fillStyleId, syncSetter, effectId: rect.effectStyleId,
        brandId: brand.id, shadowId: shadow.id, key: brand.key, type: brand.type, desc: brand.description,
        removedRef: third.fillStyleId, thirdFill: third.fills[0].color.r, local, byId, wrongType,
        effects: rect.effects.length, rect: rect.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.brandId).toMatch(/^S:[0-9a-f]{40},\d+:\d+$/);
    expect(o.key).toMatch(/^[0-9a-f]{40}$/);
    expect(o.type).toBe('PAINT');
    expect(o.desc).toBe('Main colour');
    expect(o.applied).toEqual({ id: o.brandId, b: 1 });
    expect(o.afterStyleEdit).toBe(1); // the rectangle follows the style
    expect(o.otherId).toBe(''); // setting fills directly detaches
    expect(o.syncSetter).toMatch(/documentAccess: dynamic-page.*setFillStyleIdAsync/);
    expect(o.effectId).toBe(o.shadowId);
    expect(o.effects).toBe(1);
    expect(o.removedRef).toBe(''); // removing a style keeps the value and drops the link
    expect(o.thirdFill).toBe(0);
    expect(o.local).toEqual(['Brand/Primary']);
    expect(o.byId).toBe('Brand/Primary');
    expect(o.wrongType).toMatch(/is a EFFECT style, not a PAINT style/);

    // Saved like Figma's local styles: hidden, locked nodes on the internal page, referenced by guid.
    const doc = reload();
    const style = doc.styles.find((s) => s.name === 'Brand/Primary')!;
    expect(style.type).toBe('ROUNDED_RECTANGLE');
    expect(style.styleType).toBe('FILL');
    expect(style.visible).toBe(false);
    expect(style.locked).toBe(true);
    expect(style.styleDescription).toBe('Main colour');
    expect(doc.nodes.get(guidToString(style.parentIndex!.guid))!.internalOnly).toBe(true);
    const rect = doc.getNodeById(o.rect)!;
    expect(guidToString(rect.data.styleIdForFill.guid)).toBe(guidToString(style.guid));
    expect(rect.data.fillPaints[0].color.r).toBe(1);
    expect(doc.styles.find((s) => s.name === 'Shadow/M')!.effects).toHaveLength(1);
  });
});

describe('text styles', () => {
  it('applies typography and keeps text using the style in sync', async () => {
    const r = await run(`
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      const h1 = figma.createTextStyle();
      h1.name = 'Heading/H1';
      h1.fontSize = 32;
      h1.lineHeight = { unit: 'PIXELS', value: 40 };
      h1.letterSpacing = { unit: 'PERCENT', value: -2 };
      const t = figma.createText();
      t.characters = 'Hello world';
      const w12 = t.width;
      await t.setTextStyleIdAsync(h1.id);
      const applied = { id: t.textStyleId, size: t.fontSize, lh: t.lineHeight, w: t.width };
      h1.fontSize = 40;
      const afterEdit = { size: t.fontSize, w: t.width };
      t.fontSize = 10;
      return { h1: h1.id, w12, applied, afterEdit, detached: t.textStyleId,
        local: (await figma.getLocalTextStylesAsync()).map(s => [s.name, s.fontSize]) };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.applied.id).toBe(o.h1);
    expect(o.applied.size).toBe(32);
    expect(o.applied.lh).toEqual({ unit: 'PIXELS', value: 40 });
    expect(o.applied.w).toBeGreaterThan(o.w12 * 2); // re-measured at the new size
    expect(o.afterEdit.size).toBe(40);
    expect(o.afterEdit.w).toBeGreaterThan(o.applied.w);
    expect(o.detached).toBe('');
    expect(o.local).toEqual([['Heading/H1', 40]]);
    const style = reload().styles.find((s) => s.name === 'Heading/H1')!;
    expect(style.type).toBe('TEXT');
    expect(style.textData.characters).toBe('Rag 123');
  });

  it('requires the style font to be loaded, like Figma', async () => {
    const r = await run(`
      const s = figma.createTextStyle();
      s.fontName = { family: 'Roboto', style: 'Bold' };
    `);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Cannot use unloaded font "Roboto Bold"');
  });

  it.skipIf(!hasRef('ttrpg'))("lists a real file's local text styles and their text", async () => {
    copyFileSync(REF.ttrpg, file);
    const r = await run(`
      const styles = await figma.getLocalTextStylesAsync();
      const used = figma.root.findOne(n => n.type === 'TEXT' && n.textStyleId !== '');
      return { count: styles.length, first: styles[0] && { name: styles[0].name, size: styles[0].fontSize },
        usedStyle: used && (await figma.getStyleByIdAsync(used.textStyleId)).name };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.count).toBe(8);
    expect(typeof o.first.name).toBe('string');
    expect(typeof o.usedStyle).toBe('string');
  });
});
