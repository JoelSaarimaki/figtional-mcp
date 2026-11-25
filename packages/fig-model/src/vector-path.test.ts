import { FigArchive, decodeVectorNetwork, encodeVectorNetwork } from '@figtional/fig-format';
import { describe, expect, it } from 'vitest';
import { REF, hasRef } from '../../../test/references.js';
import {
  networkToPathData,
  parsePathData,
  subpathBounds,
  subpathsToNetwork,
  transformSubpaths,
} from './vector-path.js';

describe('parsePathData', () => {
  it('handles absolute and relative lines, H/V and implicit repeats', () => {
    const [a] = parsePathData('M10 10 h20 v20 H10 Z');
    expect(a!.closed).toBe(true);
    expect(a!.segs.map((s) => [s.to.x, s.to.y])).toEqual([
      [30, 10],
      [30, 30],
      [10, 30],
      [10, 10],
    ]);
    const [b] = parsePathData('m0 0 10 0 0 10');
    expect(b!.segs.map((s) => [s.to.x, s.to.y])).toEqual([
      [10, 0],
      [10, 10],
    ]);
    expect(parsePathData('M0,0L5-5')[0]!.segs[0]!.to).toEqual({ x: 5, y: -5 });
  });

  it('converts quadratics, smooth curves and arcs to cubics', () => {
    const [q] = parsePathData('M0 0 Q 10 10 20 0 T 40 0');
    expect(q!.segs).toHaveLength(2);
    expect(q!.segs[0]!.c1.x).toBeCloseTo(20 / 3, 9);
    expect(q!.segs[0]!.c1.y).toBeCloseTo(20 / 3, 9);
    // A full circle of radius 10 from two arcs: bounds are exactly 20×20.
    const circle = parsePathData('M0 10 A10 10 0 0 1 20 10 A10 10 0 0 1 0 10 Z');
    const b = subpathBounds(circle);
    expect(b.width).toBeCloseTo(20, 4);
    expect(b.height).toBeCloseTo(20, 4);
    expect(b.y).toBeCloseTo(0, 4);
  });

  it('rejects invalid data', () => {
    expect(() => parsePathData('10 10')).toThrow(/must start with a command/);
    expect(() => parsePathData('M0 0 X 1')).toThrow(/Invalid path/);
  });
});

describe('vector networks', () => {
  it('builds vertices, relative handles and a region for closed paths', () => {
    const net = subpathsToNetwork(parsePathData('M0 0 L10 0 C10 5 5 10 0 10 Z'), 'NONZERO');
    expect(net.vertices).toHaveLength(3); // the closing segment returns to vertex 0
    expect(net.segments[1]).toMatchObject({
      start: 1,
      end: 2,
      tangentStart: { x: 0, y: 5 },
      tangentEnd: { x: 5, y: 0 },
    });
    expect(net.segments[2]!.end).toBe(0);
    expect(net.regions).toEqual([{ styleID: 0, windingRule: 'NONZERO', loops: [[0, 1, 2]] }]);
    // Encodes and decodes losslessly.
    expect(decodeVectorNetwork(encodeVectorNetwork(net))).toEqual(net);
    expect(networkToPathData(net, 1, 1, true)).toBe('M0 0L10 0C10 5 5 10 0 10L0 0Z');
    // Open paths carry no region.
    expect(subpathsToNetwork(parsePathData('M0 0 L10 10'), 'NONZERO').regions).toEqual([]);
  });

  it('applies transforms', () => {
    const moved = transformSubpaths(parsePathData('M0 0 L10 0'), {
      m00: 2,
      m01: 0,
      m02: 5,
      m10: 0,
      m11: 2,
      m12: 1,
    });
    expect(moved[0]!.start).toEqual({ x: 5, y: 1 });
    expect(moved[0]!.segs[0]!.to).toEqual({ x: 25, y: 1 });
  });

  it.skipIf(!hasRef('responsive'))("matches Figma's network for a circle drawn with cubics", () => {
    const c = FigArchive.open(REF.responsive).decodeCanvas();
    const node = c.message.nodeChanges.find((n: any) => n.guid.sessionID === 2 && n.guid.localID === 34)!;
    const figma = decodeVectorNetwork(c.message.blobs[node.vectorData.vectorNetworkBlob].bytes);
    // Rebuild it from its own outline: four quarter circles starting at the right.
    const k = 3.313708543777466;
    const d = `M12 6 C12 ${6 + k} ${6 + k} 12 6 12 C${6 - k} 12 0 ${6 + k} 0 6 C0 ${6 - k} ${6 - k} 0 6 0 C${6 + k} 0 12 ${6 - k} 12 6 Z`;
    const ours = subpathsToNetwork(parsePathData(d), null);
    expect(ours.vertices.map((v) => [v.x, v.y])).toEqual(figma.vertices.map((v) => [v.x, v.y]));
    ours.segments.forEach((s, i) => {
      const f = figma.segments[i]!;
      expect([s.start, s.end]).toEqual([f.start, f.end]);
      expect(s.tangentStart.x).toBeCloseTo(f.tangentStart.x, 4);
      expect(s.tangentStart.y).toBeCloseTo(f.tangentStart.y, 4);
      expect(s.tangentEnd.x).toBeCloseTo(f.tangentEnd.x, 4);
      expect(s.tangentEnd.y).toBeCloseTo(f.tangentEnd.y, 4);
    });
  });
});
