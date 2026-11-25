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
  dir = mkdtempSync(join(tmpdir(), 'figtional-comp-'));
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

/** A button component with a text property and a boolean property, as Figma's skills build them. */
const BUTTON = `
  const button = figma.createComponent();
  button.name = 'Button';
  button.layoutMode = 'HORIZONTAL';
  button.primaryAxisSizingMode = 'AUTO';
  button.counterAxisSizingMode = 'AUTO';
  button.itemSpacing = 8;
  const icon = figma.createRectangle();
  icon.name = 'Icon';
  icon.resize(16, 16);
  button.appendChild(icon);
  const label = figma.createText();
  label.name = 'Label';
  label.characters = 'Button';
  button.appendChild(label);
  const labelKey = button.addComponentProperty('Label', 'TEXT', 'Button');
  const iconKey = button.addComponentProperty('Show icon', 'BOOLEAN', true);
  label.componentPropertyReferences = { characters: labelKey };
  icon.componentPropertyReferences = { visible: iconKey };
`;

describe('component properties', () => {
  it('adds properties, binds layers and sets values on instances', async () => {
    const r = await run(`${BUTTON}
      const inst = button.createInstance();
      inst.x = 200;
      inst.setProperties({ [labelKey]: 'Buy now', [iconKey]: false });
      return {
        labelKey, iconKey,
        defs: button.componentPropertyDefinitions,
        refs: label.componentPropertyReferences,
        props: inst.componentProperties,
        texts: inst.findAll(n => n.type === 'TEXT').map(n => n.characters),
        iconVisible: inst.findOne(n => n.name === 'Icon').visible,
        inst: inst.id,
      };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.labelKey).toMatch(/^Label#\d+:\d+$/);
    expect(out.defs[out.labelKey]).toEqual({ type: 'TEXT', defaultValue: 'Button' });
    expect(out.defs[out.iconKey]).toEqual({ type: 'BOOLEAN', defaultValue: true });
    expect(out.refs).toEqual({ characters: out.labelKey });
    expect(out.props[out.labelKey]).toEqual({ type: 'TEXT', value: 'Buy now' });
    expect(out.props[out.iconKey]).toEqual({ type: 'BOOLEAN', value: false });
    expect(out.texts).toEqual(['Buy now']);
    expect(out.iconVisible).toBe(false);
    // Persisted in Figma's format.
    const doc = reload();
    const inst = doc.getNodeById(out.inst)!;
    expect(inst.findOne((n) => n.figType === 'TEXT')!.data.textData.characters).toBe('Buy now');
    const comp = inst.mainComponent!;
    expect(comp.data.componentPropDefs.map((d: any) => d.type)).toEqual(['TEXT', 'BOOL']);
    const label = comp.findOne((n) => n.figType === 'TEXT')!;
    expect(label.data.componentPropRefs[0].componentPropNodeField).toBe('TEXT_DATA');
    expect(label.data.parameterConsumptionMap.entries[0].variableData.dataType).toBe('PROP_REF');
  });

  it('edits and deletes properties', async () => {
    const r = await run(`${BUTTON}
      const renamed = button.editComponentProperty(labelKey, { name: 'Text', defaultValue: 'OK' });
      button.deleteComponentProperty(iconKey);
      return { defs: button.componentPropertyDefinitions, renamed, iconRefs: icon.componentPropertyReferences };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(Object.keys(out.defs)).toEqual([out.renamed]);
    expect(out.renamed).toMatch(/^Text#/);
    expect(out.defs[out.renamed].defaultValue).toBe('OK');
    expect(out.iconRefs).toEqual({});
  });
});

describe('variants', () => {
  const SET = `${BUTTON}
    button.name = 'Size=Small';
    const large = button.clone();
    large.name = 'Size=Large';
    large.x = 200;
    large.paddingLeft = 24; large.paddingRight = 24;
    const set = figma.combineAsVariants([button, large], figma.currentPage);
    set.name = 'Button';
  `;

  it('combines components into a set with variant properties', async () => {
    const r = await run(`${SET}
      return {
        type: set.type,
        children: set.children.map(c => [c.type, c.name]),
        defs: set.componentPropertyDefinitions,
        variantProps: large.variantProperties,
        defaultVariant: set.defaultVariant.name,
      };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.type).toBe('COMPONENT_SET');
    expect(out.children).toEqual([
      ['COMPONENT', 'Size=Small'],
      ['COMPONENT', 'Size=Large'],
    ]);
    expect(out.defs.Size).toEqual({
      type: 'VARIANT',
      defaultValue: 'Small',
      variantOptions: ['Small', 'Large'],
    });
    // The variants' own TEXT/BOOLEAN properties moved to the set, merged by name and type.
    expect(
      Object.values(out.defs)
        .map((d: any) => d.type)
        .sort(),
    ).toEqual(['BOOLEAN', 'TEXT', 'VARIANT']);
    expect(out.variantProps).toEqual({ Size: 'Large' });
    const doc = reload();
    const set = [...doc.nodes.values()].find((n) => n.isStateGroup)!;
    expect(set.stateGroupPropertyValueOrders).toEqual([{ property: 'Size', values: ['Small', 'Large'] }]);
    const variant = doc.rawChildren(guidToString(set.guid))[0]!;
    expect(variant.variantPropSpecs[0].value).toBe('Small');
  });

  it('switches variants with setProperties and keeps other property values', async () => {
    const r = await run(`${SET}
      const inst = button.createInstance();
      const keys = Object.keys(set.componentPropertyDefinitions);
      const labelKey2 = keys.find(k => k.startsWith('Label#'));
      inst.setProperties({ Size: 'Large', [labelKey2]: 'Big' });
      let error = null;
      try { inst.setProperties({ Size: 'Huge' }); } catch (e) { error = e.message; }
      return { main: inst.mainComponent.name, text: inst.findOne(n => n.type === 'TEXT').characters, error };
    `);
    expect(r.ok, r.text).toBe(true);
    expect(r.json()).toEqual({
      main: 'Size=Large',
      text: 'Big',
      error: 'Unable to find a variant with those property values: Size=Huge',
    });
  });

  it("keys an instance's values to its variant's definition stubs, as Figma does", async () => {
    const r = await run(`${SET}
      const keys = Object.keys(set.componentPropertyDefinitions);
      const labelKey2 = keys.find(k => k.startsWith('Label#'));
      const iconKey2 = keys.find(k => k.startsWith('Show icon#'));
      const a = button.createInstance();
      a.setProperties({ [labelKey2]: 'Buy now' });
      const b = button.createInstance();
      b.setProperties({ [labelKey2]: 'No icon', [iconKey2]: false });
      b.setProperties({ Size: 'Large' });
      return { a: a.id, b: b.id, labelKey2, iconKey2,
        bProps: b.componentProperties, bText: b.findOne(n => n.type === 'TEXT').characters,
        bIcon: b.findOne(n => n.name === 'Icon').visible };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.bProps[out.labelKey2].value).toBe('No icon');
    expect(out.bProps[out.iconKey2].value).toBe(false);
    expect(out.bText).toBe('No icon');
    expect(out.bIcon).toBe(false);
    const doc = reload();
    for (const id of [out.a, out.b]) {
      const inst = doc.getNodeById(id)!;
      const variant = inst.mainComponent!.data;
      const stubs = new Set(variant.componentPropDefs.map((d: any) => guidToString(d.id)));
      const ids = inst.data.componentPropAssignments.map((x: any) => guidToString(x.defID));
      expect(ids.length).toBeGreaterThan(0);
      for (const d of ids) expect(stubs.has(d), `${d} is a stub of ${variant.name}`).toBe(true);
    }
    // After the switch to Large, b's two values point at Large's stubs (no leftovers from Small).
    const b = doc.getNodeById(out.b)!;
    expect(b.mainComponent!.name).toBe('Size=Large');
    expect(b.data.componentPropAssignments).toHaveLength(2);
  });

  it("mirrors Figma's rules for property definitions on variants", async () => {
    const r = await run(`${SET}
      let error = null;
      try { button.addComponentProperty('X', 'TEXT', 'x'); } catch (e) { error = e.message; }
      const key = set.addComponentProperty('Caption', 'TEXT', 'Hi');
      const opt = set.addComponentProperty('State', 'VARIANT', 'Default');
      return { error, key, names: set.children.map(c => c.name), defs: Object.keys(set.componentPropertyDefinitions) };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.error).toBe(
      'Can only get/set component property definitions of a component set or non-variant component',
    );
    expect(out.names).toEqual(['Size=Small, State=Default', 'Size=Large, State=Default']);
    expect(out.defs).toContain('State');
    expect(out.defs).toContain(out.key);
  });
});

describe('instance layout after property changes', () => {
  it('re-lays out instance content and stores it in derivedSymbolData', async () => {
    const r = await run(`${BUTTON}
      const inst = button.createInstance();
      const before = inst.width;
      inst.setProperties({ [labelKey]: 'A considerably longer label' });
      return { id: inst.id, before, after: inst.width, textWidth: inst.findOne(n => n.type === 'TEXT').width };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.after).toBeGreaterThan(out.before + 50);
    const doc = reload();
    const inst = doc.getNodeById(out.id)!;
    expect(inst.width).toBeCloseTo(out.after, 3);
    const derived = inst.data.derivedSymbolData as any[];
    expect(derived.some((d) => d.size && d.transform)).toBe(true);
    const text = inst.findOne((n) => n.figType === 'TEXT')!;
    expect(text.width).toBeGreaterThan(100); // measured, not the component's "Button" width
    expect(text.data.derivedTextData).toBeUndefined(); // stale glyphs dropped
  });

  it('measures text copied before the end of the call (clone of a fresh component)', async () => {
    const r = await run(`${BUTTON}
      const copy = button.clone(); copy.x = 300; copy.paddingLeft = 24; copy.paddingRight = 24;
      const t1 = button.findOne(n => n.type === 'TEXT'), t2 = copy.findOne(n => n.type === 'TEXT');
      return { t1: [t1.width, t1.height], t2: [t2.width, t2.height], w1: button.width, w2: copy.width, pad: button.paddingLeft + button.paddingRight };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.t1[0]).toBeGreaterThan(10);
    expect(out.t2).toEqual(out.t1);
    // Same content; only the horizontal padding changed (to 24 + 24).
    expect(out.w2).toBeCloseTo(out.w1 - out.pad + 48, 3);
    // And in the saved file.
    const doc = reload();
    const texts = [...doc.nodes.values()].filter(
      (n) => n.type === 'TEXT' && n.textData?.characters === 'Button',
    );
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) expect(t.size.x).toBeGreaterThan(10);
  });

  it('fits component sets to their variants and names instances after the set', async () => {
    const r = await run(`${BUTTON}
      button.name = 'Size=Small';
      const big = button.clone(); big.name = 'Size=Large'; big.x = 300; big.paddingLeft = 40; big.paddingRight = 40;
      const set = figma.combineAsVariants([button, big], figma.currentPage);
      set.name = 'Button';
      const inst = big.createInstance();
      return { w: set.width, h: set.height, right: big.x + big.width, bottom: Math.max(button.height, big.height), name: inst.name };
    `);
    expect(r.ok, r.text).toBe(true);
    const out = r.json();
    expect(out.w).toBeCloseTo(out.right, 3);
    expect(out.h).toBeCloseTo(out.bottom, 3);
    expect(out.name).toBe('Button');
  });
});

describe('detachInstance', () => {
  it('replaces an instance with a frame that keeps the overridden content', async () => {
    const r = await run(`${BUTTON}
      const inst = button.createInstance();
      inst.setProperties({ [labelKey]: 'Detached' });
      const frame = inst.detachInstance();
      return { type: frame.type, text: frame.findOne(n => n.type === 'TEXT').characters, refs: frame.findOne(n => n.type === 'TEXT').componentPropertyReferences, removed: inst.removed };
    `);
    expect(r.ok, r.text).toBe(true);
    expect(r.json()).toEqual({ type: 'FRAME', text: 'Detached', refs: {}, removed: true });
  });
});

describe.skipIf(!hasRef('ttrpg'))('components in a real file', () => {
  it('reads and sets properties of existing library-style instances', async () => {
    const copy = join(dir, 'ttrpg.fig');
    copyFileSync(REF.ttrpg, copy);
    const w = new Workspace({ sources: [{ file: copy, writable: true }] });
    const r = await runUseFigma(
      w,
      w.resolve('ttrpg'),
      `
      const inst = figma.currentPage.findAll(n => n.type === 'INSTANCE').find(i => Object.values(i.componentProperties).some(p => p.type === 'TEXT'));
      const [key, prop] = Object.entries(inst.componentProperties).find(([, p]) => p.type === 'TEXT');
      for (const t of inst.findAll(n => n.type === 'TEXT')) for (const s of t.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(s.fontName);
      inst.setProperties({ [key]: 'Changed via setProperties' });
      return { id: inst.id, key, before: prop.value, after: inst.componentProperties[key].value, texts: inst.findAll(n => n.type === 'TEXT').map(t => t.characters) };
    `,
    );
    expect(r.ok, r.text).toBe(true);
    const out = JSON.parse(r.text);
    expect(out.after).toBe('Changed via setProperties');
    expect(out.texts).toContain('Changed via setProperties');
    const doc = FigDocument.fromArchive(FigArchive.open(copy));
    const c = doc.canvas;
    expect(
      Buffer.compare(Buffer.from(c.compiled.encodeMessage(c.message)), Buffer.from(c.messageBytes)),
    ).toBe(0);
  });
});
