import { FigArchive, guidToString } from '@figtional/fig-format';
import { describe, expect, it } from 'vitest';
import { REF, hasRef } from '../../../test/references.js';
import { syntheticFig } from '../../../test/synthetic.js';
import { FigDocument, keyBetween, normalizeNodeId, spreadKeys, variableDefs } from './index.js';

const synthetic = () => FigDocument.fromArchive(FigArchive.fromBytes(syntheticFig()));

describe('FigDocument (synthetic)', () => {
  it('lists user pages without the internal page', () => {
    const doc = synthetic();
    expect(doc.allPages.map((p) => p.name)).toEqual(['Page 1', 'Internal Only Canvas']);
    expect(doc.pages.map((p) => p.name)).toEqual(['Page 1']);
    expect(doc.pages[0]!.type).toBe('PAGE');
  });

  it('orders children by fractional position', () => {
    const doc = synthetic();
    const screen = doc.getNodeById('1:2')!;
    expect(screen.children.map((c) => c.name)).toEqual(['Photo', 'Title']);
    expect(screen.children.map((c) => c.type)).toEqual(['RECTANGLE', 'TEXT']);
  });

  it('resolves ids in both forms and links parents', () => {
    const doc = synthetic();
    const title = doc.getNodeById('1-4')!;
    expect(title.id).toBe('1:4');
    expect(title.parent?.id).toBe('1:2');
    expect(title.page?.name).toBe('Page 1');
    expect(title.absoluteBoundingBox).toEqual({ x: 20, y: 100, width: 200, height: 30 });
    expect(doc.getNodeById('9:9')).toBeUndefined();
    expect(doc.getNodeById('nonsense')).toBeUndefined();
  });

  it('normalizes node ids', () => {
    expect(normalizeNodeId('12-34')).toBe('12:34');
    expect(normalizeNodeId('I1-2;3-4')).toBe('I1:2;3:4');
    expect(normalizeNodeId('1:2:3')).toBeUndefined();
  });
});

describe('fractional index', () => {
  it('generates keys between neighbours', () => {
    const pairs: [string | undefined, string | undefined][] = [
      [undefined, undefined],
      ['!', undefined],
      [undefined, '~'],
      ['!', '"'],
      ['!~', '"'],
      ['a', 'b'],
      ['!', '!P'],
      [undefined, '!P'],
    ];
    for (const [a, b] of pairs) {
      const k = keyBetween(a, b)!;
      expect(k, `${a}..${b}`).toBeDefined();
      if (a !== undefined) expect(k > a, `${k} > ${a}`).toBe(true);
      if (b !== undefined) expect(k < b, `${k} < ${b}`).toBe(true);
    }
  });

  it('reports when no key fits before the minimum', () => {
    expect(keyBetween(undefined, '!')).toBeUndefined();
  });

  it('spreads keys in increasing order', () => {
    for (const n of [1, 5, 93, 94, 500]) {
      const keys = spreadKeys(n);
      expect(keys).toHaveLength(n);
      for (let i = 1; i < n; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
    }
  });
});

describe('reference documents', () => {
  it.skipIf(!hasRef('responsive'))('Responsive example: pages and top-level frames', () => {
    const doc = FigDocument.fromArchive(FigArchive.open(REF.responsive));
    expect(doc.pages.map((p) => p.name)).toEqual(['Page 1']);
    expect(doc.pages[0]!.children.map((c) => `${c.id} ${c.name}`)).toEqual([
      '2:2 Explore · Mobile',
      '2:7 Auto layout · Mobile',
      '2:12 Collaborate · Mobile',
      '2:17 Explore · Tablet',
    ]);
  });

  it.skipIf(!hasRef('ttrpg'))('TTRPG: instances expand with overrides, derived sizes and text props', () => {
    const doc = FigDocument.fromArchive(FigArchive.open(REF.ttrpg));
    const instances = [...doc.nodes.values()].filter((n) => n.type === 'INSTANCE');
    expect(instances.length).toBeGreaterThan(100);

    // Every instance resolves its component, and has content.
    let expanded = 0;
    for (const raw of instances.slice(0, 300)) {
      const inst = doc.getNodeById(guidToString(raw.guid));
      if (!inst) continue; // instances nested in other instances' components are reached via those
      expect(inst.isMissingComponent).toBe(false);
      if (inst.children.length) expanded++;
      for (const c of inst.children) expect(c.id.startsWith(`I${inst.id};`)).toBe(true);
    }
    expect(expanded).toBeGreaterThan(50);

    // A text component property shows up in the expanded text.
    const withText = instances.find((n) =>
      n.componentPropAssignments?.some((a: any) => a.value?.textValue?.characters),
    )!;
    const inst = doc.getNodeById(guidToString(withText.guid))!;
    const wanted = withText.componentPropAssignments
      .map((a: any) => a.value?.textValue?.characters)
      .filter(Boolean) as string[];
    const texts = inst.findAll((n) => n.figType === 'TEXT').map((n) => n.data.textData?.characters);
    expect(texts.some((t) => wanted.includes(t))).toBe(true);

    // Sublayer ids round-trip through getNodeById.
    const deep = inst.findOne((n) => n.figType === 'TEXT')!;
    expect(doc.getNodeById(deep.id)?.id).toBe(deep.id);
  });

  it.skipIf(!hasRef('prototyping'))('Prototyping in Figma: groups and styles resolve', () => {
    const doc = FigDocument.fromArchive(FigArchive.open(REF.prototyping));
    expect(doc.getNodeById('0:835')?.type).toBe('GROUP');
    expect(doc.getNodeById('0:2')?.type).toBe('FRAME');
    expect(doc.styles.length).toBeGreaterThan(10);
    // The top-level frame containing a node that uses a fill style.
    const styled = [...doc.nodes.values()].find((n) => n.styleIdForFill)!;
    let frame = doc.getNodeById(guidToString(styled.guid))!;
    while (frame.parent && frame.parent.figType !== 'CANVAS') frame = frame.parent;
    const defs = variableDefs(doc, frame);
    expect(Object.keys(defs).length).toBeGreaterThan(0);
    for (const v of Object.values(defs)) expect(v).not.toBe('');
  });
});
