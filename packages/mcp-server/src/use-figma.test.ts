import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  dir = mkdtempSync(join(tmpdir(), 'figtional-edit-'));
  file = join(dir, 'a.fig');
  writeFileSync(file, syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ws = (writable = true) => new Workspace({ sources: [{ file, writable }] });
const run = async (code: string, writable = true) => {
  const w = ws(writable);
  return runUseFigma(w, w.resolve('a'), code);
};
const reload = () => FigDocument.fromArchive(FigArchive.open(file));

describe('font limitation notes', () => {
  const MISSING = 'Figtional Missing Font';
  it('notes text measured with a replacement font, and keeps the result as Figma returns it', async () => {
    const r = await run(`
      await figma.loadFontAsync({ family: '${MISSING}', style: 'Regular' });
      const t = figma.createText();
      t.fontName = { family: '${MISSING}', style: 'Regular' };
      t.characters = 'Hello';
      t.screenshot && await t.screenshot();
      return t.id;
    `);
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(r.text)).toMatch(/^\d+:\d+$/);
    const notes = r.notes ?? [];
    const measured = notes.find((n) => n.includes('measured')) ?? '';
    expect(measured.startsWith('Figtional limitation: this font is not installed')).toBe(true);
    expect(measured).toContain(`"${MISSING} Regular" (measured with `);
    expect(notes.find((n) => n.includes('drawn'))).toMatch(
      /^Figtional limitation: .*in the screenshot is drawn/,
    );
    // The file keeps the requested font.
    const t = reload().getNodeById(JSON.parse(r.text))!;
    expect(t.data.textData.characters).toBe('Hello');
    expect(t.data.fontName.family).toBe(MISSING);
  });

  it('adds no note when no text was measured', async () => {
    const r = await run(`const f = figma.createFrame(); f.resize(10, 10); return f.id;`);
    expect(r.ok, r.text).toBe(true);
    expect(r.notes).toBeUndefined();
  });
});

describe('use_figma runtime contract', () => {
  it('returns JSON of the return value and supports top-level await', async () => {
    const r = await run(
      `const p = await figma.getNodeByIdAsync('1:2'); return { name: p.name, kids: p.children.map(c => c.name) };`,
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ name: 'Screen', kids: ['Photo', 'Title'] });
  });

  it('reports errors with safeToRetryWithoutCanvasRead and changes nothing', async () => {
    const before = readFileSync(file);
    const r = await run(
      `const t = await figma.getNodeByIdAsync('1:3'); t.name = 'Changed'; throw new Error('boom');`,
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain('boom');
    expect(r.text).toContain('safeToRetryWithoutCanvasRead: true');
    expect(readFileSync(file)).toEqual(before);
  });

  it('refuses edits to read-only files', async () => {
    const r = await run(`figma.currentPage.name = 'x'`, false);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/read-only/);
  });

  it("mirrors Figma's errors for common mistakes", async () => {
    expect((await run(`figma.currentPage = figma.root.children[0]`)).text).toContain(
      'Setting figma.currentPage is not supported',
    );
    expect((await run(`figma.notify('hi')`)).text).toContain('not implemented');
    expect((await run(`figma.closePlugin(); return 1`)).ok).toBe(true);
    const fills = await run(
      `const r = figma.createRectangle(); r.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }]`,
    );
    expect(fills.text).toContain("Unrecognized key(s) in object: 'a' at [0].color");
    const range = await run(
      `const r = figma.createRectangle(); r.fills = [{ type: 'SOLID', color: { r: 2, g: 0, b: 0 } }]`,
    );
    expect(range.text).toContain('Property value out of range');
    const extensible = await run(`const r = figma.createRectangle(); r.madeUp = 1;`);
    expect(extensible.text).toMatch(/not extensible/);
    const textProp = await run(`const r = figma.createRectangle(); return r.characters;`);
    expect(textProp.text).toContain("node.characters: no such property 'characters' on RECTANGLE node");
    const sizing = await run(`const r = figma.createRectangle(); r.layoutSizingHorizontal = 'FILL';`);
    expect(sizing.text).toContain('FILL can only be set on children of auto-layout frames');
  });

  it('enforces font loading before text edits (Inter is preloaded)', async () => {
    const r = await run(
      `const t = await figma.getNodeByIdAsync('1:4'); t.fontName = { family: 'Roboto', style: 'Bold' };`,
    );
    expect(r.text).toContain('Cannot use unloaded font "Roboto Bold"');
    const ok = await run(
      `await figma.loadFontAsync({ family: 'Roboto', style: 'Bold' }); const t = await figma.getNodeByIdAsync('1:4'); t.fontName = { family: 'Roboto', style: 'Bold' }; t.characters = 'Hi'; return t.fontName;`,
    );
    expect(ok.ok).toBe(true);
    const unloaded = await run(`const t = await figma.getNodeByIdAsync('1:4'); t.characters = 'x'`);
    expect(unloaded.text).toContain('Cannot write to node with unloaded font "Roboto Bold"');
  });
});

describe('use_figma edits', () => {
  it('builds an auto-layout card with text; saves, lays out and measures', async () => {
    const r = await run(`
      const card = figma.createAutoLayout('VERTICAL', { name: 'Card', itemSpacing: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 });
      card.fills = [figma.util.solidPaint('#F5F5F5')];
      card.cornerRadius = 8;
      const title = figma.createText();
      title.characters = 'Hello card';
      title.fontSize = 20;
      card.appendChild(title);
      const bar = figma.createRectangle();
      bar.resize(120, 4);
      card.appendChild(bar);
      bar.layoutSizingHorizontal = 'FILL';
      return { id: card.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const id = JSON.parse(r.text).id;
    const doc = reload();
    const card = doc.getNodeById(id)!;
    expect(card.children.map((c) => c.type)).toEqual(['TEXT', 'RECTANGLE']);
    const [title, bar] = card.children;
    // Hug: width = widest child (a fill child counts with its current width) + padding.
    expect(title!.width).toBeGreaterThan(50);
    expect(card.width).toBeCloseTo(Math.max(title!.width, 120) + 32, 0);
    expect(card.height).toBeCloseTo(12 + title!.height + 8 + 4 + 12, 0);
    expect(bar!.width).toBeCloseTo(card.width - 32, 0); // fill
    expect(title!.relativeTransform.m02).toBe(16);
    expect(bar!.relativeTransform.m12).toBeCloseTo(12 + title!.height + 8, 0);
    expect(title!.name).toBe('Hello card'); // auto-rename
    expect(title!.data.derivedTextData).toBeUndefined();
    // The page is still listed and the file re-encodes.
    expect(doc.pages.map((p) => p.name)).toEqual(['Page 1']);
  });

  it('edits text, colours and layout of existing nodes', async () => {
    const r = await run(`
      const t = await figma.getNodeByIdAsync('1:4');
      t.characters = 'Changed title';
      const s = await figma.getNodeByIdAsync('1:2');
      s.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
      s.name = 'Screen 2';
      return [t.characters, s.fills[0].color];
    `);
    expect(r.ok, r.text).toBe(true);
    const doc = reload();
    expect(doc.getNodeById('1:4')!.data.textData.characters).toBe('Changed title');
    expect(doc.getNodeById('1:2')!.name).toBe('Screen 2');
    expect(doc.getNodeById('1:2')!.data.fillPaints[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    // Untouched nodes keep their data.
    expect(doc.getNodeById('1:3')!.data.unknownFutureField).toBeUndefined();
    expect(doc.getNodeById('1:4')!.data.unknownFutureField).toBe('keep me');
  });

  it('clones, moves and removes nodes; creates and removes pages', async () => {
    const r = await run(`
      const photo = await figma.getNodeByIdAsync('1:3');
      const copy = photo.clone();
      copy.name = 'Photo copy';
      const page = figma.createPage();
      page.name = 'Second';
      await figma.setCurrentPageAsync(page);
      const f = figma.createFrame();
      f.appendChild(copy);
      (await figma.getNodeByIdAsync('1:5')).remove();
      return { pages: figma.root.children.map(p => p.name), copyParent: copy.parent.name };
    `);
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({
      pages: ['Page 1', 'Second'],
      copyParent: expect.stringMatching(/^Frame \d+$/),
    });
    const doc = reload();
    expect(doc.pages.map((p) => p.name)).toEqual(['Page 1', 'Second']);
    expect(doc.getNodeById('1:5')).toBeUndefined();
    expect(doc.pages[1]!.children[0]!.children[0]!.name).toBe('Photo copy');
    // Removing the last user page is refused.
    const last = await run(`for (const p of figma.root.children) p.remove();`);
    expect(last.text).toContain('Cannot remove the last page');
  });

  it('creates variables and binds them to fills and spacing', async () => {
    const r = await run(`
      const c = figma.variables.createVariableCollection('Tokens');
      const brand = figma.variables.createVariable('color/brand', c, 'COLOR');
      brand.setValueForMode(c.defaultModeId, { r: 0, g: 0.4, b: 1 });
      const gap = figma.variables.createVariable('space/m', c, 'FLOAT');
      gap.setValueForMode(c.defaultModeId, 24);
      const s = await figma.getNodeByIdAsync('1:2');
      s.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', brand)];
      s.layoutMode = 'VERTICAL';
      s.setBoundVariable('itemSpacing', gap);
      return { vars: (await figma.variables.getLocalVariablesAsync()).map(v => v.name), spacing: s.itemSpacing, bound: Object.keys(s.boundVariables) };
    `);
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(r.text)).toEqual({
      vars: ['color/brand', 'space/m'],
      spacing: 24,
      bound: ['itemSpacing', 'fills'],
    });
    const doc = reload();
    const screen = doc.getNodeById('1:2')!;
    expect(screen.data.fillPaints[0].colorVar.value.alias.guid).toBeDefined();
    expect(screen.data.fillPaints[0].color.b).toBeCloseTo(1);
    expect(doc.variables.map((v) => v.name)).toEqual(['color/brand', 'space/m']);
    expect(doc.internalPage).toBeDefined();
  });

  it('sets explicit variable modes on frames, and draws bound colours in that mode', async () => {
    const r = await run(`
      const c = figma.variables.createVariableCollection('Theme');
      c.renameMode(c.defaultModeId, 'Light');
      const dark = c.addMode('Dark');
      const bg = figma.variables.createVariable('bg', c, 'COLOR');
      bg.setValueForMode(c.defaultModeId, { r: 1, g: 1, b: 1 });
      bg.setValueForMode(dark, { r: 0, g: 0, b: 0 });
      const frame = figma.createFrame();
      frame.resize(40, 40);
      const box = figma.createRectangle();
      box.resize(20, 20);
      box.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }, 'color', bg)];
      frame.appendChild(box);
      frame.setExplicitVariableModeForCollection(c, dark);
      const explicit = frame.explicitVariableModes;
      const resolvedBox = box.resolvedVariableModes[c.id];
      const other = figma.createFrame();
      other.setExplicitVariableModeForCollection(c.id, dark);
      other.clearExplicitVariableModeForCollection(c);
      let bad = null;
      try { frame.setExplicitVariableModeForCollection(c, 'nope'); } catch (e) { bad = e.message; }
      let onRect = null;
      try { box.setExplicitVariableModeForCollection(c, dark); } catch (e) { onRect = e.constructor.name; }
      return { cid: c.id, dark, explicit, resolvedBox, cleared: other.explicitVariableModes, bad, onRect, frame: frame.id, box: box.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = JSON.parse(r.text);
    expect(out.explicit).toEqual({ [out.cid]: out.dark });
    expect(out.resolvedBox).toBe(out.dark);
    expect(out.cleared).toEqual({});
    expect(out.bad).toMatch(/^Mode nope not found/);
    expect(out.onRect).toBe('TypeError');
    // Saved like Figma: a local collection is referenced by guid.
    const doc = reload();
    const frame = doc.getNodeById(out.frame)!;
    const [entry] = frame.data.variableModeBySetMap.entries;
    expect(`VariableCollectionId:${guidToString(entry.variableSetID.guid)}`).toBe(out.cid);
    expect(guidToString(entry.variableModeID)).toBe(out.dark);
    // The stored (inline) colour follows the mode, and drawing uses the Dark value.
    const box = doc.getNodeById(out.box)!;
    expect(box.data.fillPaints[0].color.r).toBe(0);
    const { renderSvg } = await import('@figtional/fig-render');
    expect(renderSvg(doc, frame).svg).toContain('#000000');
  });

  it('saves a single min/max dimension the way Figma stores it (unset min 0, unset max Infinity)', async () => {
    const r = await run(`
      const f = figma.createFrame();
      f.layoutMode = 'VERTICAL';
      f.minWidth = 120;
      f.maxHeight = 300;
      const before = [f.minWidth, f.minHeight, f.maxWidth, f.maxHeight];
      f.minWidth = null;
      return { id: f.id, before, after: [f.minWidth, f.maxHeight] };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = JSON.parse(r.text);
    expect(o.before).toEqual([120, null, null, 300]);
    expect(o.after).toEqual([null, 300]);
    const f = reload().getNodeById(o.id)!;
    expect(f.data.minSize).toBeUndefined();
    expect(f.data.maxSize.value).toEqual({ x: Infinity, y: 300 });
  });

  it('writes layer blurs as FOREGROUND_BLUR, the name in the file schema', async () => {
    const r = await run(`
      const f = figma.createRectangle();
      f.effects = [{ type: 'LAYER_BLUR', radius: 4, visible: true }];
      return { id: f.id, type: f.effects[0].type };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = JSON.parse(r.text);
    expect(o.type).toBe('LAYER_BLUR');
    expect(reload().getNodeById(o.id)!.data.effects[0].type).toBe('FOREGROUND_BLUR');
  });

  it('serialises repeated (non-circular) references in full', async () => {
    const r = await run(
      `const o = { a: 1 }; const c = { self: null }; c.self = c; return { x: o, y: o, list: [o, o], c };`,
    );
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(r.text)).toEqual({
      x: { a: 1 },
      y: { a: 1 },
      list: [{ a: 1 }, { a: 1 }],
      c: { self: '[Circular]' },
    });
  });

  it('keeps an explicitly set text layer name when the text changes (autoRename off), like Figma', async () => {
    const r = await run(`
      const t = figma.createText();
      t.characters = 'First';
      const auto = t.name;
      t.name = 'Title';
      t.characters = 'Second';
      return { auto, named: t.name, autoRename: t.autoRename };
    `);
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ auto: 'First', named: 'Title', autoRename: false });
  });

  it('applies bound numbers, strings and booleans in the mode in effect, also per corner', async () => {
    const r = await run(`
      const c = figma.variables.createVariableCollection('Content');
      c.renameMode(c.defaultModeId, 'English');
      const fi = c.addMode('Finnish');
      const title = figma.variables.createVariable('title', c, 'STRING');
      title.setValueForMode(c.defaultModeId, 'Settings'); title.setValueForMode(fi, 'Asetukset');
      const show = figma.variables.createVariable('show', c, 'BOOLEAN');
      show.setValueForMode(c.defaultModeId, true); show.setValueForMode(fi, false);
      const radius = figma.variables.createVariable('radius', c, 'FLOAT');
      radius.setValueForMode(c.defaultModeId, 8); radius.setValueForMode(fi, 20);
      const frame = figma.createFrame();
      const t = figma.createText(); t.characters = 'x'; frame.appendChild(t);
      t.setBoundVariable('characters', title);
      const row = figma.createRectangle(); frame.appendChild(row);
      row.setBoundVariable('visible', show);
      row.setBoundVariable('topLeftRadius', radius);
      const english = { text: t.characters, visible: row.visible, tl: row.topLeftRadius, tr: row.topRightRadius };
      frame.setExplicitVariableModeForCollection(c, fi);
      return { english, finnish: { text: t.characters, visible: row.visible, tl: row.topLeftRadius } };
    `);
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(r.text)).toEqual({
      english: { text: 'Settings', visible: true, tl: 8, tr: 0 },
      finnish: { text: 'Asetukset', visible: false, tl: 20 },
    });
  });

  it('reuses the document between calls without keeping edits of a failed call', async () => {
    const w = ws();
    const e = w.resolve('a');
    const ok = await runUseFigma(w, e, `const f = figma.createFrame(); f.name = 'Kept'; return f.id;`);
    expect(ok.ok, ok.text).toBe(true);
    const id = JSON.parse(ok.text);
    const failed = await runUseFigma(
      w,
      e,
      `(await figma.getNodeByIdAsync('${id}')).name = 'Partial'; throw new Error('boom');`,
    );
    expect(failed.ok).toBe(false);
    const after = await runUseFigma(w, e, `return (await figma.getNodeByIdAsync('${id}')).name;`);
    expect(JSON.parse(after.text)).toBe('Kept');
    // A change made outside Figtional (e.g. a new export) is picked up, not the cached document.
    writeFileSync(file, syntheticFig());
    const fresh = await runUseFigma(w, e, `return !!(await figma.getNodeByIdAsync('${id}'));`);
    expect(JSON.parse(fresh.text)).toBe(false);
  });

  it('accumulates edits in --out copies and keeps the original untouched', async () => {
    const before = readFileSync(file);
    const out = join(dir, 'out');
    const w = new Workspace({ sources: [{ file, writable: true }], outDir: out });
    await runUseFigma(w, w.resolve('a'), `(await figma.getNodeByIdAsync('1:2')).name = 'One'`);
    await runUseFigma(w, w.resolve('a'), `(await figma.getNodeByIdAsync('1:3')).name = 'Two'`);
    expect(readFileSync(file)).toEqual(before);
    const doc = FigDocument.fromArchive(FigArchive.open(join(out, 'a.fig')));
    expect([doc.getNodeById('1:2')!.name, doc.getNodeById('1:3')!.name]).toEqual(['One', 'Two']);
  });

  it('saves even when the workspace has the file open from an earlier read (Windows file locks)', async () => {
    const w = ws();
    const entry = w.resolve('a');
    w.document(entry); // e.g. a get_metadata call before the edit
    const r = await runUseFigma(w, entry, `(await figma.getNodeByIdAsync('1:2')).name = 'After read'`);
    expect(r.ok, r.text).toBe(true);
    expect(reload().getNodeById('1:2')!.name).toBe('After read');
    expect(w.document(w.resolve('a')).getNodeById('1:2')!.name).toBe('After read'); // cache refreshed
  });

  it('query() and set() helpers', async () => {
    const r = await run(`
      const res = figma.currentPage.query('FRAME > TEXT');
      res.set({ name: 'Queried' });
      return { n: res.length, names: figma.currentPage.query('[name^=Quer]').map(n => n.id) };
    `);
    expect(JSON.parse(r.text)).toEqual({ n: 1, names: ['1:4'] });
  });

  it('screenshots attach images', async () => {
    const r = await run(`await (await figma.getNodeByIdAsync('1:2')).screenshot(); return 'ok'`);
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.caption).toBe('Screen (390x800 at 0,0).png');
  });
});

describe.skipIf(!hasRef('ttrpg'))('use_figma on a real file', () => {
  it('overrides text inside an instance and keeps the file valid', async () => {
    const copy = join(dir, 'ttrpg.fig');
    copyFileSync(REF.ttrpg, copy);
    const w = new Workspace({ sources: [{ file: copy, writable: true }] });
    const doc0 = FigDocument.fromArchive(FigArchive.open(copy));
    const inst = [...doc0.nodes.values()].find(
      (n) =>
        n.type === 'INSTANCE' && doc0.getNodeById(guidToString(n.guid))?.findOne((c) => c.figType === 'TEXT'),
    )!;
    const instId = guidToString(inst.guid);
    doc0.archive?.close();
    const r = await runUseFigma(
      w,
      w.resolve('ttrpg'),
      `
      const inst = await figma.getNodeByIdAsync('${instId}');
      const text = inst.findOne(n => n.type === 'TEXT');
      for (const s of text.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(s.fontName);
      text.characters = 'Overridden!';
      return { id: text.id, chars: text.characters };
    `,
    );
    expect(r.ok, r.text).toBe(true);
    const { id } = JSON.parse(r.text);
    const doc = FigDocument.fromArchive(FigArchive.open(copy));
    expect(doc.getNodeById(id)!.data.textData.characters).toBe('Overridden!');
    // Stored as an override, or as a component property value when the text is bound to one.
    const raw = doc.getNodeById(instId)!.data;
    expect(
      JSON.stringify([raw.symbolData?.symbolOverrides ?? [], raw.componentPropAssignments ?? []]),
    ).toContain('Overridden!');
    // Everything else re-encodes identically after the edit.
    const c = doc.canvas;
    expect(
      Buffer.compare(Buffer.from(c.compiled.encodeMessage(c.message)), Buffer.from(c.messageBytes)),
    ).toBe(0);
  });
});
