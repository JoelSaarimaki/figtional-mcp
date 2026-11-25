import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileChangedError, fileSource } from './bytes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'figtional-bytes-'));
  dirs.push(d);
  return d;
};

describe('fileSource', () => {
  it('reads lazily without keeping the file open, so other processes can replace it', () => {
    const d = tmp();
    const path = join(d, 'a.fig');
    writeFileSync(path, Buffer.from('0123456789'));
    const src = fileSource(path);
    expect(Buffer.from(src.read(2, 3)).toString()).toBe('234');
    // Replacing the file must work while the source exists (fails on Windows with an open handle).
    const next = join(d, 'b.tmp');
    writeFileSync(next, Buffer.from('abcdefghijklmnop'));
    expect(() => renameSync(next, path)).not.toThrow();
    // ...and the old source notices instead of reading the new file at old offsets.
    expect(() => src.read(0, 2)).toThrow(FileChangedError);
  });

  it('notices same-size changes by modification time, and deletion', () => {
    const d = tmp();
    const path = join(d, 'a.fig');
    writeFileSync(path, Buffer.from('0123456789'));
    const src = fileSource(path);
    writeFileSync(path, Buffer.from('9876543210'));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(() => src.read(0, 1)).toThrow(FileChangedError);
    const src2 = fileSource(path);
    rmSync(path);
    expect(() => src2.read(0, 1)).toThrow(FileChangedError);
  });
});
