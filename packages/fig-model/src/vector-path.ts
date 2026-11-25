/**
 * SVG path data ↔ Figma vector networks (docs/fig-format.md §5): parses path data (every command,
 * absolute and relative, arcs included) into cubic subpaths, measures them, and builds the vector
 * network Figma stores in `vectorData.vectorNetworkBlob`: vertices, segments whose curve handles
 * are stored relative to their own vertex (`tangentStart`/`tangentEnd`, verified), and one region
 * per fill whose loops list the segments of each closed subpath.
 */
import type { Matrix, VectorNetwork } from '@figtional/fig-format';

export interface Pt {
  x: number;
  y: number;
}
/** A cubic segment from the previous point: two control points and the end point. */
export interface Cubic {
  c1: Pt;
  c2: Pt;
  to: Pt;
}
export interface Subpath {
  start: Pt;
  segs: Cubic[];
  closed: boolean;
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Parses SVG path data into subpaths of cubic segments (lines are cubics with handles on the ends). */
export function parsePathData(d: string): Subpath[] {
  const out: Subpath[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const num = (): number => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new Error(`Invalid path data near "${d.slice(i, i + 12)}"`);
    i = NUM.lastIndex;
    return Number(m[0]);
  };
  const flag = (): number => {
    skip();
    const c = d[i];
    if (c !== '0' && c !== '1') throw new Error(`Invalid arc flag in path data near "${d.slice(i, i + 12)}"`);
    i++;
    return c === '1' ? 1 : 0;
  };
  const hasNum = () => {
    skip();
    return i < d.length && /[-+.\d]/.test(d[i]!);
  };
  let cur: Pt = { x: 0, y: 0 };
  let sub: Subpath | undefined;
  let lastCtrl: Pt | undefined; // reflected for S / T
  let lastCmd = '';
  const line = (to: Pt) => {
    sub!.segs.push({ c1: { ...cur }, c2: { ...to }, to });
    cur = to;
  };
  const ensureSub = () => {
    if (!sub) {
      sub = { start: { ...cur }, segs: [], closed: false };
      out.push(sub);
    }
  };
  while (true) {
    skip();
    if (i >= d.length) break;
    let cmd = d[i]!;
    if (/[a-zA-Z]/.test(cmd)) i++;
    else if (lastCmd) cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
    else throw new Error(`Invalid path data: must start with a command, got "${d.slice(0, 12)}"`);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cur.x : 0;
    const oy = rel ? cur.y : 0;
    switch (C) {
      case 'M': {
        cur = { x: num() + ox, y: num() + oy };
        sub = { start: { ...cur }, segs: [], closed: false };
        out.push(sub);
        lastCtrl = undefined;
        break;
      }
      case 'L':
        ensureSub();
        line({ x: num() + ox, y: num() + oy });
        lastCtrl = undefined;
        break;
      case 'H':
        ensureSub();
        line({ x: num() + ox, y: cur.y });
        lastCtrl = undefined;
        break;
      case 'V':
        ensureSub();
        line({ x: cur.x, y: num() + oy });
        lastCtrl = undefined;
        break;
      case 'C': {
        ensureSub();
        const c1 = { x: num() + ox, y: num() + oy };
        const c2 = { x: num() + ox, y: num() + oy };
        const to = { x: num() + ox, y: num() + oy };
        sub!.segs.push({ c1, c2, to });
        cur = to;
        lastCtrl = c2;
        break;
      }
      case 'S': {
        ensureSub();
        const c1 =
          lastCtrl && /[CS]/i.test(lastCmd)
            ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y }
            : { ...cur };
        const c2 = { x: num() + ox, y: num() + oy };
        const to = { x: num() + ox, y: num() + oy };
        sub!.segs.push({ c1, c2, to });
        cur = to;
        lastCtrl = c2;
        break;
      }
      case 'Q':
      case 'T': {
        ensureSub();
        const q =
          C === 'Q'
            ? { x: num() + ox, y: num() + oy }
            : lastCtrl && /[QT]/i.test(lastCmd)
              ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y }
              : { ...cur };
        const to = { x: num() + ox, y: num() + oy };
        sub!.segs.push({
          c1: { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) },
          c2: { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
          to,
        });
        cur = to;
        lastCtrl = q;
        break;
      }
      case 'A': {
        ensureSub();
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const to = { x: num() + ox, y: num() + oy };
        sub!.segs.push(...arcToCubics(cur, to, rx, ry, rot, large, sweep));
        cur = to;
        lastCtrl = undefined;
        break;
      }
      case 'Z': {
        if (sub) {
          const s = sub.start;
          if (Math.hypot(cur.x - s.x, cur.y - s.y) > 1e-6) line({ ...s });
          sub.closed = true;
          cur = { ...s };
        }
        sub = undefined;
        lastCtrl = undefined;
        break;
      }
      default:
        throw new Error(`Invalid path command "${cmd}"`);
    }
    // Further coordinates without a letter repeat the command (after M/m: L/l), see the top of the loop.
    lastCmd = cmd;
    if (C === 'Z' && hasNum()) throw new Error('Invalid path data: numbers after Z');
  }
  return out.filter((s) => s.segs.length > 0);
}

/** SVG arc (endpoint form) → cubic segments, per the SVG spec's conversion to centre form. */
function arcToCubics(
  p0: Pt,
  p1: Pt,
  rx: number,
  ry: number,
  rotDeg: number,
  large: number,
  sweep: number,
): Cubic[] {
  if ((p0.x === p1.x && p0.y === p1.y) || rx === 0 || ry === 0)
    return [{ c1: { ...p0 }, c2: { ...p1 }, to: { ...p1 } }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * (rx * y1)) / ry;
  const cy1 = (coef * -(ry * x1)) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t: number) => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  });
  const deriv = (t: number) => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  });
  const out: Cubic[] = [];
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step;
    const b = a + step;
    const pa = pt(a);
    const pb = j === n - 1 ? { ...p1 } : pt(b);
    const da = deriv(a);
    const db = deriv(b);
    out.push({
      c1: { x: pa.x + k * da.x, y: pa.y + k * da.y },
      c2: { x: pb.x - k * db.x, y: pb.y - k * db.y },
      to: pb,
    });
  }
  return out;
}

const tx = (m: Matrix, p: Pt): Pt => ({
  x: m.m00 * p.x + m.m01 * p.y + m.m02,
  y: m.m10 * p.x + m.m11 * p.y + m.m12,
});

export function transformSubpaths(paths: Subpath[], m: Matrix): Subpath[] {
  return paths.map((s) => ({
    start: tx(m, s.start),
    closed: s.closed,
    segs: s.segs.map((c) => ({ c1: tx(m, c.c1), c2: tx(m, c.c2), to: tx(m, c.to) })),
  }));
}

/** Tight bounds, including the extremes of curves. */
export function subpathBounds(paths: Subpath[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Pt) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  const extremes = (a: number, b: number, c: number, d: number): number[] => {
    // Roots of the derivative of a cubic Bézier in one axis.
    const qa = -a + 3 * b - 3 * c + d;
    const qb = 2 * (a - 2 * b + c);
    const qc = b - a;
    if (Math.abs(qa) < 1e-12) return Math.abs(qb) < 1e-12 ? [] : [-qc / qb];
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return [];
    const r = Math.sqrt(disc);
    return [(-qb + r) / (2 * qa), (-qb - r) / (2 * qa)];
  };
  const at = (a: number, b: number, c: number, d: number, t: number) =>
    (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
  for (const s of paths) {
    let p = s.start;
    add(p);
    for (const c of s.segs) {
      add(c.to);
      for (const t of [...extremes(p.x, c.c1.x, c.c2.x, c.to.x), ...extremes(p.y, c.c1.y, c.c2.y, c.to.y)]) {
        if (t > 0 && t < 1)
          add({ x: at(p.x, c.c1.x, c.c2.x, c.to.x, t), y: at(p.y, c.c1.y, c.c2.y, c.to.y, t) });
      }
      p = c.to;
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Builds a vector network. `filled` adds one region (winding rule NONZERO or ODD) whose loops are
 * the closed subpaths; open subpaths only carry strokes.
 */
export function subpathsToNetwork(paths: Subpath[], fill: 'NONZERO' | 'ODD' | null): VectorNetwork {
  const net: VectorNetwork = { vertices: [], segments: [], regions: [] };
  const loops: number[][] = [];
  const vertex = (p: Pt) => {
    net.vertices.push({ x: p.x, y: p.y, styleID: 0 });
    return net.vertices.length - 1;
  };
  for (const s of paths) {
    const first = vertex(s.start);
    let prev = first;
    let prevPt = s.start;
    const loop: number[] = [];
    s.segs.forEach((c, k) => {
      const last = k === s.segs.length - 1;
      const closesHere = s.closed && last && Math.hypot(c.to.x - s.start.x, c.to.y - s.start.y) < 1e-6;
      const end = closesHere ? first : vertex(c.to);
      net.segments.push({
        styleID: 0,
        start: prev,
        tangentStart: { x: c.c1.x - prevPt.x, y: c.c1.y - prevPt.y },
        end,
        tangentEnd: { x: c.c2.x - c.to.x, y: c.c2.y - c.to.y },
      });
      loop.push(net.segments.length - 1);
      prev = end;
      prevPt = c.to;
    });
    if (s.closed && loop.length) loops.push(loop);
  }
  if (fill && loops.length) net.regions.push({ styleID: 0, windingRule: fill, loops });
  return net;
}

const f = (n: number) => String(Math.round(n * 1000) / 1000);

/** SVG path data of a network (every segment; closed loops end with Z), scaled from its normalized size. */
export function networkToPathData(net: VectorNetwork, sx = 1, sy = 1, onlyRegions = false): string {
  const parts: string[] = [];
  const P = (i: number) => net.vertices[i]!;
  const seg = (k: number) => {
    const s = net.segments[k]!;
    const a = P(s.start);
    const b = P(s.end);
    const straight = !s.tangentStart.x && !s.tangentStart.y && !s.tangentEnd.x && !s.tangentEnd.y;
    return straight
      ? `L${f(b.x * sx)} ${f(b.y * sy)}`
      : `C${f((a.x + s.tangentStart.x) * sx)} ${f((a.y + s.tangentStart.y) * sy)} ${f((b.x + s.tangentEnd.x) * sx)} ${f((b.y + s.tangentEnd.y) * sy)} ${f(b.x * sx)} ${f(b.y * sy)}`;
  };
  if (onlyRegions) {
    for (const r of net.regions) {
      for (const loop of r.loops) {
        if (!loop.length) continue;
        const s0 = net.segments[loop[0]!]!;
        parts.push(`M${f(P(s0.start).x * sx)} ${f(P(s0.start).y * sy)}`, ...loop.map(seg), 'Z');
      }
    }
    return parts.join('');
  }
  // Strokes: chains of consecutive segments.
  let prevEnd = -1;
  net.segments.forEach((s, k) => {
    if (s.start !== prevEnd) parts.push(`M${f(P(s.start).x * sx)} ${f(P(s.start).y * sy)}`);
    parts.push(seg(k));
    prevEnd = s.end;
  });
  return parts.join('');
}

/** Appends `other` to `target` (indices shifted), e.g. open stroke-only paths to a filled network. */
export function mergeNetwork(target: VectorNetwork, other: VectorNetwork): VectorNetwork {
  const v0 = target.vertices.length;
  const s0 = target.segments.length;
  target.vertices.push(...other.vertices);
  target.segments.push(...other.segments.map((s) => ({ ...s, start: s.start + v0, end: s.end + v0 })));
  target.regions.push(
    ...other.regions.map((r) => ({ ...r, loops: r.loops.map((l) => l.map((i) => i + s0)) })),
  );
  return target;
}
