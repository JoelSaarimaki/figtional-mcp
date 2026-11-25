/**
 * Minimal ZIP reader/writer for .fig archives.
 *
 * Why not a library: we need (1) lazy random access, so a 270 MB export doesn't have to be
 * loaded to read meta.json, and (2) raw copies of unchanged entries (images) when saving,
 * without recompressing them. Figma writes STORED entries for canvas.fig/thumbnail/images
 * and DEFLATE for meta.json, with no ZIP64.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { type ByteSource, view } from './bytes.js';

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** MS-DOS time and date words, as stored. */
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export class ZipReader {
  readonly entries: ZipEntry[];
  private readonly byName: Map<string, ZipEntry>;

  constructor(readonly source: ByteSource) {
    this.entries = readCentralDirectory(source);
    this.byName = new Map(this.entries.map((e) => [e.name, e]));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Compressed bytes of an entry, exactly as stored in the archive. */
  readRaw(name: string): Uint8Array {
    const e = this.require(name);
    const local = this.source.read(e.localHeaderOffset, 30);
    const dv = view(local);
    if (dv.getUint32(0, true) !== SIG_LOCAL) throw new Error(`bad local header for ${name}`);
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    return this.source.read(e.localHeaderOffset + 30 + nameLen + extraLen, e.compressedSize);
  }

  /** Decompressed entry contents. */
  read(name: string): Uint8Array {
    const e = this.require(name);
    const raw = this.readRaw(name);
    if (e.method === METHOD_STORED) return raw;
    if (e.method === METHOD_DEFLATE) return new Uint8Array(inflateRawSync(raw));
    throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  }

  close(): void {
    this.source.close?.();
  }

  private require(name: string): ZipEntry {
    const e = this.byName.get(name);
    if (!e) throw new Error(`zip entry not found: ${name}`);
    return e;
  }
}

function readCentralDirectory(src: ByteSource): ZipEntry[] {
  // EOCD is at most 22 + 65535 bytes from the end.
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = src.read(src.size - tailLen, tailLen);
  const tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory record)');
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const cd = src.read(cdOffset, cdSize);
  const dv = view(cd);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(o, true) !== SIG_CENTRAL) throw new Error('corrupt central directory');
    const method = dv.getUint16(o + 10, true);
    const dosTime = dv.getUint16(o + 12, true);
    const dosDate = dv.getUint16(o + 14, true);
    const crc = dv.getUint32(o + 16, true);
    const compressedSize = dv.getUint32(o + 20, true);
    const size = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    const localHeaderOffset = dv.getUint32(o + 42, true);
    const name = decoder.decode(cd.subarray(o + 46, o + 46 + nameLen));
    entries.push({
      name,
      method,
      crc32: crc,
      compressedSize,
      size,
      dosTime,
      dosDate,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** An entry to write: either new content, or a raw copy of an entry from an existing archive. */
export type ZipWriteEntry =
  | {
      name: string;
      data: Uint8Array;
      method?: number;
      date?: Date;
      /** Unix permissions (e.g. 0o755 for a script); marks the entry as made on Unix. */
      unixMode?: number;
    }
  | { name: string; copyFrom: ZipReader; date?: Date };

export interface ZipSink {
  write(bytes: Uint8Array): void;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Writes a ZIP archive to `sink`. Entries are written in the given order. */
export function writeZip(entries: ZipWriteEntry[], sink: ZipSink): void {
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    let method: number, crc: number, size: number, payload: Uint8Array, time: number, date: number;
    if ('copyFrom' in e) {
      const src = e.copyFrom.entry(e.name);
      if (!src) throw new Error(`zip entry not found in source: ${e.name}`);
      method = src.method;
      crc = src.crc32;
      size = src.size;
      payload = e.copyFrom.readRaw(e.name);
      ({ time, date } = e.date ? dosDateTime(e.date) : { time: src.dosTime, date: src.dosDate });
    } else {
      method = e.method ?? METHOD_STORED;
      crc = crc32(e.data) >>> 0;
      size = e.data.length;
      payload = method === METHOD_DEFLATE ? new Uint8Array(deflateRawSync(e.data)) : e.data;
      ({ time, date } = e.date ? dosDateTime(e.date) : now);
    }
    if (offset > 0xffffffff || payload.length > 0xffffffff)
      throw new Error('archive too large (ZIP64 not supported)');

    const flags = 0x0800; // UTF-8 names
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = view(local);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cent = new Uint8Array(46 + nameBytes.length);
    const cv = view(cent);
    cv.setUint32(0, SIG_CENTRAL, true);
    const unixMode = 'data' in e ? e.unixMode : undefined;
    cv.setUint16(4, unixMode !== undefined ? 0x0314 : 20, true); // version made by (3 = Unix)
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    // external attrs: MS-DOS directory flag, plus the Unix mode in the high 16 bits
    const dosAttrs = e.name.endsWith('/') ? 0x10 : 0;
    const fileType = e.name.endsWith('/') ? 0o040000 : 0o100000;
    cv.setUint32(
      38,
      unixMode !== undefined ? (((fileType | unixMode) << 16) | dosAttrs) >>> 0 : dosAttrs,
      true,
    );
    cv.setUint32(42, offset, true);
    cent.set(nameBytes, 46);
    central.push(cent);

    sink.write(local);
    sink.write(payload);
    offset += local.length + payload.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) {
    sink.write(c);
    cdSize += c.length;
  }
  if (entries.length > 0xfffe) throw new Error('too many zip entries (ZIP64 not supported)');
  const eocd = new Uint8Array(22);
  const ev = view(eocd);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  sink.write(eocd);
}
