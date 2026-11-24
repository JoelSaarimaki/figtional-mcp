/**
 * The set of .fig files a Figtional session may access, and nothing else (PLAN.md §4).
 * Sources are single files or folders. Folder contents are re-scanned on use, and every path is
 * resolved with realpath and checked to stay inside its folder.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';

export type SourceConfig =
  | { file: string; key?: string; writable?: boolean }
  | { dir: string; recursive?: boolean; writable?: boolean };

export interface WorkspaceOptions {
  sources: SourceConfig[];
  /** Writable for every source (CLI --writable). */
  writable?: boolean;
  /** Where saved files go instead of overwriting the originals. */
  outDir?: string;
  /** Base for relative paths (default: process.cwd()). */
  cwd?: string;
  /** How many decoded documents to keep in memory. */
  cacheSize?: number;
}

export interface FileEntry {
  key: string;
  /** Real path on disk. */
  path: string;
  /** Display name: meta.json file_name, or the file name without extension. */
  name: string;
  writable: boolean;
  /** Which source it came from (for whoami). */
  source: string;
}

export class FileNotAvailableError extends Error {
  constructor(
    readonly fileKey: string,
    readonly available: string[],
  ) {
    super(
      `File "${fileKey}" is not available in this Figtional session. Available file keys: ${
        available.length ? available.join(', ') : '(none)'
      }.`,
    );
  }
}

/** Lowercase slug, safe in a figma.com/design/<key>/… URL path segment. */
export function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'file';
}

const isFigFile = (name: string) => extname(name).toLowerCase() === '.fig';

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

interface CachedDoc {
  doc: FigDocument;
  mtimeMs: number;
  size: number;
}

export class Workspace {
  private readonly cwd: string;
  private readonly cache = new Map<string, CachedDoc>();
  private readonly cacheSize: number;
  private readonly metaNames = new Map<string, { mtimeMs: number; name: string }>();
  private collisions: string[] = [];

  constructor(readonly options: WorkspaceOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.cacheSize = options.cacheSize ?? 4;
    for (const s of options.sources) {
      const p = resolve(this.cwd, 'file' in s ? s.file : s.dir);
      if (!existsSync(p)) throw new Error(`source not found: ${p}`);
      const st = statSync(p);
      if ('file' in s && !st.isFile()) throw new Error(`not a file: ${p}`);
      if ('dir' in s && !st.isDirectory()) throw new Error(`not a directory: ${p}`);
    }
  }

  /** Human-readable description of the configured scope. */
  describeScope(): { kind: 'file' | 'folder'; path: string; recursive?: boolean; writable: boolean }[] {
    return this.options.sources.map((s) =>
      'file' in s
        ? { kind: 'file' as const, path: resolve(this.cwd, s.file), writable: this.isWritable(s) }
        : {
            kind: 'folder' as const,
            path: resolve(this.cwd, s.dir),
            recursive: s.recursive === true,
            writable: this.isWritable(s),
          },
    );
  }

  private isWritable(s: SourceConfig): boolean {
    return this.options.writable === true || s.writable === true;
  }

  private outDirReal(): string | undefined {
    if (!this.options.outDir) return undefined;
    const p = resolve(this.cwd, this.options.outDir);
    return existsSync(p) ? realpathSync(p) : p;
  }

  /** All accessible files, freshly scanned. Keys are unique and stable for a given layout. */
  listFiles(): FileEntry[] {
    const found: {
      path: string;
      baseKey: string;
      writable: boolean;
      source: string;
      explicitKey?: boolean;
    }[] = [];
    const seen = new Set<string>();
    const outDir = this.outDirReal();
    for (const s of this.options.sources) {
      if ('file' in s) {
        const p = resolve(this.cwd, s.file);
        if (!existsSync(p)) continue;
        const real = realpathSync(p);
        if (seen.has(real)) continue;
        seen.add(real);
        found.push({
          path: real,
          baseKey: s.key ? slugify(s.key) : slugify(basename(p, extname(p))),
          explicitKey: !!s.key,
          writable: this.isWritable(s),
          source: p,
        });
      } else {
        const root = resolve(this.cwd, s.dir);
        if (!existsSync(root)) continue;
        const rootReal = realpathSync(root);
        for (const rel of scanFolder(rootReal, s.recursive === true, outDir)) {
          const full = join(rootReal, rel);
          let real: string;
          try {
            real = realpathSync(full);
          } catch {
            continue;
          }
          // Symlinks/junctions must not lead outside the folder.
          if (!isInside(rootReal, real) || seen.has(real)) continue;
          seen.add(real);
          const relNoExt = rel.slice(0, rel.length - extname(rel).length);
          found.push({
            path: real,
            baseKey: relNoExt.split(sep).map(slugify).join('--'),
            writable: this.isWritable(s),
            source: root,
          });
        }
      }
    }
    // Deterministic collision handling: explicit keys first, then by path.
    found.sort((a, b) => Number(!!b.explicitKey) - Number(!!a.explicitKey) || a.path.localeCompare(b.path));
    const used = new Set<string>();
    const entries: FileEntry[] = [];
    this.collisions = [];
    for (const f of found) {
      let key = f.baseKey;
      for (let i = 2; used.has(key); i++) key = `${f.baseKey}-${i}`;
      if (key !== f.baseKey) this.collisions.push(`file key collision: ${f.path} is available as "${key}"`);
      used.add(key);
      entries.push({
        key,
        path: f.path,
        name: this.displayName(f.path),
        writable: f.writable,
        source: f.source,
      });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Warnings about the scope (e.g. key collisions), for startup logs. */
  warnings(): string[] {
    this.listFiles();
    return [...this.collisions];
  }

  private displayName(path: string): string {
    try {
      const st = statSync(path);
      const cached = this.metaNames.get(path);
      if (cached && cached.mtimeMs === st.mtimeMs) return cached.name;
      const fig = FigArchive.open(path);
      try {
        const name = fig.meta().file_name || basename(path, extname(path));
        this.metaNames.set(path, { mtimeMs: st.mtimeMs, name });
        return name;
      } finally {
        fig.close();
      }
    } catch {
      return basename(path, extname(path));
    }
  }

  /** Resolves a file key (or a Figma URL containing one) to an accessible file. */
  resolve(fileKey: string): FileEntry {
    const key = parseFigmaUrl(fileKey)?.fileKey ?? fileKey.trim();
    const files = this.listFiles();
    const hit = files.find((f) => f.key === key.toLowerCase());
    if (!hit)
      throw new FileNotAvailableError(
        key,
        files.map((f) => f.key),
      );
    return hit;
  }

  /** Decoded document for a file, cached while the file is unchanged on disk. */
  document(entry: FileEntry): FigDocument {
    const st = statSync(entry.path);
    const cached = this.cache.get(entry.path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      // LRU: move to the end.
      this.cache.delete(entry.path);
      this.cache.set(entry.path, cached);
      return cached.doc;
    }
    if (cached) cached.doc.archive?.close();
    const doc = FigDocument.fromArchive(FigArchive.open(entry.path));
    this.cache.set(entry.path, { doc, mtimeMs: st.mtimeMs, size: st.size });
    while (this.cache.size > this.cacheSize) {
      const [oldest, c] = this.cache.entries().next().value as [string, CachedDoc];
      c.doc.archive?.close();
      this.cache.delete(oldest);
    }
    return doc;
  }

  /** Closes and forgets the cached document of a file (e.g. before replacing it on disk). */
  release(path: string): void {
    const c = this.cache.get(path);
    if (c) {
      c.doc.archive?.close();
      this.cache.delete(path);
    }
  }

  close(): void {
    for (const c of this.cache.values()) c.doc.archive?.close();
    this.cache.clear();
  }
}

function scanFolder(root: string, recursive: boolean, outDir: string | undefined): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue; // hidden files, including our own temp files
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!recursive) continue;
        const real = realpathSync(full);
        if (outDir && (real === outDir || isInside(outDir, real))) continue;
        walk(full, join(rel, name));
      } else if (st.isFile() && isFigFile(name)) {
        out.push(join(rel, name));
      }
    }
  };
  walk(root, '');
  return out;
}

export interface ParsedFigmaUrl {
  fileKey: string;
  nodeId?: string;
  editorType: 'design' | 'figjam' | 'slides' | 'make' | 'unknown';
}

/**
 * Parses figma.com URLs: /design/:key, /file/:key, /board/:key, /slides/:key, /make/:key, and
 * /design/:key/branch/:branchKey (the branch key is the file key). node-id "1-2" → "1:2".
 */
export function parseFigmaUrl(input: string): ParsedFigmaUrl | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  let fileKey = parts[1];
  if (!fileKey) return undefined;
  if (parts[2] === 'branch' && parts[3]) fileKey = parts[3];
  const editorType =
    kind === 'design' || kind === 'file' || kind === 'proto'
      ? 'design'
      : kind === 'board'
        ? 'figjam'
        : kind === 'slides'
          ? 'slides'
          : kind === 'make'
            ? 'make'
            : 'unknown';
  const node = url.searchParams.get('node-id');
  const result: ParsedFigmaUrl = { fileKey: decodeURIComponent(fileKey), editorType };
  if (node) result.nodeId = node.replace(/(\d+)-(\d+)/g, '$1:$2');
  return result;
}
