import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { FigArchive, decodeVectorNetwork } from '@figtional/fig-format';
import { FigDocument, parseSvgDocument } from '@figtional/fig-model';
import { renderPng } from '@figtional/fig-render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { Workspace, runUseFigma } from './index.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-vectors-'));
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

const ICON = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none">
  <!-- a red square, a blue stroked circle, and a moved rounded rect -->
  <path id="Square" d="M2 2h8v8H2z" fill="#ff0000"/>
  <circle cx="17" cy="6" r="4" stroke="rgb(0, 0, 255)" stroke-width="2"/>
  <g transform="translate(2 14)" opacity="0.5">
    <rect width="8" height="8" rx="2" style="fill: green"/>
  </g>
  <defs><linearGradient id="unused"/></defs>
</svg>`;

describe('parseSvgDocument', () => {
  it('applies the viewBox, transforms and inherited styles', () => {
    const doc = parseSvgDocument(ICON);
    expect([doc.width, doc.height]).toEqual([48, 48]);
    expect(doc.shapes.map((s) => s.name)).toEqual(['Square', 'Ellipse', 'Rectangle']);
    const [square, circle, rect] = doc.shapes;
    expect(square!.paths[0]!.start).toEqual({ x: 4, y: 4 }); // scaled ×2 by the viewBox
    expect(square!.fill).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(circle!.fill).toBeNull(); // fill="none" inherited from <svg>
    expect(circle!.stroke).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(circle!.strokeWidth).toBe(4);
    expect(rect!.opacity).toBe(0.5);
    expect(rect!.fill!.g).toBeCloseTo(128 / 255);
  });

  it('refuses what it cannot draw faithfully', () => {
    expect(() => parseSvgDocument('<svg><text>Hi</text></svg>')).toThrow(/SVG <text>/);
    expect(() => parseSvgDocument('<svg><rect width="1" height="1" fill="url(#g)"/></svg>')).toThrow(
      /gradients/,
    );
    expect(() => parseSvgDocument('<div/>')).toThrow(/no <svg> element/);
  });
});

describe('createNodeFromSvg', () => {
  it('creates a frame of vectors that renders like the SVG', async () => {
    const r = await run(`
      const frame = figma.createNodeFromSvg(${JSON.stringify(ICON)});
      return { id: frame.id, type: frame.type, size: [frame.width, frame.height], fills: frame.fills.length,
        kids: frame.children.map(c => ({ type: c.type, name: c.name, x: c.x, y: c.y, w: c.width, h: c.height,
          fills: c.fills.length, strokes: c.strokes.length, sw: c.strokeWeight, op: c.opacity })) };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.type).toBe('FRAME');
    expect(o.size).toEqual([48, 48]);
    expect(o.fills).toBe(0);
    expect(o.kids.map((k: any) => [k.type, k.name])).toEqual([
      ['VECTOR', 'Square'],
      ['VECTOR', 'Ellipse'],
      ['VECTOR', 'Rectangle'],
    ]);
    const [sq, ci, re] = o.kids;
    expect([sq.x, sq.y, sq.w, sq.h]).toEqual([4, 4, 16, 16]);
    expect([ci.x, ci.y, ci.w, ci.h].map((v: number) => Math.round(v * 1000) / 1000)).toEqual([26, 4, 16, 16]);
    expect([ci.fills, ci.strokes, ci.sw]).toEqual([0, 1, 4]);
    expect([re.x, re.y, re.op]).toEqual([4, 28, 0.5]);

    // Saved with a vector network, and drawn from it.
    const doc = reload();
    const frame = doc.getNodeById(o.id)!;
    const square = frame.children[0]!;
    const net = decodeVectorNetwork(doc.blobs[square.data.vectorData.vectorNetworkBlob]!.bytes);
    expect(net.regions).toHaveLength(1);
    expect(net.vertices.map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [16, 0],
      [16, 16],
      [0, 16],
    ]);
    const png = PNG.sync.read(renderPng(doc, frame).png);
    const px = (x: number, y: number) => [
      ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3),
    ];
    expect(px(12, 12)).toEqual([255, 0, 0]); // inside the square
    expect(px(34, 4 + 1)).toEqual([0, 0, 255]); // on the circle's stroke (top)
    expect(png.data[(12 * png.width + 34) * 4 + 3]).toBe(0); // inside the circle: no fill (transparent)
  });

  it('reports unsupported SVG features as Figtional limitations', async () => {
    const r = await run(`figma.createNodeFromSvg('<svg><image href="a.png"/></svg>')`);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^NotSupportedInFigtional: createNodeFromSvg with SVG <image>/);
  });
});

describe('vectors', () => {
  it('sets and reads vectorPaths and vectorNetwork', async () => {
    const r = await run(`
      const v = figma.createVector();
      v.x = 100; v.y = 50;
      v.vectorPaths = [{ windingRule: 'EVENODD', data: 'M 0 0 L 20 0 L 20 10 Z' }];
      const paths = v.vectorPaths;
      const net = v.vectorNetwork;
      await v.setVectorNetworkAsync({
        vertices: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }],
        segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
        regions: [],
      });
      let setter = null;
      try { v.vectorNetwork = net; } catch (e) { setter = e.message; }
      return { paths, net, size: [v.width, v.height], pos: [v.x, v.y], after: v.vectorPaths, setter, id: v.id };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.paths).toEqual([{ windingRule: 'EVENODD', data: 'M 0 0 L 20 0 L 20 10 L 0 0 Z' }]);
    expect(o.net.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
    expect(o.net.regions).toEqual([{ windingRule: 'EVENODD', loops: [[0, 1, 2]] }]);
    expect(o.size).toEqual([30, 30]);
    expect(o.pos).toEqual([100, 50]);
    expect(o.after).toEqual([{ windingRule: 'NONE', data: 'M 0 0 L 30 0 L 30 30' }]);
    expect(o.setter).toMatch(/setVectorNetworkAsync/);
  });
});
