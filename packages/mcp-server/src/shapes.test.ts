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
  dir = mkdtempSync(join(tmpdir(), 'figtional-shapes-'));
  file = join(dir, 'a.fig');
  writeFileSync(file, syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (code: string) => {
  const w = new Workspace({ sources: [{ file, writable: true }] });
  const r = await runUseFigma(w, w.resolve('a'), code);
  return { ...r, json: () => JSON.parse(r.text) };
};

/** Filled (true) or empty at each point of a node's 100×100 screenshot. */
function filled(id: string, points: [number, number][]): boolean[] {
  const doc = FigDocument.fromArchive(FigArchive.open(file));
  const png = PNG.sync.read(renderPng(doc, doc.getNodeById(id)!).png);
  return points.map(([x, y]) => png.data[(y * png.width + x) * 4 + 3]! > 128);
}

describe('polygons, stars and arcs', () => {
  it('creates them with Figma defaults and draws them from their parameters', async () => {
    const r = await run(`
      const tri = figma.createPolygon();
      const star = figma.createStar();
      const half = figma.createEllipse(); half.resize(100, 100);
      half.arcData = { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 };
      const ring = figma.createEllipse(); ring.resize(100, 100);
      ring.arcData = { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5 };
      star.pointCount = 6; star.innerRadius = 0.4;
      let bad = null;
      try { tri.pointCount = 2; } catch (e) { bad = e.message; }
      return { types: [tri.type, star.type], names: [tri.name, star.name], tri: tri.id, star: star.id,
        counts: [tri.pointCount, star.pointCount, star.innerRadius], half: half.id, ring: ring.id,
        arc: half.arcData, bad };
    `);
    expect(r.ok, r.text).toBe(true);
    const o = r.json();
    expect(o.types).toEqual(['POLYGON', 'STAR']);
    expect(o.names).toEqual(['Polygon 1', 'Star 1']);
    expect(o.counts).toEqual([3, 6, 0.4]);
    expect(o.arc).toEqual({ startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 });
    expect(o.bad).toMatch(/at least 3/);
    // Triangle: filled at the top tip and along the bottom, empty in the top corners.
    expect(
      filled(o.tri, [
        [50, 3],
        [50, 95],
        [3, 95],
        [96, 95],
        [5, 5],
        [95, 5],
      ]),
    ).toEqual([true, true, true, true, false, false]);
    // Star: centre filled; between two points at the top edge empty.
    expect(
      filled(o.star, [
        [50, 50],
        [50, 2],
        [30, 8],
      ]),
    ).toEqual([true, true, false]);
    // Half circle 0..π: the bottom half (y points down).
    expect(
      filled(o.half, [
        [50, 80],
        [50, 20],
      ]),
    ).toEqual([true, false]);
    // Ring: filled band, empty centre.
    expect(
      filled(o.ring, [
        [50, 10],
        [50, 50],
      ]),
    ).toEqual([true, false]);
  });
});
