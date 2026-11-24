/**
 * The `canvas.fig` container: "fig-kiwi" magic, uint32 version, then length-prefixed chunks.
 * Chunk 0 = kiwi binary schema, chunk 1 = message. Each chunk is compressed; we detect
 * the compression from magic bytes (zstd vs. raw deflate vs. zlib).
 */
import {
  deflateRawSync,
  inflateRawSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
  constants as zc,
} from 'node:zlib';
import { concatBytes, view } from './bytes.js';

export const FIG_KIWI_MAGIC = 'fig-kiwi';

export type ChunkCompression = 'zstd' | 'deflate-raw' | 'zlib' | 'none';

export interface FigKiwiContainer {
  /** Magic string as found (normally "fig-kiwi"; FigJam uses "fig-jam."). */
  magic: string;
  version: number;
  /** Raw (still compressed) chunk bytes. */
  chunks: Uint8Array[];
}

export function parseFigKiwi(bytes: Uint8Array): FigKiwiContainer {
  if (bytes.length < 12) throw new Error('canvas.fig too short');
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (!/^fig-(kiwi|jam\.|deck|make)/.test(magic)) {
    throw new Error(`not a fig-kiwi file (magic ${JSON.stringify(magic)})`);
  }
  const dv = view(bytes);
  const version = dv.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let o = 12;
  while (o + 4 <= bytes.length) {
    const n = dv.getUint32(o, true);
    if (o + 4 + n > bytes.length) throw new Error('truncated fig-kiwi chunk');
    chunks.push(bytes.subarray(o + 4, o + 4 + n));
    o += 4 + n;
  }
  if (chunks.length < 2) throw new Error(`expected at least 2 chunks, found ${chunks.length}`);
  return { magic, version, chunks };
}

export function serializeFigKiwi(c: FigKiwiContainer): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(c.magic.padEnd(8).slice(0, 8)), 0);
  view(header).setUint32(8, c.version, true);
  const parts: Uint8Array[] = [header];
  for (const chunk of c.chunks) {
    const len = new Uint8Array(4);
    view(len).setUint32(0, chunk.length, true);
    parts.push(len, chunk);
  }
  return concatBytes(parts);
}

export function detectCompression(b: Uint8Array): ChunkCompression {
  if (b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd';
  // zlib header: CMF=0x78 and (CMF*256+FLG) % 31 == 0
  if (b.length >= 2 && b[0] === 0x78 && ((b[0] << 8) | b[1]!) % 31 === 0) return 'zlib';
  return 'deflate-raw';
}

export function decompressChunk(b: Uint8Array): { data: Uint8Array; compression: ChunkCompression } {
  const compression = detectCompression(b);
  switch (compression) {
    case 'zstd':
      return { data: new Uint8Array(zstdDecompressSync(b)), compression };
    case 'zlib':
      try {
        return { data: new Uint8Array(inflateSync(b)), compression };
      } catch {
        // A raw-deflate stream may happen to start with bytes that look like a zlib header.
        return { data: new Uint8Array(inflateRawSync(b)), compression: 'deflate-raw' };
      }
    default:
      return { data: new Uint8Array(inflateRawSync(b)), compression: 'deflate-raw' };
  }
}

export function compressChunk(data: Uint8Array, compression: ChunkCompression): Uint8Array {
  switch (compression) {
    case 'zstd':
      return new Uint8Array(zstdCompressSync(data, { params: { [zc.ZSTD_c_compressionLevel]: 3 } }));
    case 'deflate-raw':
      return new Uint8Array(deflateRawSync(data));
    case 'zlib':
      throw new Error('writing zlib-wrapped chunks is not supported');
    case 'none':
      return data;
  }
}
