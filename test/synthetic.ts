/**
 * Builds small synthetic .fig archives for committed tests. The schema is a tiny subset of
 * Figma's (same field names), compiled from kiwi text, so these files exercise the same code paths
 * without depending on real Figma exports.
 */
import { createRequire } from 'node:module';
import { deflateRawSync, zstdCompressSync } from 'node:zlib';
import {
  METHOD_DEFLATE,
  METHOD_STORED,
  serializeFigKiwi,
  writeZip,
  type Message,
} from '@figtional/fig-format';

const require = createRequire(import.meta.url);
const kiwi = require('kiwi-schema');

export const SYNTHETIC_SCHEMA = `
enum MessageType { NODE_CHANGES = 1; }
enum NodeType { DOCUMENT = 1; CANVAS = 2; FRAME = 3; TEXT = 4; ROUNDED_RECTANGLE = 5; SYMBOL = 6; INSTANCE = 7; VARIABLE_SET = 8; VARIABLE = 9; }
enum NodePhase { CREATED = 0; REMOVED = 1; }
enum PaintType { SOLID = 0; IMAGE = 1; }
struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Image { byte[] hash = 1; string name = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; Image image = 5; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message TextData { string characters = 1; }
message SymbolData { GUID symbolID = 1; }
message NodeChange {
  GUID guid = 1; NodePhase phase = 2; ParentIndex parentIndex = 3; NodeType type = 4; string name = 5;
  bool visible = 6; float opacity = 7; Vector size = 8; Matrix transform = 9; Paint[] fillPaints = 10;
  float fontSize = 11; FontName fontName = 12; TextData textData = 13; Color backgroundColor = 14;
  bool internalOnly = 15; SymbolData symbolData = 16; string unknownFutureField = 17;
}
message Blob { byte[] bytes = 1; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
`;

const I = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const at = (x: number, y: number) => ({ ...I, m02: x, m12: y });
const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const parent = (s: number, l: number, position: string) => ({ guid: g(s, l), position });

export const IMAGE_HASH = 'aa'.repeat(20);

export function syntheticMessage(): Message {
  return {
    type: 'NODE_CHANGES',
    nodeChanges: [
      { guid: g(0, 0), phase: 'CREATED', type: 'DOCUMENT', name: 'Document', visible: true, opacity: 1 },
      {
        guid: g(0, 1),
        phase: 'CREATED',
        type: 'CANVAS',
        name: 'Page 1',
        parentIndex: parent(0, 0, '!'),
        backgroundColor: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
      },
      {
        guid: g(0, 2),
        phase: 'CREATED',
        type: 'CANVAS',
        name: 'Internal Only Canvas',
        parentIndex: parent(0, 0, '~'),
        internalOnly: true,
      },
      {
        guid: g(1, 2),
        phase: 'CREATED',
        type: 'FRAME',
        name: 'Screen',
        parentIndex: parent(0, 1, '!'),
        size: { x: 390, y: 800 },
        transform: at(0, 0),
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
      },
      {
        guid: g(1, 4),
        phase: 'CREATED',
        type: 'TEXT',
        name: 'Title',
        parentIndex: parent(1, 2, '"'), // sorts after "!" → second child
        size: { x: 200, y: 30 },
        transform: at(20, 100),
        fontSize: 24,
        fontName: { family: 'Inter', style: 'Bold', postscript: 'Inter-Bold' },
        textData: { characters: 'Hello' },
        unknownFutureField: 'keep me',
      },
      {
        guid: g(1, 3),
        phase: 'CREATED',
        type: 'ROUNDED_RECTANGLE',
        name: 'Photo',
        parentIndex: parent(1, 2, '!'),
        size: { x: 100, y: 50 },
        transform: at(20, 20),
        fillPaints: [
          {
            type: 'IMAGE',
            opacity: 1,
            visible: true,
            image: { hash: new Uint8Array(20).fill(0xaa), name: 'p' },
          },
        ],
      },
      {
        guid: g(1, 5),
        phase: 'CREATED',
        type: 'FRAME',
        name: 'Hidden',
        parentIndex: parent(0, 1, '#'),
        visible: false,
        size: { x: 10, y: 10 },
        transform: at(500, 0),
      },
    ],
    blobs: [],
  };
}

export interface SyntheticOptions {
  compression?: 'zstd' | 'deflate-raw';
  message?: Message;
  fileName?: string;
}

/** Returns the bytes of a complete synthetic .fig archive. */
export function syntheticFig(opts: SyntheticOptions = {}): Uint8Array {
  const schema = kiwi.parseSchema(SYNTHETIC_SCHEMA);
  const compiled = kiwi.compileSchema(schema);
  const schemaBytes: Uint8Array = kiwi.encodeBinarySchema(schema);
  const msgBytes: Uint8Array = compiled.encodeMessage(opts.message ?? syntheticMessage());
  const msgChunk =
    (opts.compression ?? 'zstd') === 'zstd' ? zstdCompressSync(msgBytes) : deflateRawSync(msgBytes);
  const canvas = serializeFigKiwi({
    magic: 'fig-kiwi',
    version: 106,
    chunks: [new Uint8Array(deflateRawSync(schemaBytes)), new Uint8Array(msgChunk)],
  });
  const meta = {
    client_meta: {
      background_color: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
      thumbnail_size: { width: 4, height: 4 },
    },
    file_name: opts.fileName ?? 'Synthetic',
    developer_related_links: [],
    exported_at: '2026-11-24T00:00:00.000Z',
  };
  const parts: Uint8Array[] = [];
  writeZip(
    [
      { name: 'canvas.fig', data: canvas, method: METHOD_STORED },
      { name: 'thumbnail.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), method: METHOD_STORED },
      { name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta)), method: METHOD_DEFLATE },
      { name: 'images/', data: new Uint8Array(0) },
      { name: `images/${IMAGE_HASH}`, data: new Uint8Array([1, 2, 3, 4]) },
    ],
    { write: (b) => parts.push(b) },
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
