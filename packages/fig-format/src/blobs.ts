/**
 * Binary blobs referenced from nodes (`commandsBlob`, `vectorNetworkBlob`, glyph outlines).
 * See docs/fig-format.md §3.
 */
import { view } from './bytes.js';

export type PathCommand =
  | { type: 'Z' }
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number };

const ARGS: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };

/** Decodes a path commands blob: repeated [u8 command][f32 LE args…]. */
export function decodePathCommands(bytes: Uint8Array): PathCommand[] {
  const dv = view(bytes);
  const out: PathCommand[] = [];
  let o = 0;
  const f = () => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  while (o < bytes.length) {
    const cmd = bytes[o++]!;
    const n = ARGS[cmd];
    if (n === undefined) throw new Error(`unknown path command ${cmd} at byte ${o - 1}`);
    if (o + n * 4 > bytes.length) throw new Error('truncated path commands blob');
    switch (cmd) {
      case 0:
        out.push({ type: 'Z' });
        break;
      case 1:
        out.push({ type: 'M', x: f(), y: f() });
        break;
      case 2:
        out.push({ type: 'L', x: f(), y: f() });
        break;
      case 3:
        out.push({ type: 'Q', x1: f(), y1: f(), x: f(), y: f() });
        break;
      case 4:
        out.push({ type: 'C', x1: f(), y1: f(), x2: f(), y2: f(), x: f(), y: f() });
        break;
    }
  }
  return out;
}

export function encodePathCommands(cmds: PathCommand[]): Uint8Array {
  const size = cmds.reduce((n, c) => n + 1 + 4 * ARGS[{ Z: 0, M: 1, L: 2, Q: 3, C: 4 }[c.type]]!, 0);
  const out = new Uint8Array(size);
  const dv = view(out);
  let o = 0;
  const f = (v: number) => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'Z':
        out[o++] = 0;
        break;
      case 'M':
        out[o++] = 1;
        f(c.x);
        f(c.y);
        break;
      case 'L':
        out[o++] = 2;
        f(c.x);
        f(c.y);
        break;
      case 'Q':
        out[o++] = 3;
        f(c.x1);
        f(c.y1);
        f(c.x);
        f(c.y);
        break;
      case 'C':
        out[o++] = 4;
        f(c.x1);
        f(c.y1);
        f(c.x2);
        f(c.y2);
        f(c.x);
        f(c.y);
        break;
    }
  }
  return out;
}

const num = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * SVG path data. A leading close command with no open subpath (seen at the start of glyph blobs)
 * is skipped.
 */
export function pathCommandsToSvg(cmds: PathCommand[], scale = 1, dx = 0, dy = 0): string {
  const X = (x: number) => num(x * scale + dx);
  const Y = (y: number) => num(y * scale + dy);
  const parts: string[] = [];
  let open = false;
  for (const c of cmds) {
    switch (c.type) {
      case 'Z':
        if (open) parts.push('Z');
        open = false;
        break;
      case 'M':
        parts.push(`M${X(c.x)} ${Y(c.y)}`);
        open = true;
        break;
      case 'L':
        parts.push(`L${X(c.x)} ${Y(c.y)}`);
        break;
      case 'Q':
        parts.push(`Q${X(c.x1)} ${Y(c.y1)} ${X(c.x)} ${Y(c.y)}`);
        break;
      case 'C':
        parts.push(`C${X(c.x1)} ${Y(c.y1)} ${X(c.x2)} ${Y(c.y2)} ${X(c.x)} ${Y(c.y)}`);
        break;
    }
  }
  return parts.join('');
}

export interface VectorVertex {
  x: number;
  y: number;
  styleID: number;
}

export interface VectorSegment {
  styleID: number;
  start: number;
  tangentStart: { x: number; y: number };
  end: number;
  tangentEnd: { x: number; y: number };
}

export interface VectorRegion {
  styleID: number;
  windingRule: 'NONZERO' | 'ODD';
  /** Each loop is a list of segment indices. */
  loops: number[][];
}

export interface VectorNetwork {
  vertices: VectorVertex[];
  segments: VectorSegment[];
  regions: VectorRegion[];
}

/**
 * Decodes a vector network blob:
 * header [u32 vertexCount][u32 segmentCount][u32 regionCount],
 * vertex [u32 styleID][f32 x][f32 y] (12 bytes, verified),
 * segment [u32 styleID][u32 start][f32 tsx][f32 tsy][u32 end][f32 tex][f32 tey] (28 bytes, verified),
 * region [u32 (styleID << 1) | (windingRule NONZERO ? 1 : 0)][u32 loopCount] then per loop
 * [u32 indexCount][u32 segmentIndex…] (layout verified; winding bit meaning assumed).
 */
export function decodeVectorNetwork(bytes: Uint8Array): VectorNetwork {
  const dv = view(bytes);
  let o = 0;
  const u = () => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const f = () => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  const vertexCount = u();
  const segmentCount = u();
  const regionCount = u();
  const vertices: VectorVertex[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const styleID = u();
    vertices.push({ styleID, x: f(), y: f() });
  }
  const segments: VectorSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const styleID = u();
    const start = u();
    const tangentStart = { x: f(), y: f() };
    const end = u();
    const tangentEnd = { x: f(), y: f() };
    segments.push({ styleID, start, tangentStart, end, tangentEnd });
  }
  const regions: VectorRegion[] = [];
  for (let i = 0; i < regionCount; i++) {
    const packed = u();
    const loopCount = u();
    const loops: number[][] = [];
    for (let l = 0; l < loopCount; l++) {
      const n = u();
      const loop: number[] = [];
      for (let k = 0; k < n; k++) loop.push(u());
      loops.push(loop);
    }
    regions.push({ styleID: packed >>> 1, windingRule: packed & 1 ? 'NONZERO' : 'ODD', loops });
  }
  if (o !== bytes.length) throw new Error(`vector network blob: ${bytes.length - o} trailing bytes`);
  return { vertices, segments, regions };
}

export function encodeVectorNetwork(net: VectorNetwork): Uint8Array {
  const regionBytes = net.regions.reduce(
    (n, r) => n + 8 + r.loops.reduce((m, l) => m + 4 + 4 * l.length, 0),
    0,
  );
  const out = new Uint8Array(12 + net.vertices.length * 12 + net.segments.length * 28 + regionBytes);
  const dv = view(out);
  let o = 0;
  const u = (v: number) => {
    dv.setUint32(o, v, true);
    o += 4;
  };
  const f = (v: number) => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  u(net.vertices.length);
  u(net.segments.length);
  u(net.regions.length);
  for (const v of net.vertices) {
    u(v.styleID);
    f(v.x);
    f(v.y);
  }
  for (const s of net.segments) {
    u(s.styleID);
    u(s.start);
    f(s.tangentStart.x);
    f(s.tangentStart.y);
    u(s.end);
    f(s.tangentEnd.x);
    f(s.tangentEnd.y);
  }
  for (const r of net.regions) {
    u(((r.styleID << 1) | (r.windingRule === 'NONZERO' ? 1 : 0)) >>> 0);
    u(r.loops.length);
    for (const l of r.loops) {
      u(l.length);
      for (const i of l) u(i);
    }
  }
  return out;
}
