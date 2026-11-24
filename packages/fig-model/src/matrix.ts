import type { Matrix, Vector } from '@figtional/fig-format';

export const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** a × b (apply b first, then a). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
    m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (det === 0) throw new Error('matrix is not invertible');
  const i00 = m.m11 / det;
  const i01 = -m.m01 / det;
  const i10 = -m.m10 / det;
  const i11 = m.m00 / det;
  return {
    m00: i00,
    m01: i01,
    m02: -(i00 * m.m02 + i01 * m.m12),
    m10: i10,
    m11: i11,
    m12: -(i10 * m.m02 + i11 * m.m12),
  };
}

export function applyToPoint(m: Matrix, p: Vector): Vector {
  return { x: m.m00 * p.x + m.m01 * p.y + m.m02, y: m.m10 * p.x + m.m11 * p.y + m.m12 };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Axis-aligned bounds of a w×h box transformed by m. */
export function transformedBounds(m: Matrix, w: number, h: number): Rect {
  const pts = [
    applyToPoint(m, { x: 0, y: 0 }),
    applyToPoint(m, { x: w, y: 0 }),
    applyToPoint(m, { x: 0, y: h }),
    applyToPoint(m, { x: w, y: h }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Rotation in degrees as the Plugin API reports it (counter-clockwise positive). */
export function rotationDegrees(m: Matrix): number {
  const r = (Math.atan2(-m.m10, m.m00) * 180) / Math.PI;
  return Math.abs(r) < 1e-9 ? 0 : r;
}
