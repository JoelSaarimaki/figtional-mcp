/**
 * Parses an SVG document into shapes for `figma.createNodeFromSvg`: every path, rect, circle,
 * ellipse, line, polyline and polygon becomes subpaths in the frame's coordinates (viewBox and
 * transforms applied; groups flattened), with solid fills and strokes. Gradients, text, images,
 * <use> and similar raise SvgUnsupported, so nothing is silently drawn wrong.
 */
import type { Matrix } from '@figtional/fig-format';
import { type Subpath, parsePathData, transformSubpaths } from './vector-path.js';

export class SvgUnsupported extends Error {}

export interface SvgColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SvgShape {
  name: string;
  /** In the frame's coordinates. */
  paths: Subpath[];
  fill: SvgColor | null;
  fillRule: 'NONZERO' | 'ODD';
  stroke: SvgColor | null;
  /** Stroke width in frame units (scaled by the element's transform). */
  strokeWidth: number;
  strokeCap: 'NONE' | 'ROUND' | 'SQUARE';
  strokeJoin: 'MITER' | 'ROUND' | 'BEVEL';
  opacity: number;
}

export interface SvgDocument {
  width: number;
  height: number;
  shapes: SvgShape[];
}

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENTITIES[e] ?? m),
  );

/** A small XML parser: elements and attributes; text, comments, CDATA and declarations are skipped. */
function parseXml(src: string): El {
  const root: El = { name: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
    const el: El = { name: m[2].replace(/^svg:/, ''), attrs, children: [] };
    stack[stack.length - 1]!.children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  lime: '#00ff00',
  navy: '#000080',
  teal: '#008080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  aqua: '#00ffff',
  fuchsia: '#ff00ff',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
};

function parseColor(v: string): SvgColor | null {
  const s = v.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  if (s === 'currentcolor') return { r: 0, g: 0, b: 0, a: 1 };
  if (s.startsWith('url(')) throw new SvgUnsupported('SVG gradients and patterns (url(#…) paints)');
  const hex = NAMED[s] ?? s;
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(hex);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean);
    const c = (x: string) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / 255);
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return { r: c(p[0]!), g: c(p[1]!), b: c(p[2]!), a };
  }
  throw new SvgUnsupported(`the SVG colour "${v}"`);
}

const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const mul = (a: Matrix, b: Matrix): Matrix => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

function parseTransform(v: string | undefined): Matrix {
  let m = IDENTITY;
  if (!v) return m;
  for (const t of v.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = t[2]!
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const deg = (x: number) => (x * Math.PI) / 180;
    let n: Matrix;
    switch (t[1]) {
      case 'matrix':
        n = { m00: a[0]!, m10: a[1]!, m01: a[2]!, m11: a[3]!, m02: a[4]!, m12: a[5]! };
        break;
      case 'translate':
        n = { ...IDENTITY, m02: a[0] ?? 0, m12: a[1] ?? 0 };
        break;
      case 'scale':
        n = { ...IDENTITY, m00: a[0] ?? 1, m11: a[1] ?? a[0] ?? 1 };
        break;
      case 'rotate': {
        const r = deg(a[0] ?? 0);
        const rot = {
          m00: Math.cos(r),
          m01: -Math.sin(r),
          m02: 0,
          m10: Math.sin(r),
          m11: Math.cos(r),
          m12: 0,
        };
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        n = mul(mul({ ...IDENTITY, m02: cx, m12: cy }, rot), { ...IDENTITY, m02: -cx, m12: -cy });
        break;
      }
      case 'skewX':
        n = { ...IDENTITY, m01: Math.tan(deg(a[0] ?? 0)) };
        break;
      case 'skewY':
        n = { ...IDENTITY, m10: Math.tan(deg(a[0] ?? 0)) };
        break;
      default:
        throw new SvgUnsupported(`the SVG transform "${t[1]}"`);
    }
    m = mul(m, n);
  }
  return m;
}

const num = (v: string | undefined, d = 0) => {
  if (v === undefined || v === '') return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

/** Presentation attributes plus inline style declarations. */
function props(el: El): Record<string, string> {
  const out: Record<string, string> = { ...el.attrs };
  for (const decl of (el.attrs.style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

const SKIPPED = new Set([
  'defs',
  'symbol',
  'title',
  'desc',
  'metadata',
  'style',
  'linearGradient',
  'radialGradient',
  'pattern',
  'filter',
  'marker',
  'script',
]);
const UNSUPPORTED: Record<string, string> = {
  text: 'SVG <text>',
  tspan: 'SVG <text>',
  image: 'SVG <image>',
  use: 'SVG <use>',
  foreignObject: 'SVG <foreignObject>',
  clipPath: 'SVG clip paths',
  mask: 'SVG masks',
};

function shapePath(el: El, p: Record<string, string>): string | undefined {
  switch (el.name) {
    case 'path':
      return p.d;
    case 'rect': {
      const x = num(p.x);
      const y = num(p.y);
      const w = num(p.width);
      const h = num(p.height);
      if (w <= 0 || h <= 0) return undefined;
      let rx = p.rx !== undefined ? num(p.rx) : p.ry !== undefined ? num(p.ry) : 0;
      let ry = p.ry !== undefined ? num(p.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case 'circle':
    case 'ellipse': {
      const cx = num(p.cx);
      const cy = num(p.cy);
      const rx = el.name === 'circle' ? num(p.r) : num(p.rx);
      const ry = el.name === 'circle' ? num(p.r) : num(p.ry);
      if (rx <= 0 || ry <= 0) return undefined;
      return `M${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}Z`;
    }
    case 'line':
      return `M${num(p.x1)} ${num(p.y1)}L${num(p.x2)} ${num(p.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = (p.points ?? '')
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (pts.length < 4) return undefined;
      const d =
        `M${pts[0]} ${pts[1]}` + pts.slice(2).reduce((s, v, i) => s + (i % 2 ? ` ${v}` : `L${v}`), '');
      return el.name === 'polygon' ? d + 'Z' : d;
    }
    default:
      return undefined;
  }
}

const NAMES: Record<string, string> = {
  rect: 'Rectangle',
  circle: 'Ellipse',
  ellipse: 'Ellipse',
  line: 'Line',
  polyline: 'Vector',
  polygon: 'Polygon',
  path: 'Vector',
};

export function parseSvgDocument(svg: string): SvgDocument {
  const root = parseXml(String(svg)).children.find((c) => c.name === 'svg');
  if (!root) throw new Error('Failed to parse SVG: no <svg> element');
  const a = root.attrs;
  const vb = (a.viewBox ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const hasVb = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0;
  const width = a.width && !a.width.endsWith('%') ? num(a.width) : hasVb ? vb[2]! : 100;
  const height = a.height && !a.height.endsWith('%') ? num(a.height) : hasVb ? vb[3]! : 100;
  let base = IDENTITY;
  if (hasVb) {
    // preserveAspectRatio="xMidYMid meet" (the default): uniform scale, centred.
    const s = Math.min(width / vb[2]!, height / vb[3]!);
    const none = (a.preserveAspectRatio ?? '').trim() === 'none';
    const sx = none ? width / vb[2]! : s;
    const sy = none ? height / vb[3]! : s;
    base = {
      m00: sx,
      m01: 0,
      m02: (width - vb[2]! * sx) / 2 - vb[0]! * sx,
      m10: 0,
      m11: sy,
      m12: (height - vb[3]! * sy) / 2 - vb[1]! * sy,
    };
  }
  const shapes: SvgShape[] = [];
  const INHERITED = [
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-opacity',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'color',
  ];
  const walk = (el: El, m: Matrix, inherited: Record<string, string>, opacity: number) => {
    for (const c of el.children) {
      if (SKIPPED.has(c.name)) continue;
      if (UNSUPPORTED[c.name]) throw new SvgUnsupported(UNSUPPORTED[c.name]!);
      const p = props(c);
      if (p.display === 'none' || p.visibility === 'hidden') continue;
      if (p['clip-path'] || p.mask || p.filter) throw new SvgUnsupported('SVG clip paths, masks and filters');
      const style: Record<string, string> = { ...inherited };
      for (const k of INHERITED) if (p[k] !== undefined && p[k] !== 'inherit') style[k] = p[k]!;
      const mat = mul(m, parseTransform(p.transform));
      const op = opacity * num(p.opacity, 1);
      if (c.name === 'g' || c.name === 'svg' || c.name === 'a' || c.name === 'switch') {
        const inner = c.name === 'svg' ? mul(mat, { ...IDENTITY, m02: num(p.x), m12: num(p.y) }) : mat;
        walk(c, inner, style, op);
        continue;
      }
      const d = shapePath(c, p);
      if (!d) continue;
      const paths = transformSubpaths(parsePathData(d), mat);
      if (!paths.length) continue;
      const fillColor = parseColor(style.fill ?? 'black');
      const strokeColor = style.stroke ? parseColor(style.stroke) : null;
      const fill =
        fillColor && c.name !== 'line'
          ? { ...fillColor, a: fillColor.a * num(style['fill-opacity'], 1) }
          : null;
      const stroke = strokeColor
        ? { ...strokeColor, a: strokeColor.a * num(style['stroke-opacity'], 1) }
        : null;
      const scale = Math.sqrt(Math.abs(mat.m00 * mat.m11 - mat.m01 * mat.m10)) || 1;
      shapes.push({
        name: c.attrs.id ?? NAMES[c.name] ?? 'Vector',
        paths,
        fill,
        fillRule: style['fill-rule'] === 'evenodd' ? 'ODD' : 'NONZERO',
        stroke,
        strokeWidth: num(style['stroke-width'], 1) * scale,
        strokeCap:
          ({ round: 'ROUND', square: 'SQUARE' } as const)[style['stroke-linecap'] as 'round'] ?? 'NONE',
        strokeJoin:
          ({ round: 'ROUND', bevel: 'BEVEL' } as const)[style['stroke-linejoin'] as 'round'] ?? 'MITER',
        opacity: op,
      });
    }
  };
  const rootProps = props(root);
  const rootStyle: Record<string, string> = {};
  for (const k of INHERITED) if (rootProps[k] !== undefined) rootStyle[k] = rootProps[k]!;
  walk(root, base, rootStyle, num(rootProps.opacity, 1));
  return { width, height, shapes };
}
