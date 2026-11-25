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
  if (n.type === 'ELLIPSE') return [{ paths: parsePathData(ellipsePathData(w, h)), rule: 'NONZERO' }];
  if (
    [
      'ROUNDED_RECTANGLE',
      'RECTANGLE',
      'FRAME',
      'SYMBOL',
      'INSTANCE',
      'REGULAR_POLYGON',
      'STAR',
      'LINE',
    ].includes(n.type ?? '')
  )
    return [{ paths: parsePathData(rectPathData(n, w, h)), rule: 'NONZERO' }];
  return [];
}
