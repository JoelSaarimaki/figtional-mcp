/**
 * The outline of a node's own shape as subpaths in its local coordinates: Figma's stored
 * `fillGeometry` when present, else the vector network, else the rectangle/ellipse shape. Used to
 * draw boolean operations Figtional created (no stored geometry) and to flatten layers.
 */
import {
  type NodeChange,
  decodePathCommands,
  decodeVectorNetwork,
  guidToString,
  pathCommandsToSvg,
} from '@figtional/fig-format';
import type { FigDocument } from './document.js';
import { type Subpath, networkToPathData, parsePathData, transformSubpaths } from './vector-path.js';

export interface Outline {
  paths: Subpath[];
  rule: 'NONZERO' | 'ODD';
}

const f = (n: number) => String(Math.round(n * 1000) / 1000);

/** SVG path data of subpaths (absolute M/C/Z). */
export function subpathsToPathData(paths: Subpath[]): string {
  return paths
    .map(
      (s) =>
        `M${f(s.start.x)} ${f(s.start.y)}` +
        s.segs
          .map((c) => `C${f(c.c1.x)} ${f(c.c1.y)} ${f(c.c2.x)} ${f(c.c2.y)} ${f(c.to.x)} ${f(c.to.y)}`)
          .join('') +
        (s.closed ? 'Z' : ''),
    )
    .join('');
}

function rectPathData(n: NodeChange, w: number, h: number): string {
  const r = n.cornerRadius ?? 0;
  const ind = n.rectangleCornerRadiiIndependent;
  const c = (v: number | undefined) => Math.min(ind ? (v ?? r) : r, w / 2, h / 2);
  const tl = c(n.rectangleTopLeftCornerRadius);
  const tr = c(n.rectangleTopRightCornerRadius);
  const br = c(n.rectangleBottomRightCornerRadius);
  const bl = c(n.rectangleBottomLeftCornerRadius);
  if (!tl && !tr && !br && !bl) return `M0 0H${w}V${h}H0Z`;
  return (
    `M${tl} 0H${w - tr}A${tr} ${tr} 0 0 1 ${w} ${tr}V${h - br}A${br} ${br} 0 0 1 ${w - br} ${h}` +
    `H${bl}A${bl} ${bl} 0 0 1 0 ${h - bl}V${tl}A${tl} ${tl} 0 0 1 ${tl} 0Z`
  );
}

function ellipsePathData(w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  return `M0 ${ry}A${rx} ${ry} 0 1 0 ${w} ${ry}A${rx} ${ry} 0 1 0 0 ${ry}Z`;
}

/**
 * A regular polygon (or a star with `inner` > 0) with `count` points, starting at the top and
 * stretched to fill the w×h box, as Figma draws them.
 */
export function polygonPathData(w: number, h: number, count: number, inner?: number): string {
  const n = Math.max(3, Math.round(count));
  const pts: [number, number][] = [];
  const steps = inner === undefined ? n : n * 2;
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps;
    const r = inner !== undefined && i % 2 === 1 ? inner : 1;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = w / (x1 - x0 || 1);
  const sy = h / (y1 - y0 || 1);
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x - x0) * sx} ${(y - y0) * sy}`).join('') + 'Z';
}

/** An ellipse limited by `arcData` (angles in radians, clockwise from the x axis; innerRadius 0–1). */
export function arcPathData(
  w: number,
  h: number,
  arc: { startingAngle?: number; endingAngle?: number; innerRadius?: number },
): { d: string; rule: 'NONZERO' | 'ODD' } {
  const rx = w / 2;
  const ry = h / 2;
  const a0 = arc.startingAngle ?? 0;
  let a1 = arc.endingAngle ?? 2 * Math.PI;
  const inner = Math.max(0, Math.min(1, arc.innerRadius ?? 0));
  const sweep = Math.min(2 * Math.PI, Math.abs(a1 - a0));
  const pt = (a: number, k: number) => `${rx + rx * k * Math.cos(a)} ${ry + ry * k * Math.sin(a)}`;
  if (sweep >= 2 * Math.PI - 1e-6) {
    const outer = `M0 ${ry}A${rx} ${ry} 0 1 0 ${w} ${ry}A${rx} ${ry} 0 1 0 0 ${ry}Z`;
    if (!inner) return { d: outer, rule: 'NONZERO' };
    const ix = rx * inner;
    const iy = ry * inner;
    const innerD = `M${rx - ix} ${ry}A${ix} ${iy} 0 1 0 ${rx + ix} ${ry}A${ix} ${iy} 0 1 0 ${rx - ix} ${ry}Z`;
    return { d: outer + innerD, rule: 'ODD' };
  }
  a1 = a0 + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  let d = `M${pt(a0, 1)}A${rx} ${ry} 0 ${large} 1 ${pt(a1, 1)}`;
  d += inner
    ? `L${pt(a1, inner)}A${rx * inner} ${ry * inner} 0 ${large} 0 ${pt(a0, inner)}Z`
    : `L${rx} ${ry}Z`;
  return { d, rule: 'NONZERO' };
}

export function outlineOf(doc: FigDocument, n: NodeChange): Outline[] {
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const stored = (n.fillGeometry ?? [])
    .map((g: any): Outline | undefined => {
      const blob = g.commandsBlob !== undefined ? doc.blobs[g.commandsBlob] : undefined;
      if (!blob) return undefined;
      return {
        paths: parsePathData(pathCommandsToSvg(decodePathCommands(blob.bytes))),
        rule: g.windingRule === 'ODD' ? 'ODD' : 'NONZERO',
      };
    })
    .filter((o: Outline | undefined): o is Outline => !!o && o.paths.length > 0);
  if (stored.length) return stored;
  if (n.type === 'VECTOR' && n.vectorData?.vectorNetworkBlob !== undefined) {
    const blob = doc.blobs[n.vectorData.vectorNetworkBlob];
    if (!blob) return [];
    const net = decodeVectorNetwork(blob.bytes);
    const ns = n.vectorData.normalizedSize;
    const sx = ns?.x ? w / ns.x : 1;
    const sy = ns?.y ? h / ns.y : 1;
    if (net.regions.length)
      return net.regions.map((r) => ({
        paths: parsePathData(networkToPathData({ ...net, regions: [r] }, sx, sy, true)),
        rule: r.windingRule,
      }));
    const d = networkToPathData(net, sx, sy);
    return d ? [{ paths: parsePathData(d), rule: 'NONZERO' }] : [];
  }
  if (n.type === 'BOOLEAN_OPERATION') {
    const out: Outline[] = [];
    for (const c of doc.rawChildren(guidToString(n.guid))) {
      if (c.visible === false || !c.transform) continue;
      for (const o of outlineOf(doc, c)) out.push({ ...o, paths: transformSubpaths(o.paths, c.transform) });
    }
    return out;
  }
  if (w <= 0 || h <= 0) return [];
  if (n.type === 'ELLIPSE') {
    if (n.arcData) {
      const a = arcPathData(w, h, n.arcData);
      return [{ paths: parsePathData(a.d), rule: a.rule }];
    }
    return [{ paths: parsePathData(ellipsePathData(w, h)), rule: 'NONZERO' }];
  }
  if (n.type === 'REGULAR_POLYGON')
    return [{ paths: parsePathData(polygonPathData(w, h, n.count ?? 3)), rule: 'NONZERO' }];
  if (n.type === 'STAR')
    return [
      {
        paths: parsePathData(polygonPathData(w, h, n.count ?? 5, n.starInnerScale ?? 0.382)),
        rule: 'NONZERO',
      },
    ];
  if (['ROUNDED_RECTANGLE', 'RECTANGLE', 'FRAME', 'SYMBOL', 'INSTANCE', 'LINE'].includes(n.type ?? ''))
    return [{ paths: parsePathData(rectPathData(n, w, h)), rule: 'NONZERO' }];
  return [];
}
