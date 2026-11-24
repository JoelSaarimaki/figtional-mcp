import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMAGE_HASH, syntheticFig } from '../../../test/synthetic.js';
import { REF, SMALL_REFS, hasRef } from '../../../test/references.js';
import {
  FigArchive,
  ZipReader,
  bufferSource,
  decodePathCommands,
  decodeVectorNetwork,
  encodeCanvas,
  encodePathCommands,
  encodeVectorNetwork,
  guidToString,
  parseFigKiwi,
  decompressChunk,
  saveFigArchive,
  writeFigArchiveToBytes,
} from './index.js';

// toEqual on multi-megabyte typed arrays is very slow; compare natively.
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe('synthetic archive', () => {
  for (const compression of ['zstd', 'deflate-raw'] as const) {
    it(`decodes and round-trips (${compression})`, () => {
      const fig = FigArchive.fromBytes(syntheticFig({ compression }));
      expect(fig.meta().file_name).toBe('Synthetic');
      expect(fig.imageHashes()).toEqual([IMAGE_HASH]);
      expect(fig.image(IMAGE_HASH)).toEqual(new Uint8Array([1, 2, 3, 4]));

      const canvas = fig.decodeCanvas();
      expect(canvas.version).toBe(106);
      expect(canvas.messageCompression).toBe(compression);
      expect(canvas.message.nodeChanges.map((n) => guidToString(n.guid))).toContain('1:4');
      const text = canvas.message.nodeChanges.find((n) => n.type === 'TEXT')!;
      expect(text.unknownFutureField).toBe('keep me');

      const out = writeFigArchiveToBytes(fig, { canvas: encodeCanvas(canvas) });
      const again = FigArchive.fromBytes(out);
      const c2 = again.decodeCanvas();
      expect(c2.messageBytes).toEqual(canvas.messageBytes);
      expect(c2.schemaChunk).toEqual(canvas.schemaChunk);
      expect(again.meta()).toEqual(fig.meta());
      expect(again.image(IMAGE_HASH)).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(again.zip.entries.map((e) => e.name)).toEqual(fig.zip.entries.map((e) => e.name));
    });
  }

  it('rejects non-Figma zips and non-zips', () => {
    expect(() => FigArchive.fromBytes(new Uint8Array([1, 2, 3]))).toThrow(/zip/);
  });

  it('saves atomically with a backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'figtional-'));
    try {
      const path = join(dir, 'a.fig');
      writeFileSync(path, syntheticFig());
      const before = readFileSync(path);
      const fig = FigArchive.open(path);
      const canvas = fig.decodeCanvas();
      canvas.message.nodeChanges.find((n) => n.type === 'TEXT')!.textData.characters = 'Changed';
      const res = saveFigArchive(fig, path, { canvas: encodeCanvas(canvas) });
      expect(res.backupPath).toBe(`${path}.bak`);
      expect(readFileSync(res.backupPath!)).toEqual(before);
      const reopened = FigArchive.open(path);
      const text = reopened.decodeCanvas().message.nodeChanges.find((n) => n.type === 'TEXT')!;
      expect(text.textData.characters).toBe('Changed');
      reopened.close();
      expect(existsSync(join(dir, `.a.fig.${process.pid}`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('blob codecs', () => {
  it('round-trips path commands', () => {
    const cmds = [
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'Q', x1: 10, y1: 5, x: 5, y: 10 },
      { type: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 0, y: 0 },
      { type: 'Z' },
    ] as const;
    expect(decodePathCommands(encodePathCommands([...cmds]))).toEqual(cmds);
  });

  it('round-trips vector networks', () => {
    const net = {
      vertices: [
        { styleID: 0, x: 0, y: 0 },
        { styleID: 0, x: 10, y: 0 },
        { styleID: 0, x: 0, y: 10 },
      ],
      segments: [
        { styleID: 0, start: 0, tangentStart: { x: 0, y: 0 }, end: 1, tangentEnd: { x: 0, y: 0 } },
        { styleID: 0, start: 1, tangentStart: { x: 0, y: 0 }, end: 2, tangentEnd: { x: 0, y: 0 } },
        { styleID: 0, start: 2, tangentStart: { x: 0, y: 0 }, end: 0, tangentEnd: { x: 0, y: 0 } },
      ],
      regions: [{ styleID: 0, windingRule: 'NONZERO' as const, loops: [[0, 1, 2]] }],
    };
    expect(decodeVectorNetwork(encodeVectorNetwork(net))).toEqual(net);
  });
});

describe.each(SMALL_REFS)('reference file %s', (name) => {
  it.skipIf(!hasRef(name))('round-trips the message byte-for-byte and decodes all blobs', () => {
    const fig = FigArchive.open(REF[name]);
    try {
      const canvas = fig.decodeCanvas();
      expect(canvas.magic).toBe('fig-kiwi');
      expect(canvas.message.type).toBe('NODE_CHANGES');

      // Re-encoding with the embedded schema reproduces the original message bytes.
      const reencoded = canvas.compiled.encodeMessage(canvas.message);
      expect(sameBytes(reencoded, canvas.messageBytes)).toBe(true);

      // A full archive write keeps the schema chunk and every entry.
      const out = writeFigArchiveToBytes(fig, { canvas: encodeCanvas(canvas) });
      const zip = new ZipReader(bufferSource(out));
      expect(zip.entries.map((e) => e.name)).toEqual(fig.zip.entries.map((e) => e.name));
      const container = parseFigKiwi(zip.read('canvas.fig'));
      expect(sameBytes(container.chunks[0]!, canvas.schemaChunk)).toBe(true);
      expect(sameBytes(decompressChunk(container.chunks[1]!).data, canvas.messageBytes)).toBe(true);

      // Every geometry blob decodes.
      const blobs = canvas.message.blobs ?? [];
      for (const n of canvas.message.nodeChanges) {
        for (const geo of [...(n.fillGeometry ?? []), ...(n.strokeGeometry ?? [])]) {
          expect(() => decodePathCommands(blobs[geo.commandsBlob]!.bytes)).not.toThrow();
        }
        if (n.vectorData?.vectorNetworkBlob !== undefined) {
          expect(() => decodeVectorNetwork(blobs[n.vectorData.vectorNetworkBlob]!.bytes)).not.toThrow();
        }
        for (const glyph of n.derivedTextData?.glyphs ?? []) {
          if (glyph.commandsBlob !== undefined) {
            expect(() => decodePathCommands(blobs[glyph.commandsBlob]!.bytes)).not.toThrow();
          }
        }
      }
    } finally {
      fig.close();
    }
  });
});
