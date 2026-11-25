/**
 * use_figma: runs agent-written Plugin API code against a .fig file (PLAN.md §5.3).
 *
 * Contract (docs/figma-mcp-tools.md §5): the code is wrapped in an async function (top-level
 * await and return work); the return value is JSON-serialised; console output is dropped;
 * figma.closePlugin() is harmless. Unlike Figma, a call is all-or-nothing: if it throws, nothing is
 * saved, so errors always report safeToRetryWithoutCanvasRead: true. A successful call with
 * changes is saved immediately (atomically, with a .bak), like Figma applying edits live.
 *
 * The vm sandbox only keeps well-behaved code tidy (no require/process/fs); it is not a
 * security boundary. Access control is the Workspace scope.
 */
import { createContext, Script } from 'node:vm';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FigArchive, encodeCanvas, saveFigArchive } from '@figtional/fig-format';
import { EditSession, FigDocument } from '@figtional/fig-model';
import { drawnFontNote, measuredFontNote } from './font-notes.js';
import { type ApiContext, createFigmaApi } from './plugin-api.js';
import type { FileEntry, Workspace } from './workspace.js';

export interface UseFigmaResult {
  ok: boolean;
  /** JSON text of the return value, or the error message. */
  text: string;
  images: { data: string; caption: string }[];
  saved?: string;
  /** Figtional limitations that affected this call (font replacements), as separate notes. */
  notes?: string[];
}

const locks = new Map<string, Promise<unknown>>();

/** Runs calls on the same file one after another (agents may fan out parallel calls). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

function serialise(value: unknown): string {
  if (value === undefined) return 'undefined';
  // Only a reference back to an ancestor is circular; the same object appearing twice is not.
  const path = new Set<object>();
  const plain = (v: any): any => {
    if (typeof v === 'symbol') return v.description === 'figma.mixed' ? 'mixed' : String(v);
    if (typeof v === 'bigint') return v.toString();
    if (!v || typeof v !== 'object') return v;
    if (path.has(v)) return '[Circular]';
    // Node objects serialise to a short reference, like Figma's own JSON output.
    if (typeof v.id === 'string' && typeof v.type === 'string' && 'parent' in v) {
      try {
        return { id: v.id, name: v.name, type: v.type };
      } catch {
        return { id: v.id };
      }
    }
    if (typeof v.toJSON === 'function') return plain(v.toJSON());
    path.add(v);
    try {
      if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<unknown>, plain);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        const x = plain(v[k]);
        if (x !== undefined && typeof x !== 'function') out[k] = x;
      }
      return out;
    } finally {
      path.delete(v);
    }
  };
  return JSON.stringify(plain(value), null, 2) ?? 'null';
}

/** Documents kept between use_figma calls (by file path), valid while the file is unchanged. */
const documentCache = new Map<string, { doc: FigDocument; mtimeMs: number; size: number }>();
const DOCUMENT_CACHE_SIZE = 2;

function takeCachedDocument(path: string): FigDocument | undefined {
  const c = documentCache.get(path);
  documentCache.delete(path);
  if (!c) return undefined;
  try {
    const st = statSync(path);
    if (st.mtimeMs === c.mtimeMs && st.size === c.size) return c.doc;
  } catch {
    /* file gone */
  }
  c.doc.archive?.close();
  return undefined;
}

function cacheDocument(path: string, doc: FigDocument): void {
  const st = statSync(path);
  documentCache.set(path, { doc, mtimeMs: st.mtimeMs, size: st.size });
  while (documentCache.size > DOCUMENT_CACHE_SIZE) {
    const [oldest, c] = documentCache.entries().next().value as [string, { doc: FigDocument }];
    documentCache.delete(oldest);
    c.doc.archive?.close();
  }
}

export async function runUseFigma(
  workspace: Workspace,
  entry: FileEntry,
  code: string,
  opts: { timeoutMs?: number } = {},
): Promise<UseFigmaResult> {
  return withLock(entry.path, async () => {
    if (!entry.writable) {
      return {
        ok: false,
        text:
          `This file is read-only in this Figtional session. Start Figtional with --writable (or "writable": true in the config) to allow edits.\n` +
          'safeToRetryWithoutCanvasRead: true',
        images: [],
      };
    }
    // With an output folder, edits accumulate in the output copy; otherwise in the file itself.
    const target = workspace.options.outDir
      ? join(workspace.options.outDir, entry.path.split(/[\\/]/).pop()!)
      : entry.path;
    // The document of the previous successful call is reused while the file is unchanged on disk;
    // it is taken out of the cache for the call, so a failed call leaves nothing behind.
    const source = existsSync(target) ? target : entry.path;
    const doc = takeCachedDocument(source) ?? FigDocument.fromArchive(FigArchive.open(source));
    const archive = doc.archive!;
    try {
      const session = new EditSession(doc);
      const ctx: ApiContext = { doc, session, fileKey: entry.key, fileName: entry.name, images: [] };
      const figma = createFigmaApi(ctx);
      const noop = () => undefined;
      const sandbox = createContext(
        {
          figma,
          console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
          setTimeout,
          clearTimeout,
          Promise,
        },
        { codeGeneration: { strings: false, wasm: false }, name: 'use_figma' },
      );
      const wrapped = `'use strict';\n(async () => {\n${code}\n})()`;
      let script: Script;
      try {
        script = new Script(wrapped, { filename: 'use_figma.js' });
      } catch (e) {
        return {
          ok: false,
          text: `SyntaxError: ${(e as Error).message}\nsafeToRetryWithoutCanvasRead: true`,
          images: [],
        };
      }
      const timeoutMs = opts.timeoutMs ?? 60_000;
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        script.runInContext(sandbox, { timeout: Math.min(timeoutMs, 30_000) }) as Promise<unknown>,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Script timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const text = serialise(result);
      session.commit();
      let saved: string | undefined;
      if (session.changed) {
        mkdirSync(dirname(target), { recursive: true });
        // Windows can't replace a file that is still open: drop cached handles first.
        workspace.release(target);
        workspace.release(entry.path);
        saveFigArchive(archive, target, { canvas: encodeCanvas(doc.canvas) });
        saved = target;
        doc.archive = FigArchive.open(target);
        cacheDocument(target, doc);
      } else {
        cacheDocument(source, doc);
      }
      const notes = [
        measuredFontNote(session.fontFallbacks),
        drawnFontNote(ctx.drawnFontFallbacks ?? new Map()),
      ].filter((n): n is string => !!n);
      return {
        ok: true,
        text,
        images: ctx.images,
        ...(saved ? { saved } : {}),
        ...(notes.length ? { notes } : {}),
      };
    } catch (e) {
      archive.close();
      const err = e as Error;
      const name = err?.name && err.name !== 'Error' ? `${err.name}: ` : '';
      return {
        ok: false,
        text: `${name}${err?.message ?? String(e)}\nsafeToRetryWithoutCanvasRead: true\n(Figtional applies use_figma calls all-or-nothing: nothing was changed.)`,
        images: [],
      };
    }
  });
}
