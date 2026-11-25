import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

/** Random-access byte source, so large .fig files can be read lazily. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
  close?(): void;
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => {
      if (offset < 0 || offset + length > bytes.length) throw new RangeError('read out of bounds');
      return bytes.subarray(offset, offset + length);
    },
  };
}

/** Thrown when a file changed on disk after it was opened (another program saved it). */
export class FileChangedError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on disk while it was being read; open it again`);
    this.name = 'FileChangedError';
  }
}

/**
 * Reads from a file on demand. The file is opened only for the duration of each read, so no
 * handle stays open: on Windows an open handle would stop other programs (and other Figtional
 * processes, such as an MCP server next to the viewer) from replacing the file when they save.
 * Every read checks that the file still has the size and modification time it had when the
 * source was created, and throws FileChangedError otherwise, so stale offsets are never used.
 */
export function fileSource(path: string): ByteSource {
  const st = statSync(path);
  const size = st.size;
  const mtimeMs = st.mtimeMs;
  let closed = false;
  return {
    size,
    read: (offset, length) => {
      if (closed) throw new Error('fileSource is closed');
      if (offset < 0 || offset + length > size) throw new RangeError('read out of bounds');
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileChangedError(path);
        throw e;
      }
      try {
        const now = fstatSync(fd);
        if (now.size !== size || now.mtimeMs !== mtimeMs) throw new FileChangedError(path);
        const out = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const n = readSync(fd, out, done, length - done, offset + done);
          if (n === 0) throw new Error('unexpected end of file');
          done += n;
        }
        return out;
      } finally {
        closeSync(fd);
      }
    },
    close: () => {
      closed = true;
    },
  };
}

export const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error(`invalid hex string: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
