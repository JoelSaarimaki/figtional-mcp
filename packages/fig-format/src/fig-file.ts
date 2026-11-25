import { closeSync, copyFileSync, existsSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { type ByteSource, bufferSource, fileSource, toHex } from './bytes.js';
import {
  type ChunkCompression,
  compressChunk,
  decompressChunk,
  parseFigKiwi,
  serializeFigKiwi,
} from './fig-kiwi.js';
import { type CompiledKiwi, type KiwiSchema, compileSchema, decodeSchema } from './kiwi.js';
import type { Message } from './types.js';
import {
  METHOD_DEFLATE,
  METHOD_STORED,
  type ZipSink,
  type ZipWriteEntry,
  ZipReader,
  writeZip,
} from './zip.js';

export const CANVAS_ENTRY = 'canvas.fig';
export const META_ENTRY = 'meta.json';
export const THUMBNAIL_ENTRY = 'thumbnail.png';
export const IMAGES_DIR = 'images/';

export interface FigMeta {
  client_meta?: {
    background_color?: { r: number; g: number; b: number; a: number };
    thumbnail_size?: { width: number; height: number };
    render_coordinates?: { x: number; y: number; width: number; height: number };
    [k: string]: unknown;
  };
  file_name?: string;
  developer_related_links?: unknown[];
  exported_at?: string;
  [k: string]: unknown;
}

export interface DecodedCanvas {
  magic: string;
  version: number;
  schema: KiwiSchema;
  compiled: CompiledKiwi;
  /** Chunk 0 exactly as found (compressed). Written back unchanged. */
  schemaChunk: Uint8Array;
  messageCompression: ChunkCompression;
  /** Any chunks after the message, kept raw. */
  extraChunks: Uint8Array[];
  message: Message;
  /** Uncompressed message bytes as found, for byte-level round-trip checks. */
  messageBytes: Uint8Array;
}

/**
 * A .fig export archive. Opening is cheap: only the ZIP directory is read. canvas.fig,
 * meta.json and images are read on demand.
 */
export class FigArchive {
  readonly zip: ZipReader;
  private metaCache: FigMeta | undefined;
  /** Images added since opening (hash → bytes); written by the next save. */
  readonly addedImages = new Map<string, Uint8Array>();

  private constructor(
    source: ByteSource,
    readonly path?: string,
  ) {
    this.zip = new ZipReader(source);
    if (!this.zip.has(CANVAS_ENTRY)) {
      this.zip.close();
      throw new Error(`not a Figma export: ${CANVAS_ENTRY} missing`);
    }
  }

  static open(path: string): FigArchive {
    const src = fileSource(path);
    try {
      return new FigArchive(src, path);
    } catch (e) {
      src.close?.();
      throw e;
    }
  }

  static fromBytes(bytes: Uint8Array): FigArchive {
    return new FigArchive(bufferSource(bytes));
  }

  close(): void {
    this.zip.close();
  }

  meta(): FigMeta {
    if (!this.metaCache) {
      this.metaCache = this.zip.has(META_ENTRY)
        ? (JSON.parse(new TextDecoder().decode(this.zip.read(META_ENTRY))) as FigMeta)
        : {};
    }
    return this.metaCache;
  }

  thumbnail(): Uint8Array | undefined {
    return this.zip.has(THUMBNAIL_ENTRY) ? this.zip.read(THUMBNAIL_ENTRY) : undefined;
  }

  /** Image hashes (40-char lowercase hex SHA-1) present in the archive. */
  imageHashes(): string[] {
    const stored = this.zip.entries
      .filter((e) => e.name.startsWith(IMAGES_DIR) && !e.isDirectory)
      .map((e) => e.name.slice(IMAGES_DIR.length));
    return [...new Set([...stored, ...this.addedImages.keys()])];
  }

  /**
   * Adds an image (kept in memory until the archive is saved) and returns its hash: the SHA-1 of
   * the bytes as 40 lowercase hex characters, which is how Figma names files in `images/`.
   */
  addImage(bytes: Uint8Array): string {
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (!this.image(hash)) this.addedImages.set(hash, bytes);
    return hash;
  }

  /** Image bytes by hash (hex string or the 20 raw bytes from a Paint). */
  image(hash: string | Uint8Array): Uint8Array | undefined {
    const hex = typeof hash === 'string' ? hash.toLowerCase() : toHex(hash);
    const added = this.addedImages.get(hex);
    if (added) return added;
    const name = IMAGES_DIR + hex;
    return this.zip.has(name) ? this.zip.read(name) : undefined;
  }

  decodeCanvas(): DecodedCanvas {
    const container = parseFigKiwi(this.zip.read(CANVAS_ENTRY));
    const [schemaChunk, messageChunk, ...extraChunks] = container.chunks as [Uint8Array, Uint8Array];
    const schema = decodeSchema(decompressChunk(schemaChunk).data);
    const compiled = compileSchema(schema);
    const { data: messageBytes, compression } = decompressChunk(messageChunk);
    const message = compiled.decodeMessage(messageBytes) as Message;
    return {
      magic: container.magic,
      version: container.version,
      schema,
      compiled,
      schemaChunk,
      messageCompression: compression,
      extraChunks,
      message,
      messageBytes,
    };
  }
}

/** Encodes a message into canvas.fig bytes, reusing the original schema chunk and compression. */
export function encodeCanvas(canvas: DecodedCanvas, message: Message = canvas.message): Uint8Array {
  const messageBytes = canvas.compiled.encodeMessage(message);
  const compression = canvas.messageCompression === 'zlib' ? 'zstd' : canvas.messageCompression;
  return serializeFigKiwi({
    magic: canvas.magic,
    version: canvas.version,
    chunks: [canvas.schemaChunk, compressChunk(messageBytes, compression), ...canvas.extraChunks],
  });
}

export interface WriteFigOptions {
  /** New canvas.fig bytes (see encodeCanvas). */
  canvas: Uint8Array;
  /** Replacement meta.json. Defaults to the source's. */
  meta?: FigMeta;
  /** Replacement thumbnail.png. Defaults to the source's. */
  thumbnail?: Uint8Array;
  /** Images to add (hash hex → bytes). Existing images are copied raw. */
  addImages?: Map<string, Uint8Array>;
  /** Image hashes to drop. */
  removeImages?: Set<string>;
}

/** Builds the entry list for a new archive, in the order Figma writes them. */
function buildEntries(source: FigArchive, opts: WriteFigOptions): ZipWriteEntry[] {
  const entries: ZipWriteEntry[] = [{ name: CANVAS_ENTRY, data: opts.canvas, method: METHOD_STORED }];
  if (opts.thumbnail) entries.push({ name: THUMBNAIL_ENTRY, data: opts.thumbnail, method: METHOD_STORED });
  else if (source.zip.has(THUMBNAIL_ENTRY)) entries.push({ name: THUMBNAIL_ENTRY, copyFrom: source.zip });
  if (opts.meta) {
    entries.push({
      name: META_ENTRY,
      data: new TextEncoder().encode(JSON.stringify(opts.meta)),
      method: METHOD_DEFLATE,
    });
  } else if (source.zip.has(META_ENTRY)) entries.push({ name: META_ENTRY, copyFrom: source.zip });
  entries.push({ name: IMAGES_DIR, data: new Uint8Array(0), method: METHOD_STORED });
  const remove = opts.removeImages ?? new Set<string>();
  const added = new Map([...source.addedImages, ...(opts.addImages ?? new Map<string, Uint8Array>())]);
  for (const hash of source.imageHashes()) {
    if (remove.has(hash) || added.has(hash)) continue;
    entries.push({ name: IMAGES_DIR + hash, copyFrom: source.zip });
  }
  for (const [hash, data] of added) entries.push({ name: IMAGES_DIR + hash, data, method: METHOD_STORED });
  // Keep any unknown top-level entries.
  const known = new Set(entries.map((e) => e.name));
  for (const e of source.zip.entries) {
    if (!known.has(e.name) && !e.name.startsWith(IMAGES_DIR))
      entries.push({ name: e.name, copyFrom: source.zip });
  }
  return entries;
}

export function writeFigArchiveToBytes(source: FigArchive, opts: WriteFigOptions): Uint8Array {
  const parts: Uint8Array[] = [];
  writeZip(buildEntries(source, opts), { write: (b) => parts.push(b) });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface SaveResult {
  path: string;
  backupPath?: string;
}

/**
 * Writes a new archive to `targetPath` atomically: temp file in the same directory, then rename.
 * If `targetPath` exists and `backup` is true, the previous file is kept as `<targetPath>.bak`.
 *
 * `source` is closed before the rename, so callers must reopen it afterwards. On Windows the rename
 * fails while another process is reading the file (for example the viewer, for a moment), so it is
 * retried for up to about 2 seconds.
 */
export function saveFigArchive(
  source: FigArchive,
  targetPath: string,
  opts: WriteFigOptions & { backup?: boolean },
): SaveResult {
  const dir = dirname(targetPath);
  const tmp = join(dir, `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    const sink: ZipSink = {
      write: (b) => {
        let done = 0;
        while (done < b.length) done += writeSync(fd, b, done, b.length - done);
      },
    };
    writeZip(buildEntries(source, opts), sink);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  source.close();
  let backupPath: string | undefined;
  if (opts.backup !== false && existsSync(targetPath)) {
    backupPath = `${targetPath}.bak`;
    copyFileSync(targetPath, backupPath);
  }
  try {
    renameWithRetry(tmp, targetPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return backupPath ? { path: targetPath, backupPath } : { path: targetPath };
}

/** Windows refuses to replace a file another process has open; such handles are short-lived here. */
function renameWithRetry(from: string, to: string): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw e;
      Atomics.wait(sleeper, 0, 0, 100);
    }
  }
}
