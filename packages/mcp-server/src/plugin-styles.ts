/**
 * Styles in the Plugin API (PaintStyle, TextStyle, EffectStyle, GridStyle) and applying them to
 * nodes, written the way Figma stores them (docs/fig-format.md §4.12):
 *
 * - A style is a hidden, locked node on the internal page with `styleType`: fill and effect styles
 *   are ROUNDED_RECTANGLEs (effect styles *assumed*, no reference file has one), text styles are
 *   TEXT nodes with the sample text "Rag 123", grid styles are FRAMEs.
 * - Nodes refer to a style with `styleIdForFill` / `…StrokeFill` / `…Text` / `…Effect` / `…Grid`:
 *   `{ guid }` for unpublished local styles, `{ assetRef: { key, version } }` for styles with a key
 *   (published or library). They also keep the style's values inline, so Figtional copies them on
 *   apply and when a style changes; setting a value directly on a node detaches the style.
 */
import { createHash } from 'node:crypto';
import { type NodeChange, guidToString } from '@figtional/fig-format';
import type { EditSession, FigDocument } from '@figtional/fig-model';
import { FigtionalUnsupported } from './unsupported.js';

export type StyleType = 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';

const FIG_STYLE_TYPE: Record<StyleType, string> = {
  PAINT: 'FILL',
  TEXT: 'TEXT',
  EFFECT: 'EFFECT',
  GRID: 'GRID',
};
const API_STYLE_TYPE: Record<string, StyleType> = {
  FILL: 'PAINT',
  TEXT: 'TEXT',
  EFFECT: 'EFFECT',
  GRID: 'GRID',
};

/** Style reference fields on nodes → the style type and the inline value fields they control. */
export const STYLE_REF_FIELDS: Record<string, { type: StyleType; values: string[] }> = {
  styleIdForFill: { type: 'PAINT', values: ['fillPaints'] },
  styleIdForStrokeFill: { type: 'PAINT', values: ['strokePaints'] },
  styleIdForEffect: { type: 'EFFECT', values: ['effects'] },
  styleIdForGrid: { type: 'GRID', values: ['layoutGrids'] },
  styleIdForText: {
    type: 'TEXT',
    values: [
      'fontName',
      'fontSize',
      'lineHeight',
      'letterSpacing',
      'textCase',
      'textDecoration',
      'paragraphSpacing',
      'paragraphIndent',
    ],
  },
};

/** The field of a style node that holds a value controlled by a reference field. */
const styleValueField = (refField: string, valueField: string) =>
  refField === 'styleIdForStrokeFill' ? 'fillPaints' : valueField;

export interface StyleDeps {
  doc: FigDocument;
  session: EditSession;
  paintToPlugin: (p: any) => any;
  paintFromPlugin: (p: any, path: string) => any;
  effectToPlugin: (e: any) => any;
  effectFromPlugin: (e: any, path: string) => any;
  isFontLoaded: (f: { family: string; style: string }) => boolean;
}

export const isStyle = (n: NodeChange | undefined): n is NodeChange =>
  !!n && !!n.styleType && n.styleType !== 'NONE' && !!API_STYLE_TYPE[n.styleType];

/** Key as the Plugin API reports it: the stored key, or a stable one derived from the guid. */
export function styleKey(s: NodeChange): string {
  return (
    s.key ||
    createHash('sha1')
      .update(`figtional-style:${guidToString(s.guid)}`)
      .digest('hex')
  );
}

/** Style id in Figma's format: `S:<key>,<node id>`. */
export function styleId(s: NodeChange): string {
  return `S:${styleKey(s)},${guidToString(s.guid)}`;
}

/** Finds a style by Plugin API id (`S:key,node`), key, or node id. */
export function findStyle(doc: FigDocument, id: string): NodeChange | undefined {
  const raw = String(id).replace(/^S:/, '');
  const comma = raw.lastIndexOf(',');
  if (comma >= 0) {
    const byNode = doc.nodes.get(raw.slice(comma + 1));
    if (isStyle(byNode)) return byNode;
  }
  const key = comma >= 0 ? raw.slice(0, comma) : raw;
  const byKey = doc.getByKey(key);
  if (isStyle(byKey)) return byKey;
  const byId = doc.nodes.get(key);
  if (isStyle(byId)) return byId;
  return doc.styles.find((s) => isStyle(s) && styleKey(s) === key);
}

/** How a node refers to `s`: by key when it has one (published or library), else by guid. */
export function styleRef(s: NodeChange): any {
  return s.key
    ? { assetRef: { key: s.key, ...(s.version ? { version: s.version } : {}) } }
    : { guid: { ...s.guid } };
}

const sortKey = (s: NodeChange) => s.sortPosition ?? s.parentIndex?.position ?? '';

export function createStyleApi(deps: StyleDeps) {
  const { doc, session } = deps;

  const lineHeightToPlugin = (lh: any) => {
    if (!lh || (lh.units === 'PERCENT' && lh.value === 100)) return { unit: 'AUTO' };
    if (lh.units === 'RAW') return { unit: 'PERCENT', value: lh.value * 100 };
    if (lh.units === 'PIXELS') return { unit: 'PIXELS', value: lh.value };
    return { unit: 'PERCENT', value: lh.value };
  };
  const lineHeightFromPlugin = (v: any) => {
    if (typeof v !== 'object' || !v)
      throw new Error('lineHeight must be an object like { unit: "PIXELS", value: 24 }');
    return v.unit === 'AUTO'
      ? { value: 100, units: 'PERCENT' }
      : v.unit === 'PERCENT'
        ? { value: (v.value ?? 100) / 100, units: 'RAW' }
        : { value: Number(v.value ?? 0), units: 'PIXELS' };
  };

  /** Copies the style's values to every node (and instance override) that uses it. */
  const propagate = (s: NodeChange) => {
    const id = guidToString(s.guid);
    const usesThis = (ref: any) => {
      const target = ref ? doc.resolveStyleRef(ref) : undefined;
      return !!target && guidToString(target.guid) === id;
    };
    const apply = (target: any, refField: string) => {
      for (const v of STYLE_REF_FIELDS[refField]!.values) {
        const src = s[styleValueField(refField, v)];
        if (src === undefined) delete target[v];
        else target[v] = structuredClone(src);
      }
    };
    for (const n of doc.message.nodeChanges) {
      if (n === s) continue;
      let changed = false;
      for (const refField of Object.keys(STYLE_REF_FIELDS)) {
        if (usesThis(n[refField])) {
          apply(n, refField);
          changed = true;
        }
      }
      for (const o of n.symbolData?.symbolOverrides ?? []) {
        for (const refField of Object.keys(STYLE_REF_FIELDS)) {
          if (usesThis(o[refField])) {
            apply(o, refField);
            changed = true;
          }
        }
      }
      if (changed) {
        const nid = guidToString(n.guid);
        if (n.type === 'TEXT') session.markText(nid);
        else session.markDirty(nid);
      }
    }
  };

  const edit = (s: NodeChange, fields: Record<string, unknown>) => {
    const raw = session.raw(guidToString(s.guid));
    Object.assign(raw, fields);
    if (raw.type === 'TEXT') session.markText(guidToString(raw.guid));
    else session.markDirty(guidToString(raw.guid));
    propagate(raw);
  };

  const requireLocal = (s: NodeChange, what: string) => {
    if (s.sourceLibraryKey) throw new Error(`Cannot change ${what} of a style from a library`);
  };
  const requireStyleFonts = (s: NodeChange) => {
    const f = s.fontName ?? { family: 'Inter', style: 'Regular' };
    if (!deps.isFontLoaded(f))
      throw new Error(
        `Cannot use unloaded font "${f.family} ${f.style}". Please call figma.loadFontAsync({ family: "${f.family}", style: "${f.style}" }) and await the returned promise first.`,
      );
  };

  const wrappers = new Map<string, any>();

  const wrap = (s: NodeChange): any => {
    const id = guidToString(s.guid);
    const cached = wrappers.get(id);
    if (cached) return cached;
    const type = API_STYLE_TYPE[s.styleType]!;
    const get = () => doc.nodes.get(id) ?? s;
    const base: any = {
      get id() {
        return styleId(get());
      },
      get type() {
        return type;
      },
      get key() {
        return styleKey(get());
      },
      get name() {
        return get().name ?? '';
      },
      set name(v: string) {
        requireLocal(get(), 'the name');
        session.raw(id).name = String(v);
        session.markDirty(id);
      },
      get description() {
        return get().styleDescription ?? get().description ?? '';
      },
      set description(v: string) {
        requireLocal(get(), 'the description');
        const raw = session.raw(id);
        raw.styleDescription = String(v);
        if (raw.description !== undefined) raw.description = String(v);
        session.markDirty(id);
      },
      get remote() {
        return !!get().sourceLibraryKey;
      },
      get documentationLinks() {
        return [];
      },
      async getPublishStatusAsync() {
        return get().key ? 'CURRENT' : 'UNPUBLISHED';
      },
      async getStyleConsumersAsync() {
        const out: { node: string; fields: string[] }[] = [];
        for (const n of doc.message.nodeChanges) {
          const fields = Object.keys(STYLE_REF_FIELDS).filter((f) => {
            const t = n[f] ? doc.resolveStyleRef(n[f]) : undefined;
            return t && guidToString(t.guid) === id;
          });
          if (fields.length) out.push({ node: guidToString(n.guid), fields });
        }
        return out;
      },
      remove() {
        requireLocal(get(), 'removing');
        // Like Figma: nodes keep the values and lose the link.
        for (const n of doc.message.nodeChanges) {
          for (const f of Object.keys(STYLE_REF_FIELDS)) {
            const t = n[f] ? doc.resolveStyleRef(n[f]) : undefined;
            if (t && guidToString(t.guid) === id) {
              delete n[f];
              session.markDirty(guidToString(n.guid));
            }
          }
        }
        session.remove(id);
        wrappers.delete(id);
      },
      toString() {
        return `[object ${type === 'PAINT' ? 'PaintStyle' : type === 'TEXT' ? 'TextStyle' : type === 'EFFECT' ? 'EffectStyle' : 'GridStyle'}]`;
      },
    };
    if (type === 'PAINT') {
      Object.defineProperty(base, 'paints', {
        enumerable: true,
        get: () => Object.freeze((get().fillPaints ?? []).map((p: any) => deps.paintToPlugin(p))),
        set: (v: any[]) => {
          requireLocal(get(), 'paints');
          if (!Array.isArray(v)) throw new Error('paints must be an array of paints');
          edit(get(), { fillPaints: v.map((p, i) => deps.paintFromPlugin(p, `[${i}]`)) });
        },
      });
    } else if (type === 'EFFECT') {
      Object.defineProperty(base, 'effects', {
        enumerable: true,
        get: () => Object.freeze((get().effects ?? []).map((e: any) => deps.effectToPlugin(e))),
        set: (v: any[]) => {
          requireLocal(get(), 'effects');
          if (!Array.isArray(v)) throw new Error('effects must be an array of effects');
          edit(get(), { effects: v.map((e, i) => deps.effectFromPlugin(e, `[${i}]`)) });
        },
      });
    } else if (type === 'GRID') {
      Object.defineProperty(base, 'layoutGrids', {
        enumerable: true,
        get: () => Object.freeze(structuredClone(get().layoutGrids ?? [])),
        set: () => {
          throw new FigtionalUnsupported('setting GridStyle.layoutGrids');
        },
      });
    } else {
      const textProp = (
        name: string,
        read: (s: NodeChange) => unknown,
        write: (v: any) => Record<string, unknown>,
      ) =>
        Object.defineProperty(base, name, {
          enumerable: true,
          get: () => read(get()),
          set: (v: any) => {
            requireLocal(get(), name);
            requireStyleFonts(get());
            edit(get(), write(v));
          },
        });
      Object.defineProperty(base, 'fontName', {
        enumerable: true,
        get: () => {
          const f = get().fontName ?? { family: 'Inter', style: 'Regular' };
          return { family: f.family, style: f.style };
        },
        set: (v: { family: string; style: string }) => {
          requireLocal(get(), 'fontName');
          if (!v?.family || !v?.style) throw new Error('fontName must be { family, style }');
          if (!deps.isFontLoaded(v))
            throw new Error(
              `Cannot use unloaded font "${v.family} ${v.style}". Please call figma.loadFontAsync({ family: "${v.family}", style: "${v.style}" }) and await the returned promise first.`,
            );
          edit(get(), { fontName: { family: v.family, style: v.style, postscript: '' } });
        },
      });
      textProp(
        'fontSize',
        (s) => s.fontSize ?? 12,
        (v) => ({ fontSize: Number(v) }),
      );
      textProp(
        'lineHeight',
        (s) => lineHeightToPlugin(s.lineHeight),
        (v) => ({ lineHeight: lineHeightFromPlugin(v) }),
      );
      textProp(
        'letterSpacing',
        (s) => {
          const ls = s.letterSpacing ?? { value: 0, units: 'PERCENT' };
          return { unit: ls.units === 'PIXELS' ? 'PIXELS' : 'PERCENT', value: ls.value };
        },
        (v) => {
          if (typeof v !== 'object' || !v)
            throw new Error('letterSpacing must be an object like { unit: "PERCENT", value: 0 }');
          return {
            letterSpacing: { value: Number(v.value), units: v.unit === 'PIXELS' ? 'PIXELS' : 'PERCENT' },
          };
        },
      );
      textProp(
        'textCase',
        (s) => s.textCase ?? 'ORIGINAL',
        (v) => ({ textCase: String(v) }),
      );
      textProp(
        'textDecoration',
        (s) => s.textDecoration ?? 'NONE',
        (v) => ({ textDecoration: String(v) }),
      );
      textProp(
        'paragraphSpacing',
        (s) => s.paragraphSpacing ?? 0,
        (v) => ({ paragraphSpacing: Number(v) }),
      );
      textProp(
        'paragraphIndent',
        (s) => s.paragraphIndent ?? 0,
        (v) => ({ paragraphIndent: Number(v) }),
      );
    }
    wrappers.set(id, base);
    return base;
  };

  const create = (type: StyleType): any => {
    const page = session.internalPage();
    const pageId = guidToString(page.guid);
    const existing = doc.styles
      .filter((s) => !s.sourceLibraryKey)
      .map(sortKey)
      .sort();
    const sortPosition = session.positionAtList(existing);
    const common = {
      name: '',
      isPublishable: true,
      styleType: FIG_STYLE_TYPE[type],
      styleDescription: '',
      version: '',
      sortPosition,
      visible: false,
      locked: true,
      opacity: 1,
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    };
    const stroke = { strokeWeight: 1, strokeAlign: 'INSIDE', strokeJoin: 'MITER' };
    let node: NodeChange;
    if (type === 'TEXT') {
      node = session.create('TEXT', pageId, undefined, {
        ...common,
        fontSize: 12,
        textAlignVertical: 'TOP',
        lineHeight: { value: 100, units: 'PERCENT' },
        fontName: { family: 'Inter', style: 'Regular', postscript: '' },
        textData: {
          characters: 'Rag 123',
          lines: [
            {
              lineType: 'PLAIN',
              styleId: 0,
              indentationLevel: 0,
              sourceDirectionality: 'AUTO',
              listStartOffset: 0,
              isFirstLineOfList: false,
            },
          ],
        },
        letterSpacing: { value: 0, units: 'PERCENT' },
        size: { x: 0, y: 0 },
        ...stroke,
        fillPaints: [
          {
            type: 'SOLID',
            color: { r: 0, g: 0, b: 0, a: 1 },
            opacity: 1,
            visible: true,
            blendMode: 'NORMAL',
          },
        ],
        textAutoResize: 'WIDTH_AND_HEIGHT',
      });
      session.markText(guidToString(node.guid));
    } else if (type === 'GRID') {
      node = session.create('FRAME', pageId, undefined, {
        ...common,
        size: { x: 100, y: 100 },
        ...stroke,
        fillPaints: [],
        layoutGrids: [],
        frameMaskDisabled: false,
      });
    } else {
      node = session.create('ROUNDED_RECTANGLE', pageId, undefined, {
        ...common,
        size: { x: 100, y: 100 },
        ...stroke,
        fillPaints: [],
        ...(type === 'EFFECT' ? { effects: [] } : {}),
      });
    }
    // session.create assigns its own guid; keep `version` matching it.
    node.version = `${node.guid.sessionID}:${node.guid.localID}`;
    return wrap(node);
  };

  const local = (type: StyleType) =>
    doc.styles
      .filter((s) => isStyle(s) && API_STYLE_TYPE[s.styleType] === type && !s.sourceLibraryKey)
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
      .map(wrap);

  /** Points a node's reference field at a style (or '' to detach) and copies the values inline. */
  const applyToNode = (
    nodeId: string,
    refField: string,
    id: string,
    editRaw: (id: string, fields: Record<string, unknown>, opts?: { text?: boolean }) => void,
  ) => {
    const want = STYLE_REF_FIELDS[refField]!;
    const raw = doc.nodes.get(nodeId);
    if (!id) {
      if (raw?.[refField]) {
        delete session.raw(nodeId)[refField];
        session.markDirty(nodeId);
      }
      return;
    }
    const s = findStyle(doc, id);
    if (!s) throw new Error(`Style not found: ${id}`);
    if (API_STYLE_TYPE[s.styleType] !== want.type)
      throw new Error(`Style ${id} is a ${API_STYLE_TYPE[s.styleType]} style, not a ${want.type} style`);
    if (want.type === 'TEXT') requireStyleFonts(s);
    const fields: Record<string, unknown> = {};
    for (const v of want.values) {
      const src = s[styleValueField(refField, v)];
      if (src !== undefined) fields[v] = structuredClone(src);
    }
    editRaw(nodeId, fields, { text: want.type === 'TEXT' });
    session.raw(nodeId)[refField] = styleRef(s);
  };

  return {
    wrap,
    create,
    local,
    applyToNode,
    get: (id: string) => {
      const s = findStyle(doc, id);
      return s ? wrap(s) : null;
    },
    /** `textStyleId` and friends for a node: the style id, or ''. */
    idFor: (n: NodeChange, refField: string) => {
      const s = n[refField] ? doc.resolveStyleRef(n[refField]) : undefined;
      return isStyle(s) ? styleId(s) : '';
    },
  };
}
