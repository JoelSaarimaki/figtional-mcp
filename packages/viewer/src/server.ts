/**
 * Read-only web viewer for .fig files (PLAN.md §6). Serves a small static client and a JSON/PNG API
 * over the same Workspace (source scoping) as the MCP server. Binds to 127.0.0.1 only.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  type FigDocument,
  type SceneNode,
  collectionInfo,
  formatValue,
  inspectNode,
  normalizeNodeId,
  prototypeDevice,
  prototypeFlows,
  prototypeInteractions,
  resolveVariable,
  styleInfo,
  variableInfo,
} from '@figtional/fig-model';
import { renderBounds, renderPng } from '@figtional/fig-render';
import { type FileEntry, FileNotAvailableError, type Workspace } from '@figtional/mcp-server';

const STATIC_DIR = fileURLToPath(new URL('../static/', import.meta.url));
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
};
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

export interface ViewerOptions {
  port?: number;
  /** Always 127.0.0.1 unless overridden for tests. */
  host?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const box = (b: { x: number; y: number; width: number; height: number }) => ({
  x: r2(b.x),
  y: r2(b.y),
  w: r2(b.width),
  h: r2(b.height),
});

/** Small LRU for rendered PNGs. */
class RenderCache {
  private map = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: Buffer) {
    this.map.set(k, v);
    this.bytes += v.length;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const [old, buf] = this.map.entries().next().value as [string, Buffer];
      this.map.delete(old);
      this.bytes -= buf.length;
    }
  }
}

export function createViewerServer(workspace: Workspace, opts: ViewerOptions = {}): Server {
  const cache = new RenderCache();
  const host = opts.host ?? '127.0.0.1';

  const file = (url: URL): { entry: FileEntry; doc: FigDocument; version: string } => {
    const key = url.searchParams.get('file');
    if (!key) throw new HttpError(400, 'missing file');
    let entry: FileEntry;
    try {
      entry = workspace.resolve(key);
    } catch (e) {
      if (e instanceof FileNotAvailableError) throw new HttpError(404, e.message);
      throw e;
    }
    const st = statSync(entry.path);
    return { entry, doc: workspace.document(entry), version: `${st.mtimeMs}-${st.size}` };
  };

  const node = (doc: FigDocument, url: URL, param = 'node'): SceneNode => {
    const raw = url.searchParams.get(param);
    const id = raw ? normalizeNodeId(raw) : undefined;
    const n = id ? doc.getNodeById(id) : undefined;
    if (!n) throw new HttpError(404, `node not found: ${raw}`);
    return n;
  };

  const childSummary = (c: SceneNode) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    visible: c.visible,
    hasChildren: c.figType !== 'BOOLEAN_OPERATION' ? c.children.length > 0 : false,
    instance: c.isInstanceSublayer || undefined,
  });

  const routes: Record<string, (url: URL) => unknown> = {
    '/api/files': () =>
      workspace.listFiles().map((f) => ({ key: f.key, name: f.name, writable: f.writable })),

    '/api/file': (url) => {
      const { entry, doc, version } = file(url);
      const meta = doc.archive?.meta() ?? {};
      const counts: Record<string, number> = {};
      for (const n of doc.nodes.values()) counts[n.type ?? '?'] = (counts[n.type ?? '?'] ?? 0) + 1;
      return {
        key: entry.key,
        name: entry.name,
        version,
        meta,
        format: {
          magic: doc.canvas.magic,
          version: doc.canvas.version,
          schemaDefinitions: doc.canvas.schema.definitions.length,
        },
        counts,
        images: doc.archive?.imageHashes().length ?? 0,
        pages: doc.pages.map((p) => ({ id: p.id, name: p.name, divider: p.data.isPageDivider === true })),
        collections: doc.variableCollections.map((s) => {
          const c = collectionInfo(doc, s);
          return {
            name: c.name,
            modes: c.modes.map((m) => m.name),
            variables: c.variableIds.map((id) => {
              const v = doc.nodes.get(id)!;
              const info = variableInfo(doc, v);
              return {
                name: info.name,
                type: info.resolvedType,
                values: Object.fromEntries(
                  c.modes.map((m) => [m.name, formatValue(resolveVariable(doc, v, m.modeId))]),
                ),
              };
            }),
          };
        }),
        styles: doc.styles.map((s) => {
          const i = styleInfo(s);
          return { name: i.name, type: i.styleType, value: i.value };
        }),
      };
    },

    '/api/version': (url) => ({ version: file(url).version }),

    '/api/page': (url) => {
      const { doc } = file(url);
      const page = node(doc, url, 'page');
      if (page.figType !== 'CANVAS') throw new HttpError(400, 'not a page');
      const bg = page.data.backgroundColor;
      return {
        id: page.id,
        name: page.name,
        background: bg
          ? `rgb(${Math.round(bg.r * 255)},${Math.round(bg.g * 255)},${Math.round(bg.b * 255)})`
          : '#e5e5e5',
        items: page.children
          .filter((c) => c.visible)
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            labelled: ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'].includes(c.type),
            bounds: box(renderBounds(c)),
            frame: box(c.absoluteBoundingBox),
          })),
        flows: prototypeFlows(page),
        device: prototypeDevice(page),
      };
    },

    '/api/children': (url) => {
      const { doc } = file(url);
      return node(doc, url).children.map(childSummary);
    },

    '/api/node': (url) => {
      const { doc } = file(url);
      const n = node(doc, url);
      const path: string[] = [];
      for (let p = n.parent; p && p.figType !== 'DOCUMENT'; p = p.parent) path.unshift(p.id);
      return { ...inspectNode(doc, n), path, bounds: box(n.absoluteBoundingBox) };
    },

    '/api/hit': (url) => {
      const { doc } = file(url);
      const page = node(doc, url, 'page');
      const x = Number(url.searchParams.get('x'));
      const y = Number(url.searchParams.get('y'));
      const deep = url.searchParams.get('deep') === '1';
      const hit = hitTest(page, x, y, deep);
      return hit ? { id: hit.id } : { id: null };
    },

    '/api/prototype': (url) => {
      const { doc } = file(url);
      const page = node(doc, url, 'page');
      const links: unknown[] = [];
      for (const top of page.children) {
        if (!top.visible) continue;
        top.walk((n) => {
          if (!n.visible) return false;
          for (const i of prototypeInteractions(n.data)) {
            links.push({ from: n.id, fromTop: top.id, box: box(n.absoluteBoundingBox), ...i });
          }
          return true;
        });
      }
      return { flows: prototypeFlows(page), device: prototypeDevice(page), links };
    },

    '/api/frame': (url) => {
      // Present mode: one screen with its hotspots (relative to the frame) and overlay settings.
      const { doc } = file(url);
      const frame = node(doc, url);
      const fb = frame.absoluteBoundingBox;
      const rb = renderBounds(frame);
      const hotspots: unknown[] = [];
      frame.walk((n) => {
        if (!n.visible) return false;
        for (const i of prototypeInteractions(n.data)) {
          const b = n.absoluteBoundingBox;
          hotspots.push({
            id: n.id,
            x: r2(b.x - fb.x),
            y: r2(b.y - fb.y),
            w: r2(b.width),
            h: r2(b.height),
            ...i,
          });
        }
        return true;
      });
      return {
        id: frame.id,
        name: frame.name,
        width: r2(fb.width),
        height: r2(fb.height),
        render: box(rb),
        frame: box(fb),
        overlayPosition: frame.data.overlayPositionType ?? 'CENTER',
        scrollDirection: frame.data.scrollDirection ?? 'NONE',
        hotspots,
      };
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Refuse requests addressed to other host names (DNS rebinding protection).
    const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET') {
      res.writeHead(405).end('read-only viewer');
      return;
    }
    try {
      const staticName = STATIC_FILES[url.pathname];
      if (staticName) {
        const body = readFileSync(STATIC_DIR + staticName);
        res.writeHead(200, {
          'content-type': MIME[staticName.split('.').pop()!]!,
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }
      if (url.pathname === '/api/render') {
        const { doc, version, entry } = file(url);
        const n = node(doc, url);
        const scale = Math.min(8, Math.max(0.02, Number(url.searchParams.get('scale') ?? 1)));
        const key = `${entry.key}|${version}|${n.id}|${scale}`;
        let png = cache.get(key);
        if (!png) {
          png = renderPng(doc, n, { scale, maxSize: 8192 }).png;
          cache.set(key, png);
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' });
        res.end(png);
        return;
      }
      const route = routes[url.pathname];
      if (!route) throw new HttpError(404, 'not found');
      const body = JSON.stringify(route(url));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  const listen = server.listen.bind(server);
  // Force the bind address: the viewer must never be reachable from other machines.
  (server as any).listen = (port?: number, cb?: () => void) => listen(port ?? opts.port ?? 3846, host, cb);
  return server;
}

/**
 * Topmost visible node under a page point. Without `deep`, stops at the children of top-level
 * frames (like Figma's default click); with `deep`, returns the deepest node (Ctrl/Cmd-click).
 */
export function hitTest(page: SceneNode, x: number, y: number, deep: boolean): SceneNode | undefined {
  const inside = (n: SceneNode) => {
    const b = n.absoluteBoundingBox;
    return x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height;
  };
  const visit = (n: SceneNode, depth: number): SceneNode | undefined => {
    const kids = n.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i]!;
      if (!c.visible || c.data.mask) continue;
      const clips =
        ['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET', 'SECTION'].includes(c.type) &&
        c.data.frameMaskDisabled !== true;
      if (clips && !inside(c)) continue;
      const canDescend =
        c.figType !== 'BOOLEAN_OPERATION' &&
        (deep || depth < 1 || c.type === 'GROUP' || c.type === 'SECTION');
      const inner = canDescend ? visit(c, depth + 1) : undefined;
      if (inner) return inner;
      if (inside(c)) return c;
    }
    return undefined;
  };
  return visit(page, 0);
}
