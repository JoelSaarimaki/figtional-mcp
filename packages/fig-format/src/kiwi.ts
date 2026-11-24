import { createRequire } from 'node:module';
import type * as KiwiTypes from 'kiwi-schema';

// kiwi-schema ships CommonJS without an `exports` map; load it via require for reliable interop.
const require = createRequire(import.meta.url);
const kiwi = require('kiwi-schema') as typeof KiwiTypes;

export type KiwiSchema = KiwiTypes.Schema;

export interface CompiledKiwi {
  decodeMessage(bytes: Uint8Array): any;
  /** Encodes a `Message`, preserving the field order of each object (see OrderedEncoder). */
  encodeMessage(message: any): Uint8Array;
  [k: string]: any;
}

export function decodeSchema(bytes: Uint8Array): KiwiSchema {
  return kiwi.decodeBinarySchema(bytes);
}

export function encodeSchema(schema: KiwiSchema): Uint8Array {
  return kiwi.encodeBinarySchema(schema);
}

/**
 * Compiles the schema with kiwi's decoder, but swaps in an encoder that writes message fields
 * in the order of the object's own keys instead of schema order. kiwi's decoder assigns fields
 * in wire order, so an unmodified message re-encodes byte-for-byte as Figma wrote it, and new
 * fields are appended (kiwi allows message fields in any order).
 */
export function compileSchema(schema: KiwiSchema): CompiledKiwi {
  const compiled = kiwi.compileSchema(schema) as CompiledKiwi;
  const encoder = new OrderedEncoder(schema);
  compiled.encodeMessage = (message: any) => encoder.encode('Message', message);
  return compiled;
}

interface FieldInfo {
  name: string;
  type: string;
  isArray: boolean;
  isDeprecated: boolean;
  value: number;
}

interface DefInfo {
  kind: 'ENUM' | 'STRUCT' | 'MESSAGE';
  fields: FieldInfo[];
  byName: Map<string, FieldInfo>;
  enumValues?: Map<string, number>;
}

export class OrderedEncoder {
  private readonly defs = new Map<string, DefInfo>();

  constructor(schema: KiwiSchema) {
    for (const d of schema.definitions) {
      const fields = d.fields.map((f) => ({
        name: f.name,
        type: f.type ?? '',
        isArray: f.isArray,
        isDeprecated: f.isDeprecated,
        value: f.value,
      }));
      const info: DefInfo = { kind: d.kind, fields, byName: new Map(fields.map((f) => [f.name, f])) };
      if (d.kind === 'ENUM') info.enumValues = new Map(fields.map((f) => [f.name, f.value]));
      this.defs.set(d.name, info);
    }
  }

  encode(typeName: string, value: any): Uint8Array {
    const bb = new kiwi.ByteBuffer();
    this.writeDef(bb, typeName, value);
    return bb.toUint8Array();
  }

  private writeDef(bb: KiwiTypes.ByteBuffer, typeName: string, value: any): void {
    const def = this.defs.get(typeName);
    if (!def) throw new Error(`unknown kiwi type ${typeName}`);
    if (def.kind === 'STRUCT') {
      for (const f of def.fields) {
        if (f.isDeprecated) continue;
        const v = value[f.name];
        if (v == null) throw new Error(`missing required field ${typeName}.${f.name}`);
        this.writeField(bb, f, v);
      }
      return;
    }
    if (def.kind !== 'MESSAGE') throw new Error(`cannot encode ${def.kind} ${typeName} as a value`);
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v == null) continue;
      const f = def.byName.get(key);
      if (!f) throw new Error(`unknown field ${typeName}.${key}`);
      if (f.isDeprecated) continue;
      bb.writeVarUint(f.value);
      this.writeField(bb, f, v);
    }
    bb.writeVarUint(0);
  }

  private writeField(bb: KiwiTypes.ByteBuffer, f: FieldInfo, v: any): void {
    if (f.isArray) {
      if (f.type === 'byte') {
        bb.writeByteArray(v);
        return;
      }
      bb.writeVarUint(v.length);
      for (const item of v) this.writeScalar(bb, f.type, item, f.name);
      return;
    }
    this.writeScalar(bb, f.type, v, f.name);
  }

  private writeScalar(bb: KiwiTypes.ByteBuffer, type: string, v: any, fieldName: string): void {
    switch (type) {
      case 'bool':
        bb.writeByte(v ? 1 : 0);
        return;
      case 'byte':
        bb.writeByte(v);
        return;
      case 'int':
        bb.writeVarInt(v);
        return;
      case 'uint':
        bb.writeVarUint(v);
        return;
      case 'float':
        bb.writeVarFloat(v);
        return;
      case 'string':
        bb.writeString(v);
        return;
      case 'int64':
        (bb as any).writeVarInt64(v);
        return;
      case 'uint64':
        (bb as any).writeVarUint64(v);
        return;
    }
    const def = this.defs.get(type);
    if (!def) throw new Error(`unknown kiwi type ${type} for field ${fieldName}`);
    if (def.kind === 'ENUM') {
      const n = def.enumValues!.get(v);
      if (n === undefined)
        throw new Error(`invalid value ${JSON.stringify(v)} for enum ${type} (field ${fieldName})`);
      bb.writeVarUint(n);
      return;
    }
    this.writeDef(bb, type, v);
  }
}
