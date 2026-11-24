/**
 * Local asset server for get_design_context, like Figma's desktop MCP server
 * (http://localhost:3845/assets/<hash>.<ext>). It serves only assets registered while generating
 * design context for files in the session's scope: image fills (by hash) and vector exports (SVG).
 * Binds to 127.0.0.1; refuses foreign Host headers.
 */
import { createHash } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

type Asset = { type: string; load: () => Buffer | Uint8Array | string };

export class AssetServer {
  private assets = new Map<string, Asset>();
  private server: Server | undefined;
  private starting: Promise<number> | undefined;
  private port = 0;

  constructor(private readonly preferredPort = 3845) {}

  /** Registers an asset; returns its path (e.g. "/assets/abc.png"). Idempotent per id. */
  register(id: string, ext: string, type: string, load: Asset['load']): string {
    const name = `${createHash('sha1').update(id).digest('hex')}.${ext}`;
    if (!this.assets.has(name)) this.assets.set(name, { type, load });
    return `/assets/${name}`;
  }

  /** Starts the server if needed; returns the base URL. */
  async baseUrl(): Promise<string> {
    const port = await this.start();
    return `http://localhost:${port}`;
  }

  private start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port);
    if (!this.starting) {
      this.starting = new Promise<number>((resolve, reject) => {
        const server = createServer((req, res) => {
          const host = (req.headers.host ?? '').replace(/:\d+$/, '');
          if (!['localhost', '127.0.0.1', '[::1]'].includes(host) || req.method !== 'GET') {
            res.writeHead(403).end();
            return;
          }
          const name = (req.url ?? '').replace(/^\/assets\//, '').replace(/\?.*$/, '');
          const asset = this.assets.get(name);
          if (!asset) {
            res.writeHead(404).end('asset not found');
            return;
          }
          try {
            const body = asset.load();
            res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
            res.end(body);
          } catch (e) {
            res.writeHead(500).end(String((e as Error).message));
          }
        });
        const listen = (port: number) => {
          server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE' && port !== 0) listen(0);
            else reject(err);
          });
          server.listen(port, '127.0.0.1', () => {
            this.port = (server.address() as AddressInfo).port;
            this.server = server;
            resolve(this.port);
          });
        };
        listen(this.preferredPort);
        server.unref();
      });
    }
    return this.starting;
  }

  close(): void {
    this.server?.close();
  }
}
