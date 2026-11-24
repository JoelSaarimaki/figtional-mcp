/**
 * Loose TypeScript views of decoded kiwi data. The real shape is defined by the schema
 * embedded in each file; these types only name the fields Figtional uses. Every object
 * keeps all other fields (index signature) so nothing is lost on round-trip.
 */

export interface GUID {
  sessionID: number;
  localID: number;
}

export interface ParentIndex {
  guid: GUID;
  /** Fractional index; siblings sort by this string (code-unit order). */
  position: string;
}

export interface Vector {
  x: number;
  y: number;
}

/** 2×3 affine matrix (Figma `Matrix`): [m00 m01 m02; m10 m11 m12]. */
export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface NodeChange {
  guid: GUID;
  phase?: string;
  type?: string;
  name?: string;
  parentIndex?: ParentIndex;
  visible?: boolean;
  opacity?: number;
  size?: Vector;
  transform?: Matrix;
  [field: string]: any;
}

export interface Blob {
  bytes: Uint8Array;
}

export interface Message {
  type: string;
  nodeChanges: NodeChange[];
  blobs?: Blob[];
  [field: string]: any;
}

/** "sessionID:localID", the id format used by Figma's Plugin API and MCP tools. */
export function guidToString(g: GUID): string {
  return `${g.sessionID}:${g.localID}`;
}

/** Parses "1:4" or the URL form "1-4". Returns undefined for anything else. */
export function parseGuid(id: string): GUID | undefined {
  const m = /^(\d+)[:-](\d+)$/.exec(id.trim());
  if (!m) return undefined;
  return { sessionID: Number(m[1]), localID: Number(m[2]) };
}

/** uint32 max pair, used by Figma as a "no node" sentinel (e.g. prototype destinations). */
export function isNullGuid(g: GUID | undefined | null): boolean {
  return !g || (g.sessionID === 0xffffffff && g.localID === 0xffffffff);
}
