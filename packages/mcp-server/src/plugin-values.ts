/** Pure helpers of the Plugin API layer: paint/effect conversion, keys, lookups, colours. */
import { createHash } from 'node:crypto';
import { type NodeChange, guidToString } from '@figtional/fig-format';
import { type FigDocument, normalizeNodeId, resolveVariable } from '@figtional/fig-model';
import { imageInfo } from './image-size.js';
import { FigtionalUnsupported } from './unsupported.js';
export const MIXED = Symbol('figma.mixed');

export const clamp01 = (v: unknown, path: string) => {
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1)
    throw new Error(`Property value out of range at ${path}`);
  return v;
};

export function checkKeys(obj: Record<string, unknown>, allowed: string[], path: string) {
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (bad.length)
    throw new Error(`Unrecognized key(s) in object: ${bad.map((k) => `'${k}'`).join(', ')} at ${path}`);
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const IDENTITY_T = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

// ------------------------------------------------------------------ paints & effects

export function paintToPlugin(doc: FigDocument, p: any): any {
  const base: any = {
    type: p.type,
    visible: p.visible !== false,
    opacity: p.opacity ?? 1,
    blendMode: p.blendMode ?? 'NORMAL',
  };
  if (p.type === 'SOLID') {
    base.color = { r: p.color?.r ?? 0, g: p.color?.g ?? 0, b: p.color?.b ?? 0 };
    const alias = p.colorVar?.value?.alias;
    const v = alias ? doc.resolveVariableRef(alias) : undefined;
    if (v)
      base.boundVariables = { color: { type: 'VARIABLE_ALIAS', id: `VariableID:${guidToString(v.guid)}` } };
  } else if (p.type?.startsWith('GRADIENT')) {
    const t = p.transform ?? IDENTITY_T;
    base.gradientTransform = [
      [t.m00, t.m01, t.m02],
      [t.m10, t.m11, t.m12],
    ];
    base.gradientStops = (p.stops ?? []).map((s: any) => ({ position: s.position, color: { ...s.color } }));
  } else if (p.type === 'IMAGE') {
    base.imageHash = p.image?.hash ? Buffer.from(p.image.hash).toString('hex') : null;
    base.scaleMode = { STRETCH: 'CROP' }[p.imageScaleMode as string] ?? p.imageScaleMode ?? 'FILL';
    if (p.transform && base.scaleMode === 'CROP') {
      const t = p.transform;
      base.imageTransform = [
        [t.m00, t.m01, t.m02],
        [t.m10, t.m11, t.m12],
      ];
    }
    base.scalingFactor = p.scale ?? 0.5;
  }
  return base;
}

export function paintFromPlugin(doc: FigDocument, p: any, path: string): any {
  if (!p || typeof p !== 'object') throw new Error(`Expected a Paint object at ${path}`);
  const common = ['type', 'visible', 'opacity', 'blendMode', 'boundVariables'];
  const out: any = {
    type: p.type,
    opacity: p.opacity ?? 1,
    visible: p.visible !== false,
    blendMode: p.blendMode ?? 'NORMAL',
  };
  if (p.opacity !== undefined) clamp01(p.opacity, `${path}.opacity`);
  if (p.type === 'SOLID') {
    checkKeys(p, [...common, 'color'], path);
    if (!p.color) throw new Error(`Required value missing at ${path}.color`);
    checkKeys(p.color, ['r', 'g', 'b'], `${path}.color`);
    const color = {
      r: clamp01(p.color.r, `${path}.color.r`),
      g: clamp01(p.color.g, `${path}.color.g`),
      b: clamp01(p.color.b, `${path}.color.b`),
      a: 1,
    };
    out.color = color;
    const id = p.boundVariables?.color?.id;
    if (id) {
      const v = variableById(doc, id);
      if (!v) throw new Error(`Variable ${id} not found`);
      out.colorVar = {
        value: {
          alias: v.key && v.sourceLibraryKey ? { assetRef: { key: v.key } } : { guid: { ...v.guid } },
        },
        dataType: 'ALIAS',
        resolvedDataType: 'COLOR',
      };
      const val = resolveVariable(doc, v);
      if (val && typeof val === 'object' && 'r' in val) out.color = { ...val, a: 1 };
    }
  } else if (p.type?.startsWith('GRADIENT_')) {
    checkKeys(p, [...common, 'gradientTransform', 'gradientStops'], path);
    const t = p.gradientTransform ?? [
      [1, 0, 0],
      [0, 1, 0],
    ];
    out.transform = { m00: t[0][0], m01: t[0][1], m02: t[0][2], m10: t[1][0], m11: t[1][1], m12: t[1][2] };
    out.stops = (p.gradientStops ?? []).map((s: any, i: number) => {
      checkKeys(s.color ?? {}, ['r', 'g', 'b', 'a'], `${path}.gradientStops[${i}].color`);
      return {
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a ?? 1 },
        position: clamp01(s.position, `${path}.gradientStops[${i}].position`),
      };
    });
  } else if (p.type === 'IMAGE') {
    checkKeys(
      p,
      [...common, 'imageHash', 'scaleMode', 'imageTransform', 'scalingFactor', 'rotation', 'filters'],
      path,
    );
    if (!p.imageHash || !/^[0-9a-f]{40}$/i.test(p.imageHash)) throw new Error(`Invalid imageHash at ${path}`);
    if (!doc.archive?.image(p.imageHash)) {
      throw new FigtionalUnsupported(
        'using an image that is not in this file',
        'Only images already in the .fig file can be reused (copy an existing imageHash).',
      );
    }
    const hash = Uint8Array.from(Buffer.from(p.imageHash, 'hex'));
    out.image = { hash, name: 'image' };
    out.imageThumbnail = { hash, name: 'image' };
    out.imageScaleMode = { CROP: 'STRETCH' }[p.scaleMode as string] ?? p.scaleMode ?? 'FILL';
    if (p.imageTransform) {
      const t = p.imageTransform;
      out.transform = { m00: t[0][0], m01: t[0][1], m02: t[0][2], m10: t[1][0], m11: t[1][1], m12: t[1][2] };
    }
    out.scale = p.scalingFactor ?? 0.5;
    out.rotation = p.rotation ?? 0;
    const info = imageInfo(doc.archive!.image(p.imageHash)!);
    if (info) {
      out.originalImageWidth = info.width;
      out.originalImageHeight = info.height;
    }
  } else {
    throw new Error(`Invalid paint type "${p.type}" at ${path}`);
  }
  return out;
}

/** The file stores the Plugin API's LAYER_BLUR as FOREGROUND_BLUR (EffectType in the schema). */
export const EFFECT_TYPE_TO_FILE: Record<string, string> = { LAYER_BLUR: 'FOREGROUND_BLUR' };
export const EFFECT_TYPE_TO_PLUGIN: Record<string, string> = { FOREGROUND_BLUR: 'LAYER_BLUR' };

/**
 * A component's or set's key, as importComponentByKeyAsync uses it: the library key when it has
 * one, else a stable key derived from its guid (Figma also gives unpublished components a key).
 */
export function componentKeyOf(n: NodeChange): string {
  return (
    n.componentKey ||
    n.key ||
    createHash('sha1')
      .update(`figtional-component:${guidToString(n.guid)}`)
      .digest('hex')
  );
}

export function effectToPlugin(e: any): any {
  const out: any = {
    type: EFFECT_TYPE_TO_PLUGIN[e.type] ?? e.type,
    visible: e.visible !== false,
    radius: e.radius ?? 0,
  };
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
    out.color = { ...(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }) };
    out.offset = { ...(e.offset ?? { x: 0, y: 0 }) };
    out.spread = e.spread ?? 0;
    out.blendMode = e.blendMode ?? 'NORMAL';
    if (e.type === 'DROP_SHADOW') out.showShadowBehindNode = e.showShadowBehindNode === true;
  }
  return out;
}

export function effectFromPlugin(e: any, path: string): any {
  if (!['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'].includes(e?.type))
    throw new Error(`Invalid effect type at ${path}`);
  const out: any = {
    type: EFFECT_TYPE_TO_FILE[e.type] ?? e.type,
    visible: e.visible !== false,
    radius: e.radius ?? 0,
  };
  if (e.type.endsWith('SHADOW')) {
    out.color = { r: e.color?.r ?? 0, g: e.color?.g ?? 0, b: e.color?.b ?? 0, a: e.color?.a ?? 1 };
    out.offset = { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0 };
    out.spread = e.spread ?? 0;
    out.blendMode = e.blendMode ?? 'NORMAL';
    if (e.type === 'DROP_SHADOW') out.showShadowBehindNode = e.showShadowBehindNode === true;
  }
  return out;
}

// ------------------------------------------------------------------ variables

export function variableById(doc: FigDocument, id: string): NodeChange | undefined {
  const m = /^VariableID:(.+)$/.exec(id);
  const raw = m ? m[1]! : id;
  const norm = normalizeNodeId(raw.replace(/\//g, ':'));
  const v = norm ? doc.nodes.get(norm) : undefined;
  if (v?.type === 'VARIABLE') return v;
  return doc.getByKey(raw)?.type === 'VARIABLE' ? doc.getByKey(raw) : undefined;
}

export function collectionById(doc: FigDocument, id: string): NodeChange | undefined {
  const m = /^VariableCollectionId:(.+)$/.exec(id);
  const norm = normalizeNodeId(m ? m[1]! : id);
  const c = norm ? doc.nodes.get(norm) : undefined;
  return c?.type === 'VARIABLE_SET' ? c : undefined;
}

export const FIELD_TO_VARIABLE: Record<string, string> = {
  width: 'WIDTH',
  height: 'HEIGHT',
  itemSpacing: 'STACK_SPACING',
  counterAxisSpacing: 'STACK_COUNTER_SPACING',
  paddingLeft: 'STACK_PADDING_LEFT',
  paddingRight: 'STACK_PADDING_RIGHT',
  paddingTop: 'STACK_PADDING_TOP',
  paddingBottom: 'STACK_PADDING_BOTTOM',
  cornerRadius: 'CORNER_RADIUS',
  topLeftRadius: 'RECTANGLE_TOP_LEFT_CORNER_RADIUS',
  topRightRadius: 'RECTANGLE_TOP_RIGHT_CORNER_RADIUS',
  bottomLeftRadius: 'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS',
  bottomRightRadius: 'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS',
  strokeWeight: 'STROKE_WEIGHT',
  opacity: 'OPACITY',
  visible: 'VISIBLE',
  characters: 'TEXT_DATA',
  minWidth: 'MIN_WIDTH',
  maxWidth: 'MAX_WIDTH',
  minHeight: 'MIN_HEIGHT',
  maxHeight: 'MAX_HEIGHT',
  fontSize: 'FONT_SIZE',
  fontFamily: 'FONT_FAMILY',
  fontStyle: 'FONT_STYLE',
  letterSpacing: 'LETTER_SPACING',
  lineHeight: 'LINE_HEIGHT',
};

export function parseColor(input: any, alpha: boolean) {
  if (typeof input === 'object') return alpha ? { a: 1, ...input } : { r: input.r, g: input.g, b: input.b };
  const s = String(input).trim();
  let m = /^#?([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    const c = { r: n(0), g: n(2), b: n(4) };
    return alpha ? { ...c, a: h.length === 8 ? n(6) : 1 } : c;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const [r, g, b, a] = m[1]!.split(',').map((x) => parseFloat(x));
    const c = { r: r! / 255, g: g! / 255, b: b! / 255 };
    return alpha ? { ...c, a: a ?? 1 } : c;
  }
  throw new Error(`Invalid color "${input}"`);
}
