import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { renderPng } from '@figtional/fig-render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { Workspace, runUseFigma } from './index.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-bool-'));
  file = join(dir, 'a.fig');
  writeFileSync(file, syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (code: string) => {
  const w = new Workspace({ sources: [{ file, writable: true }] });
  const r = await runUseFigma(w, w.resolve('a'), code);
  return { ...r, json: () => JSON.parse(r.text) };
};

/** A 60×60 frame with a red square (0–40, bottom) and a blue one (20–60, top) combined by `op`. */
const SCENE = (op: string) => `
  const box = figma.createFrame(); box.resize(60, 60); box.fills = [];
  const a = figma.createRectangle(); a.resize(40, 40); a.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  const b = figma.createRectangle(); b.resize(40, 40); b.x = 20; b.y = 20; b.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }];
  box.appendChild(a); box.appendChild(b);
  const result = figma.${op}([a, b], box);
`;

/** Red / transparent at (x, y) of a frame's screenshot. */
function sample(file: string, id: string, points: [number, number][]): string[] {
  const doc = FigDocument.fromArchive(FigArchive.open(file));
  const png = PNG.sync.read(renderPng(doc, doc.getNodeById(id)!).png);
  return points.map(([x, y]) => {
    const i = (y * png.width + x) * 4;
    if (png.data[i + 3]! < 128) return 'none';
    return png.data[i]! > 200 && png.data[i + 2]! < 60 ? 'red' : 'other';
  });
}
// Inside only the red square, in the overlap, inside only the blue square.
const POINTS: [number, number][] = [
  [10, 10],
  [30, 30],
  [50, 50],
];

describe('boolean operations', () => {
  for (const [op, expected] of [
    ['union', ['red', 'red', 'red']],
    ['subtract', ['red', 'none', 'none']],
    ['intersect', ['none', 'red', 'none']],
    ['exclude', ['red', 'none', 'red']],
  ] as const) {
    it(`${op}: the result node is drawn like Figma's ${op.toUpperCase()}`, async () => {
      const r = await run(`${SCENE(op)}
        return { box: box.id, type: result.type, op: result.booleanOperation, name: result.name,
          fill: result.fills[0].color, kids: result.children.length, box2: [result.x, result.y, result.width, result.height] };
      `);
      expect(r.ok, r.text).toBe(true);
      const o = r.json();
      expect(o.type).toBe('BOOLEAN_OPERATION');
      expect(o.op).toBe(op.toUpperCase());
      expect(o.name).toBe(op[0]!.toUpperCase() + op.slice(1));
      expect(o.fill).toEqual({ r: 1, g: 0, b: 0 }); // the bottom-most layer's fill, as in Figma
      expect(o.kids).toBe(2);
      expect(sample(file, o.box, POINTS)).toEqual(expected);
    });
  }

  it('stores EXCLUDE as XOR, the name in the file schema', async () => {
    const r = await run(`${SCENE('exclude')} return result.id;`);
    const doc = FigDocument.fromArchive(FigArchive.open(file));
    expect(doc.getNodeById(r.json())!.data.booleanOperation).toBe('XOR');
  });

  it('flattens layers into one vector', async () => {
    const r = await run(`${SCENE('union')}
      const v = figma.flatten([result]);
      return { box: box.id, type: v.type, kids: box.children.length, size: [v.width, v.height], fill: v.fills[0].color };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o).toMatchObject({ type: 'VECTOR', kids: 1, size: [60, 60], fill: { r: 1, g: 0, b: 0 } });
    expect(sample(file, o.box, POINTS)).toEqual(['red', 'red', 'red']);
  });
});
