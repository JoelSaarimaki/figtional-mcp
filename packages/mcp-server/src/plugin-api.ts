/**
 * A subset of Figma's Plugin API (`figma` global and node objects) on top of fig-model, for the
 * use_figma tool. Behaviour, names and error messages follow Figma where known
 * (docs/figma-mcp-tools.md §5); unsupported APIs throw NotSupportedInFigtional.
 */
import { type GUID, type NodeChange, guidToString } from '@figtional/fig-format';
import {
  ComponentOps,
  copyInstanceFields,
  type PropType,
  parseVariantName,
  propertyDefinitionMap,
  type EditSession,
  type FigDocument,
  type SceneNode,
  availableFonts,
  collectionInfo,
  effectiveMode,
  isInternalPage,
  normalizeNodeId,
  resolveVariable,
  rotationDegrees,
  stackProps,
} from '@figtional/fig-model';
import { fontFallbacksIn, renderPng } from '@figtional/fig-render';

import { FigtionalUnsupported } from './unsupported.js';
import { createStyleApi } from './plugin-styles.js';

export { FigtionalUnsupported };

export interface ApiContext {
  doc: FigDocument;
  session: EditSession;
  fileKey: string;
  fileName: string;
  /** Images attached by node.screenshot(). */
  images: { data: string; caption: string }[];
  /** Fonts node.screenshot() drew edited text with a replacement for ("Family Style" → used). */
  drawnFontFallbacks?: Map<string, string | undefined>;
}

const MIXED = Symbol('figma.mixed');

const clamp01 = (v: unknown, path: string) => {
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1)
    throw new Error(`Property value out of range at ${path}`);
  return v;
};

function checkKeys(obj: Record<string, unknown>, allowed: string[], path: string) {
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (bad.length)
    throw new Error(`Unrecognized key(s) in object: ${bad.map((k) => `'${k}'`).join(', ')} at ${path}`);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const IDENTITY_T = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

// ------------------------------------------------------------------ paints & effects

function paintToPlugin(doc: FigDocument, p: any): any {
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

function paintFromPlugin(doc: FigDocument, p: any, path: string): any {
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
  } else {
    throw new Error(`Invalid paint type "${p.type}" at ${path}`);
  }
  return out;
}

function effectToPlugin(e: any): any {
  const out: any = { type: e.type, visible: e.visible !== false, radius: e.radius ?? 0 };
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
    out.color = { ...(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }) };
    out.offset = { ...(e.offset ?? { x: 0, y: 0 }) };
    out.spread = e.spread ?? 0;
    out.blendMode = e.blendMode ?? 'NORMAL';
    if (e.type === 'DROP_SHADOW') out.showShadowBehindNode = e.showShadowBehindNode === true;
  }
  return out;
}

function effectFromPlugin(e: any, path: string): any {
  if (!['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'].includes(e?.type))
    throw new Error(`Invalid effect type at ${path}`);
  const out: any = { type: e.type, visible: e.visible !== false, radius: e.radius ?? 0 };
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

function variableById(doc: FigDocument, id: string): NodeChange | undefined {
  const m = /^VariableID:(.+)$/.exec(id);
  const raw = m ? m[1]! : id;
  const norm = normalizeNodeId(raw.replace(/\//g, ':'));
  const v = norm ? doc.nodes.get(norm) : undefined;
  if (v?.type === 'VARIABLE') return v;
  return doc.getByKey(raw)?.type === 'VARIABLE' ? doc.getByKey(raw) : undefined;
}

function collectionById(doc: FigDocument, id: string): NodeChange | undefined {
  const m = /^VariableCollectionId:(.+)$/.exec(id);
  const norm = normalizeNodeId(m ? m[1]! : id);
  const c = norm ? doc.nodes.get(norm) : undefined;
  return c?.type === 'VARIABLE_SET' ? c : undefined;
}

const FIELD_TO_VARIABLE: Record<string, string> = {
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

// ------------------------------------------------------------------ the API

export function createFigmaApi(ctx: ApiContext) {
  const { doc, session } = ctx;
  const components = new ComponentOps(doc, session);
  const loadedFonts = new Set<string>();
  const fontKey = (f: { family: string; style: string }) => `${f.family}\u0000${f.style}`;
  const isFontLoaded = (f: { family: string; style: string }) =>
    f.family === 'Inter' || loadedFonts.has(fontKey(f));
  const firstPage = () => doc.pages.find((p) => !p.data.isPageDivider) ?? doc.pages[0];
  let currentPageId = firstPage()?.id;
  const wrappers = new Map<string, any>();

  const scene = (id: string): SceneNode => {
    const s = doc.getNodeById(id);
    if (!s) throw new Error(`The node with id ${id} does not exist`);
    return s;
  };

  const requireFonts = (n: NodeChange) => {
    const fonts = [n.fontName, ...(n.textData?.styleOverrideTable ?? []).map((o: any) => o.fontName)].filter(
      Boolean,
    );
    for (const f of fonts) {
      if (!isFontLoaded(f))
        throw new Error(`Cannot write to node with unloaded font "${f.family} ${f.style}"`);
    }
  };

  const styles = createStyleApi({
    doc,
    session,
    paintToPlugin: (p) => paintToPlugin(doc, p),
    paintFromPlugin: (p, path) => paintFromPlugin(doc, p, path),
    effectToPlugin,
    effectFromPlugin,
    isFontLoaded,
  });
  /** Setting a style-controlled value directly detaches the node from that style (as in Figma). */
  const detachStyle = (id: string, refField: string) => {
    if (scene(id).isInstanceSublayer) return;
    const raw = session.raw(id);
    if (raw[refField]) delete raw[refField];
  };
  const dynamicPage = (prop: string, asyncName: string) =>
    new Error(`Cannot call ${prop} setter with documentAccess: dynamic-page. Use node.${asyncName} instead.`);

  const wrap = (s: SceneNode | undefined): any => {
    if (!s) return null;
    let w = wrappers.get(s.id);
    if (!w) {
      w =
        s.figType === 'CANVAS'
          ? new PageNode(s.id)
          : s.figType === 'DOCUMENT'
            ? new DocumentNode(s.id)
            : new Node(s.id);
      Object.preventExtensions(w);
      wrappers.set(s.id, w);
    }
    return w;
  };

  /** Raw node for editing; instance sublayers are edited through overrides. */
  const editRaw = (id: string, fields: Record<string, unknown>, opts: { text?: boolean } = {}) => {
    const s = scene(id);
    if (s.isInstanceSublayer) {
      const allowed = [
        'textData',
        'visible',
        'fillPaints',
        'strokePaints',
        'opacity',
        'name',
        'fontSize',
        'fontName',
        'derivedTextData',
      ];
      const bad = Object.keys(fields).filter((k) => !allowed.includes(k));
      if (bad.length) {
        throw new FigtionalUnsupported(
          `changing ${bad.join(', ')} on a layer inside an instance`,
          'Supported overrides: characters, visible, fills, strokes, opacity, name, fontSize, fontName. Detach the instance or edit the main component instead.',
        );
      }
      session.setOverride(s, fields);
      return;
    }
    const raw = session.raw(id);
    Object.assign(raw, fields);
    if (opts.text) session.markText(id);
    else session.markDirty(id);
  };

  /** Figma lays out immediately; apply pending layout before geometry is read. */
  const flushLayout = () => {
    if (session.dirty.size) session.commit();
  };

  const typeError = (prop: string, type: string) =>
    new TypeError(`node.${prop}: no such property '${prop}' on ${type} node`);

  const CONTAINER = [
    'FRAME',
    'GROUP',
    'COMPONENT',
    'COMPONENT_SET',
    'INSTANCE',
    'SECTION',
    'BOOLEAN_OPERATION',
  ];
  const FRAMELIKE = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

  class BaseNode {
    constructor(readonly id: string) {}
    get _s(): SceneNode {
      return scene(this.id);
    }
    get _d(): NodeChange {
      return this._s.data;
    }
    get type(): string {
      return this._s.type;
    }
    get name(): string {
      return this._s.name;
    }
    set name(v: string) {
      editRaw(this.id, { name: String(v) });
    }
    get removed(): boolean {
      return !doc.getNodeById(this.id);
    }
    get parent(): any {
      return wrap(this._s.parent);
    }
    get children(): readonly any[] {
      if (!CONTAINER.includes(this.type) && this.type !== 'PAGE' && this.type !== 'DOCUMENT')
        throw typeError('children', this.type);
      return Object.freeze(this._s.children.map((c) => wrap(c)));
    }
    toString() {
      return `[Node ${this.id}]`;
    }
    getPluginData() {
      return '';
    }
    setPluginData() {
      throw new FigtionalUnsupported('setPluginData');
    }
    getSharedPluginData() {
      return '';
    }
    setSharedPluginData() {
      throw new FigtionalUnsupported('setSharedPluginData');
    }
    query(selector: string) {
      return makeQueryResult(querySelector(this, String(selector)));
    }
    findAll(cb?: (n: any) => boolean) {
      return this._s.findAll((n) => !cb || !!cb(wrap(n))).map((n) => wrap(n));
    }
    findOne(cb: (n: any) => boolean) {
      return wrap(this._s.findOne((n) => !!cb(wrap(n))));
    }
    findChildren(cb?: (n: any) => boolean) {
      return this.children.filter((c) => !cb || cb(c));
    }
    findChild(cb: (n: any) => boolean) {
      return this.children.find((c) => cb(c)) ?? null;
    }
    findAllWithCriteria(criteria: { types?: string[]; pluginData?: unknown }) {
      const types = criteria?.types;
      return this._s.findAll((n) => !types || types.includes(n.type)).map((n) => wrap(n));
    }
    appendChild(child: any) {
      this.insertChild(this._s.children.length, child);
    }
    insertChild(index: number, child: any) {
      if (!(child instanceof BaseNode)) throw new Error('Expected a node');
      if (this._s.isInstanceSublayer || this.type === 'INSTANCE')
        throw new Error('Cannot add children to an instance. Edit the main component instead.');
      const childScene = scene(child.id);
      if (childScene.isInstanceSublayer) throw new Error('Cannot move a layer that is inside an instance');
      if (child.type === 'PAGE') throw new Error('Cannot move a page into a node');
      // Keep the absolute position when reparenting into a non-auto-layout container.
      const abs = childScene.absoluteTransform;
      session.move(child.id, this.id, index);
      const newParent = scene(this.id);
      if (!stackProps(newParent.data) || childScene.data.stackPositioning === 'ABSOLUTE') {
        const p = newParent.figType === 'CANVAS' ? IDENTITY_T : newParent.absoluteTransform;
        const raw = session.raw(child.id);
        raw.transform = { ...(raw.transform ?? IDENTITY_T), m02: abs.m02 - p.m02, m12: abs.m12 - p.m12 };
      }
      session.markDirty(this.id);
    }
  }

  class DocumentNode extends BaseNode {
    override get type() {
      return 'DOCUMENT';
    }
    override get children(): readonly any[] {
      return Object.freeze(doc.pages.map((p) => wrap(p)));
    }
  }

  class PageNode extends BaseNode {
    override get type() {
      return 'PAGE';
    }
    override get children(): readonly any[] {
      return Object.freeze(this._s.children.map((c) => wrap(c)));
    }
    get backgrounds() {
      const c = this._d.backgroundColor;
      return deepFreeze(
        c
          ? [
              {
                type: 'SOLID',
                visible: true,
                opacity: 1,
                blendMode: 'NORMAL',
                color: { r: c.r, g: c.g, b: c.b },
              },
            ]
          : [],
      );
    }
    set backgrounds(v: any[]) {
      const p = v?.[0];
      if (p?.type === 'SOLID')
        editRaw(this.id, { backgroundColor: { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 } });
    }
    async loadAsync() {}
    get flowStartingPoints() {
      return deepFreeze(
        this._s.children
          .filter((c) => c.data.prototypeStartingPoint)
          .map((c) => ({ nodeId: c.id, name: c.data.prototypeStartingPoint.name })),
      );
    }
    get selection() {
      return [];
    }
    set selection(_v: any) {
      /* no selection in Figtional */
    }
    remove() {
      const userPages = doc.pages.filter((p) => !p.data.isPageDivider);
      if (userPages.length <= 1) throw new Error('Cannot remove the last page of a document');
      session.remove(this.id);
      if (currentPageId === this.id) currentPageId = firstPage()?.id;
    }
  }

  class Node extends BaseNode {
    // ------------------------------------------------ general
    get visible() {
      return this._s.visible;
    }
    set visible(v: boolean) {
      editRaw(this.id, { visible: !!v });
    }
    get locked() {
      return this._d.locked === true;
    }
    set locked(v: boolean) {
      editRaw(this.id, { locked: !!v });
    }
    get opacity() {
      return this._d.opacity ?? 1;
    }
    set opacity(v: number) {
      editRaw(this.id, { opacity: clamp01(v, 'opacity') });
    }
    get blendMode() {
      return this._d.blendMode ?? 'PASS_THROUGH';
    }
    set blendMode(v: string) {
      editRaw(this.id, { blendMode: v });
    }
    get isMask() {
      return this._d.mask === true;
    }
    set isMask(v: boolean) {
      editRaw(this.id, { mask: !!v });
    }
    get placeholder() {
      return false;
    }
    set placeholder(_v: boolean) {
      /* Figma's "AI in progress" shimmer: nothing to show in a file */
    }
    get description(): any {
      if (this.type !== 'COMPONENT' && this.type !== 'COMPONENT_SET') return undefined;
      return this._d.description ?? '';
    }
    set description(v: string) {
      if (this.type !== 'COMPONENT' && this.type !== 'COMPONENT_SET')
        throw typeError('description', this.type);
      editRaw(this.id, { description: String(v) });
    }

    // ------------------------------------------------ geometry
    get x() {
      flushLayout();
      return this._s.relativeTransform.m02;
    }
    set x(v: number) {
      const t = { ...(this._d.transform ?? IDENTITY_T), m02: Number(v) };
      editRaw(this.id, { transform: t });
    }
    get y() {
      flushLayout();
      return this._s.relativeTransform.m12;
    }
    set y(v: number) {
      const t = { ...(this._d.transform ?? IDENTITY_T), m12: Number(v) };
      editRaw(this.id, { transform: t });
    }
    get width() {
      flushLayout();
      return this._s.width;
    }
    get height() {
      flushLayout();
      return this._s.height;
    }
    get rotation() {
      flushLayout();
      return rotationDegrees(this._s.relativeTransform);
    }
    set rotation(deg: number) {
      const t = this._d.transform ?? IDENTITY_T;
      const a = (-Number(deg) * Math.PI) / 180;
      editRaw(this.id, {
        transform: {
          m00: Math.cos(a),
          m01: -Math.sin(a),
          m02: t.m02,
          m10: Math.sin(a),
          m11: Math.cos(a),
          m12: t.m12,
        },
      });
    }
    get absoluteTransform() {
      flushLayout();
      const t = this._s.absoluteTransform;
      return [
        [t.m00, t.m01, t.m02],
        [t.m10, t.m11, t.m12],
      ];
    }
    get relativeTransform() {
      flushLayout();
      const t = this._s.relativeTransform;
      return [
        [t.m00, t.m01, t.m02],
        [t.m10, t.m11, t.m12],
      ];
    }
    get absoluteBoundingBox() {
      flushLayout();
      const b = this._s.absoluteBoundingBox;
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    get absoluteRenderBounds() {
      return this.absoluteBoundingBox;
    }
    resize(w: number, h: number) {
      if (!(w >= 0.01) || !(h >= 0)) throw new Error('Property value out of range: width/height');
      const d = this._d;
      const fields: Record<string, unknown> = {
        size: { x: Number(w), y: this.type === 'LINE' ? 0 : Number(h) },
      };
      // resize() makes auto-layout axes fixed, and auto-width text fixed.
      if (stackProps(d)) {
        fields.stackPrimarySizing = 'FIXED';
        delete d.stackCounterSizing;
      }
      if (this.type === 'TEXT' && d.textAutoResize === 'WIDTH_AND_HEIGHT') fields.textAutoResize = 'NONE';
      if (this.type === 'TEXT') requireFonts(d);
      editRaw(this.id, fields);
      session.invalidateGeometry(session.raw(this.id));
    }
    resizeWithoutConstraints(w: number, h: number) {
      this.resize(w, h);
    }
    rescale(scale: number) {
      this.resize(this.width * scale, this.height * scale);
    }

    // ------------------------------------------------ fills, strokes, effects
    get fills() {
      return deepFreeze((this._d.fillPaints ?? []).map((p: any) => paintToPlugin(doc, p)));
    }
    set fills(v: any[]) {
      if (!Array.isArray(v)) throw new Error('fills must be an array of paints');
      if (this.type === 'TEXT') requireFonts(this._d);
      editRaw(this.id, { fillPaints: v.map((p, i) => paintFromPlugin(doc, p, `[${i}]`)) });
      detachStyle(this.id, 'styleIdForFill');
    }
    get strokes() {
      return deepFreeze((this._d.strokePaints ?? []).map((p: any) => paintToPlugin(doc, p)));
    }
    set strokes(v: any[]) {
      if (!Array.isArray(v)) throw new Error('strokes must be an array of paints');
      editRaw(this.id, { strokePaints: v.map((p, i) => paintFromPlugin(doc, p, `[${i}]`)) });
      detachStyle(this.id, 'styleIdForStrokeFill');
      if (this._d.strokeWeight === undefined) editRaw(this.id, { strokeWeight: 1 });
      session.invalidateGeometry(session.raw(this.id));
    }
    get strokeWeight(): any {
      return this._d.borderStrokeWeightsIndependent ? MIXED : (this._d.strokeWeight ?? 1);
    }
    set strokeWeight(v: number) {
      editRaw(this.id, { strokeWeight: Number(v), borderStrokeWeightsIndependent: false });
      session.invalidateGeometry(session.raw(this.id));
    }
    get strokeAlign() {
      return this._d.strokeAlign ?? 'CENTER';
    }
    set strokeAlign(v: string) {
      editRaw(this.id, { strokeAlign: v });
      session.invalidateGeometry(session.raw(this.id));
    }
    get dashPattern() {
      return deepFreeze([...(this._d.dashPattern ?? [])]);
    }
    set dashPattern(v: number[]) {
      editRaw(this.id, { dashPattern: [...v] });
    }
    get strokeTopWeight() {
      return this._d.borderTopWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeTopWeight(v: number) {
      this.setBorder('borderTopWeight', v);
    }
    get strokeRightWeight() {
      return this._d.borderRightWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeRightWeight(v: number) {
      this.setBorder('borderRightWeight', v);
    }
    get strokeBottomWeight() {
      return this._d.borderBottomWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeBottomWeight(v: number) {
      this.setBorder('borderBottomWeight', v);
    }
    get strokeLeftWeight() {
      return this._d.borderLeftWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeLeftWeight(v: number) {
      this.setBorder('borderLeftWeight', v);
    }
    private setBorder(field: string, v: number) {
      const d = this._d;
      const w = d.strokeWeight ?? 1;
      editRaw(this.id, {
        borderStrokeWeightsIndependent: true,
        borderTopWeight: d.borderTopWeight ?? w,
        borderRightWeight: d.borderRightWeight ?? w,
        borderBottomWeight: d.borderBottomWeight ?? w,
        borderLeftWeight: d.borderLeftWeight ?? w,
        [field]: Number(v),
      });
      session.invalidateGeometry(session.raw(this.id));
    }
    get effects() {
      return deepFreeze((this._d.effects ?? []).map(effectToPlugin));
    }
    set effects(v: any[]) {
      editRaw(this.id, { effects: v.map((e, i) => effectFromPlugin(e, `[${i}]`)) });
      detachStyle(this.id, 'styleIdForEffect');
    }
    get cornerRadius(): any {
      return this._d.rectangleCornerRadiiIndependent ? MIXED : (this._d.cornerRadius ?? 0);
    }
    set cornerRadius(v: number) {
      editRaw(this.id, {
        cornerRadius: Number(v),
        rectangleCornerRadiiIndependent: false,
        rectangleTopLeftCornerRadius: Number(v),
        rectangleTopRightCornerRadius: Number(v),
        rectangleBottomLeftCornerRadius: Number(v),
        rectangleBottomRightCornerRadius: Number(v),
      });
      session.invalidateGeometry(session.raw(this.id));
    }
    private setCorner(field: string, v: number) {
      const r = this._d.cornerRadius ?? 0;
      const d = this._d;
      editRaw(this.id, {
        rectangleCornerRadiiIndependent: true,
        rectangleTopLeftCornerRadius: d.rectangleTopLeftCornerRadius ?? r,
        rectangleTopRightCornerRadius: d.rectangleTopRightCornerRadius ?? r,
        rectangleBottomLeftCornerRadius: d.rectangleBottomLeftCornerRadius ?? r,
        rectangleBottomRightCornerRadius: d.rectangleBottomRightCornerRadius ?? r,
        [field]: Number(v),
      });
      session.invalidateGeometry(session.raw(this.id));
    }
    get topLeftRadius() {
      return this._d.rectangleTopLeftCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set topLeftRadius(v: number) {
      this.setCorner('rectangleTopLeftCornerRadius', v);
    }
    get topRightRadius() {
      return this._d.rectangleTopRightCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set topRightRadius(v: number) {
      this.setCorner('rectangleTopRightCornerRadius', v);
    }
    get bottomLeftRadius() {
      return this._d.rectangleBottomLeftCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set bottomLeftRadius(v: number) {
      this.setCorner('rectangleBottomLeftCornerRadius', v);
    }
    get bottomRightRadius() {
      return this._d.rectangleBottomRightCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set bottomRightRadius(v: number) {
      this.setCorner('rectangleBottomRightCornerRadius', v);
    }
    get clipsContent() {
      if (!FRAMELIKE.includes(this.type)) throw typeError('clipsContent', this.type);
      return this._d.frameMaskDisabled !== true;
    }
    set clipsContent(v: boolean) {
      if (!FRAMELIKE.includes(this.type)) throw typeError('clipsContent', this.type);
      editRaw(this.id, { frameMaskDisabled: !v });
    }

    // ------------------------------------------------ auto layout (frame)
    private requireFrame(prop: string) {
      if (!FRAMELIKE.includes(this.type)) throw typeError(prop, this.type);
    }
    get layoutMode() {
      this.requireFrame('layoutMode');
      const m = this._d.stackMode;
      return m === 'HORIZONTAL' || m === 'VERTICAL' || m === 'GRID' ? m : 'NONE';
    }
    set layoutMode(v: string) {
      this.requireFrame('layoutMode');
      if (!['NONE', 'HORIZONTAL', 'VERTICAL'].includes(v)) {
        throw v === 'GRID'
          ? new FigtionalUnsupported("layoutMode = 'GRID'")
          : new Error(`Expected 'NONE' | 'HORIZONTAL' | 'VERTICAL', received '${v}'`);
      }
      const d = this._d;
      const fields: Record<string, unknown> = { stackMode: v };
      if (v !== 'NONE' && d.stackMode !== 'HORIZONTAL' && d.stackMode !== 'VERTICAL') {
        // New auto-layout frames keep their current size: both axes fixed until changed.
        fields.stackPrimarySizing = 'FIXED';
      }
      editRaw(this.id, fields);
    }
    get primaryAxisSizingMode() {
      this.requireFrame('primaryAxisSizingMode');
      return this._d.stackPrimarySizing === 'FIXED' ? 'FIXED' : 'AUTO';
    }
    set primaryAxisSizingMode(v: string) {
      this.requireFrame('primaryAxisSizingMode');
      if (v !== 'FIXED' && v !== 'AUTO') throw new Error(`Expected 'FIXED' | 'AUTO', received '${v}'`);
      if (v === 'FIXED') editRaw(this.id, { stackPrimarySizing: 'FIXED' });
      else {
        delete session.raw(this.id).stackPrimarySizing;
        session.markDirty(this.id);
      }
    }
    get counterAxisSizingMode() {
      this.requireFrame('counterAxisSizingMode');
      const c = this._d.stackCounterSizing;
      return c === 'RESIZE_TO_FIT' || c === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' ? 'AUTO' : 'FIXED';
    }
    set counterAxisSizingMode(v: string) {
      this.requireFrame('counterAxisSizingMode');
      if (v !== 'FIXED' && v !== 'AUTO') throw new Error(`Expected 'FIXED' | 'AUTO', received '${v}'`);
      if (v === 'AUTO') editRaw(this.id, { stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' });
      else {
        delete session.raw(this.id).stackCounterSizing;
        session.markDirty(this.id);
      }
    }
    get itemSpacing() {
      this.requireFrame('itemSpacing');
      return this._d.stackSpacing ?? 0;
    }
    set itemSpacing(v: number) {
      this.requireFrame('itemSpacing');
      editRaw(this.id, { stackSpacing: Number(v) });
    }
    get counterAxisSpacing() {
      return this._d.stackCounterSpacing ?? null;
    }
    set counterAxisSpacing(v: number | null) {
      editRaw(this.id, { stackCounterSpacing: v === null ? NaN : Number(v) });
    }
    get paddingLeft() {
      return this._d.stackHorizontalPadding ?? 0;
    }
    set paddingLeft(v: number) {
      const d = this._d;
      editRaw(this.id, {
        stackHorizontalPadding: Number(v),
        stackPaddingRight: d.stackPaddingRight ?? d.stackHorizontalPadding ?? 0,
      });
    }
    get paddingRight() {
      return this._d.stackPaddingRight ?? this._d.stackHorizontalPadding ?? 0;
    }
    set paddingRight(v: number) {
      editRaw(this.id, { stackPaddingRight: Number(v) });
    }
    get paddingTop() {
      return this._d.stackVerticalPadding ?? 0;
    }
    set paddingTop(v: number) {
      const d = this._d;
      editRaw(this.id, {
        stackVerticalPadding: Number(v),
        stackPaddingBottom: d.stackPaddingBottom ?? d.stackVerticalPadding ?? 0,
      });
    }
    get paddingBottom() {
      return this._d.stackPaddingBottom ?? this._d.stackVerticalPadding ?? 0;
    }
    set paddingBottom(v: number) {
      editRaw(this.id, { stackPaddingBottom: Number(v) });
    }
    get horizontalPadding() {
      return this.paddingLeft;
    }
    set horizontalPadding(v: number) {
      this.paddingLeft = v;
      this.paddingRight = v;
    }
    get verticalPadding() {
      return this.paddingTop;
    }
    set verticalPadding(v: number) {
      this.paddingTop = v;
      this.paddingBottom = v;
    }
    get primaryAxisAlignItems() {
      const j = this._d.stackPrimaryAlignItems ?? 'MIN';
      return j === 'SPACE_EVENLY' || j === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : j;
    }
    set primaryAxisAlignItems(v: string) {
      if (!['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'].includes(v))
        throw new Error(`Expected 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN', received '${v}'`);
      editRaw(this.id, { stackPrimaryAlignItems: v === 'SPACE_BETWEEN' ? 'SPACE_EVENLY' : v });
    }
    get counterAxisAlignItems() {
      return this._d.stackCounterAlignItems ?? 'MIN';
    }
    set counterAxisAlignItems(v: string) {
      if (!['MIN', 'MAX', 'CENTER', 'BASELINE'].includes(v))
        throw new Error(`Expected 'MIN' | 'MAX' | 'CENTER' | 'BASELINE', received '${v}'`);
      editRaw(this.id, { stackCounterAlignItems: v });
    }
    get layoutWrap() {
      return this._d.stackWrap === 'WRAP' ? 'WRAP' : 'NO_WRAP';
    }
    set layoutWrap(v: string) {
      editRaw(this.id, { stackWrap: v === 'WRAP' ? 'WRAP' : 'NO_WRAP' });
    }
    get strokesIncludedInLayout() {
      return this._d.bordersTakeSpace === true;
    }
    set strokesIncludedInLayout(v: boolean) {
      editRaw(this.id, { bordersTakeSpace: !!v });
    }
    get itemReverseZIndex() {
      return this._d.stackReverseZIndex === true;
    }
    set itemReverseZIndex(v: boolean) {
      editRaw(this.id, { stackReverseZIndex: !!v });
    }

    // ------------------------------------------------ layout as a child
    get layoutGrow() {
      return this._d.stackChildPrimaryGrow ?? 0;
    }
    set layoutGrow(v: number) {
      editRaw(this.id, { stackChildPrimaryGrow: Number(v) });
    }
    get layoutAlign() {
      return this._d.stackChildAlignSelf === 'STRETCH' ? 'STRETCH' : 'INHERIT';
    }
    set layoutAlign(v: string) {
      editRaw(this.id, { stackChildAlignSelf: v === 'STRETCH' ? 'STRETCH' : 'AUTO' });
    }
    get layoutPositioning() {
      return this._d.stackPositioning === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO';
    }
    set layoutPositioning(v: string) {
      editRaw(this.id, { stackPositioning: v === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO' });
    }
    private sizing(horizontal: boolean): string {
      const s = this._s;
      const d = s.data;
      const parent = s.parent ? stackProps(s.parent.data) : undefined;
      if (parent) {
        const grow = (d.stackChildPrimaryGrow ?? 0) > 0;
        const stretch = d.stackChildAlignSelf === 'STRETCH';
        if (parent.horizontal === horizontal ? grow : stretch) return 'FILL';
      }
      const own = stackProps(d);
      if (own) return (own.horizontal === horizontal ? own.primaryHug : own.counterHug) ? 'HUG' : 'FIXED';
      if (d.type === 'TEXT') {
        if (d.textAutoResize === 'WIDTH_AND_HEIGHT') return 'HUG';
        if (!horizontal && d.textAutoResize === 'HEIGHT') return 'HUG';
      }
      return 'FIXED';
    }
    private setSizing(horizontal: boolean, v: string) {
      const prop = horizontal ? 'layoutSizingHorizontal' : 'layoutSizingVertical';
      const s = this._s;
      const d = s.data;
      const parent = s.parent ? stackProps(s.parent.data) : undefined;
      const own = stackProps(d);
      if (!['FIXED', 'HUG', 'FILL'].includes(v))
        throw new Error(`Expected 'FIXED' | 'HUG' | 'FILL', received '${v}'`);
      if (v === 'HUG' && !own && !(d.type === 'TEXT')) {
        throw new Error(
          `Error: in set_${prop}: node must be an auto-layout frame or a child of an auto-layout frame`,
        );
      }
      if (v === 'FILL' && (!parent || d.stackPositioning === 'ABSOLUTE')) {
        throw new Error(`Error: in set_${prop}: FILL can only be set on children of auto-layout frames`);
      }
      const fields: Record<string, unknown> = {};
      // Clear fill on this axis first.
      if (parent) {
        if (parent.horizontal === horizontal) fields.stackChildPrimaryGrow = v === 'FILL' ? 1 : 0;
        else fields.stackChildAlignSelf = v === 'FILL' ? 'STRETCH' : 'AUTO';
      }
      if (own) {
        const primary = own.horizontal === horizontal;
        if (primary) fields.stackPrimarySizing = v === 'HUG' ? undefined : 'FIXED';
        else fields.stackCounterSizing = v === 'HUG' ? 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' : undefined;
      } else if (d.type === 'TEXT') {
        requireFonts(d);
        const cur = d.textAutoResize ?? 'NONE';
        if (horizontal)
          fields.textAutoResize =
            v === 'HUG' ? 'WIDTH_AND_HEIGHT' : cur === 'WIDTH_AND_HEIGHT' ? 'HEIGHT' : cur;
        else fields.textAutoResize = v === 'HUG' ? (cur === 'WIDTH_AND_HEIGHT' ? cur : 'HEIGHT') : 'NONE';
      }
      const raw = session.raw(this.id);
      for (const [k, val] of Object.entries(fields)) {
        if (val === undefined) delete raw[k];
        else raw[k] = val;
      }
      if (d.type === 'TEXT') session.markText(this.id);
      else session.markDirty(this.id);
    }
    get layoutSizingHorizontal() {
      return this.sizing(true);
    }
    set layoutSizingHorizontal(v: string) {
      this.setSizing(true, v);
    }
    get layoutSizingVertical() {
      return this.sizing(false);
    }
    set layoutSizingVertical(v: string) {
      this.setSizing(false, v);
    }
    private minMax(field: 'minSize' | 'maxSize', axis: 'x' | 'y') {
      return this._d[field]?.value?.[axis] ?? null;
    }
    private setMinMax(field: 'minSize' | 'maxSize', axis: 'x' | 'y', v: number | null) {
      const cur = { x: this._d[field]?.value?.x ?? null, y: this._d[field]?.value?.y ?? null };
      cur[axis] = v;
      editRaw(this.id, { [field]: { value: cur } });
    }
    get minWidth() {
      return this.minMax('minSize', 'x');
    }
    set minWidth(v: number | null) {
      this.setMinMax('minSize', 'x', v);
    }
    get maxWidth() {
      return this.minMax('maxSize', 'x');
    }
    set maxWidth(v: number | null) {
      this.setMinMax('maxSize', 'x', v);
    }
    get minHeight() {
      return this.minMax('minSize', 'y');
    }
    set minHeight(v: number | null) {
      this.setMinMax('minSize', 'y', v);
    }
    get maxHeight() {
      return this.minMax('maxSize', 'y');
    }
    set maxHeight(v: number | null) {
      this.setMinMax('maxSize', 'y', v);
    }
    get constraints() {
      return {
        horizontal: this._d.horizontalConstraint ?? 'MIN',
        vertical: this._d.verticalConstraint ?? 'MIN',
      };
    }
    set constraints(v: { horizontal: string; vertical: string }) {
      const map: Record<string, string> = {
        MIN: 'MIN',
        MAX: 'MAX',
        CENTER: 'CENTER',
        STRETCH: 'STRETCH',
        SCALE: 'SCALE',
      };
      editRaw(this.id, {
        horizontalConstraint: map[v.horizontal] ?? 'MIN',
        verticalConstraint: map[v.vertical] ?? 'MIN',
      });
    }

    // ------------------------------------------------ text
    private requireText(prop: string) {
      if (this.type !== 'TEXT') throw typeError(prop, this.type);
    }
    get characters() {
      this.requireText('characters');
      return this._d.textData?.characters ?? '';
    }
    set characters(v: string) {
      this.requireText('characters');
      requireFonts(this._d);
      const text = String(v);
      const d = this._d;
      const textData = {
        characters: text,
        lines: text.split('\n').map(() => ({
          lineType: 'PLAIN',
          styleId: 0,
          indentationLevel: 0,
          sourceDirectionality: 'AUTO',
          listStartOffset: 0,
          isFirstLineOfList: false,
        })),
      };
      const s = this._s;
      if (s.isInstanceSublayer) {
        if (!setTextProperty(s, textData)) session.setOverride(s, { textData });
        return;
      }
      const fields: Record<string, unknown> = { textData };
      // Figma renames auto-named text layers to follow their content.
      if (
        d.autoRename !== false &&
        (d.name === (d.textData?.characters ?? '') || d.name === '' || d.autoRename === true)
      ) {
        fields.name = text.slice(0, 100);
      }
      editRaw(this.id, fields, { text: true });
      delete session.raw(this.id).derivedTextData;
    }
    insertCharacters(start: number, chars: string) {
      const cur = this.characters;
      this.characters = cur.slice(0, start) + chars + cur.slice(start);
    }
    deleteCharacters(start: number, end: number) {
      const cur = this.characters;
      this.characters = cur.slice(0, start) + cur.slice(end);
    }
    get fontName(): any {
      this.requireText('fontName');
      const ids: number[] = this._d.textData?.characterStyleIDs ?? [];
      if (
        (this._d.textData?.styleOverrideTable ?? []).some((o: any) => o.fontName) &&
        ids.some((i) => i !== 0)
      )
        return MIXED;
      const f = this._d.fontName ?? { family: 'Inter', style: 'Regular' };
      return { family: f.family, style: f.style };
    }
    set fontName(v: { family: string; style: string }) {
      this.requireText('fontName');
      if (!isFontLoaded(v))
        throw new Error(
          `Cannot use unloaded font "${v.family} ${v.style}". Please call figma.loadFontAsync({ family: "${v.family}", style: "${v.style}" }) and await the returned promise first.`,
        );
      requireFonts(this._d);
      editRaw(this.id, { fontName: { family: v.family, style: v.style, postscript: '' } }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get fontSize() {
      this.requireText('fontSize');
      return this._d.fontSize ?? 12;
    }
    set fontSize(v: number) {
      this.requireText('fontSize');
      requireFonts(this._d);
      editRaw(this.id, { fontSize: Number(v) }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get lineHeight() {
      this.requireText('lineHeight');
      const lh = this._d.lineHeight;
      if (!lh || (lh.units === 'PERCENT' && lh.value === 100)) return { unit: 'AUTO' };
      if (lh.units === 'RAW') return { unit: 'PERCENT', value: lh.value * 100 };
      if (lh.units === 'PIXELS') return { unit: 'PIXELS', value: lh.value };
      return { unit: 'PERCENT', value: lh.value };
    }
    set lineHeight(v: { unit: string; value?: number }) {
      this.requireText('lineHeight');
      requireFonts(this._d);
      if (typeof v !== 'object')
        throw new Error('lineHeight must be an object like { unit: "PIXELS", value: 24 }');
      const lh =
        v.unit === 'AUTO'
          ? { value: 100, units: 'PERCENT' }
          : v.unit === 'PERCENT'
            ? { value: (v.value ?? 100) / 100, units: 'RAW' }
            : { value: v.value ?? 0, units: 'PIXELS' };
      editRaw(this.id, { lineHeight: lh }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get letterSpacing() {
      this.requireText('letterSpacing');
      const ls = this._d.letterSpacing ?? { value: 0, units: 'PERCENT' };
      return { unit: ls.units === 'PIXELS' ? 'PIXELS' : 'PERCENT', value: ls.value };
    }
    set letterSpacing(v: { unit: string; value: number }) {
      this.requireText('letterSpacing');
      requireFonts(this._d);
      if (typeof v !== 'object')
        throw new Error('letterSpacing must be an object like { unit: "PERCENT", value: 0 }');
      editRaw(
        this.id,
        { letterSpacing: { value: Number(v.value), units: v.unit === 'PIXELS' ? 'PIXELS' : 'PERCENT' } },
        { text: true },
      );
      detachStyle(this.id, 'styleIdForText');
    }
    get textAlignHorizontal() {
      this.requireText('textAlignHorizontal');
      return this._d.textAlignHorizontal ?? 'LEFT';
    }
    set textAlignHorizontal(v: string) {
      this.requireText('textAlignHorizontal');
      requireFonts(this._d);
      editRaw(this.id, { textAlignHorizontal: v });
    }
    get textAlignVertical() {
      this.requireText('textAlignVertical');
      return this._d.textAlignVertical ?? 'TOP';
    }
    set textAlignVertical(v: string) {
      this.requireText('textAlignVertical');
      requireFonts(this._d);
      editRaw(this.id, { textAlignVertical: v });
    }
    get textAutoResize() {
      this.requireText('textAutoResize');
      return this._d.textAutoResize ?? 'NONE';
    }
    set textAutoResize(v: string) {
      this.requireText('textAutoResize');
      requireFonts(this._d);
      if (!['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'].includes(v))
        throw new Error(`Invalid textAutoResize "${v}"`);
      editRaw(this.id, { textAutoResize: v === 'TRUNCATE' ? 'NONE' : v }, { text: true });
    }
    get textCase() {
      this.requireText('textCase');
      return this._d.textCase ?? 'ORIGINAL';
    }
    set textCase(v: string) {
      this.requireText('textCase');
      requireFonts(this._d);
      editRaw(this.id, { textCase: v }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get textDecoration() {
      this.requireText('textDecoration');
      return this._d.textDecoration ?? 'NONE';
    }
    set textDecoration(v: string) {
      this.requireText('textDecoration');
      requireFonts(this._d);
      editRaw(this.id, { textDecoration: v });
      detachStyle(this.id, 'styleIdForText');
    }
    get hasMissingFont() {
      return false;
    }
    getStyledTextSegments(fields: string[]) {
      this.requireText('getStyledTextSegments');
      const d = this._d;
      const chars: string = d.textData?.characters ?? '';
      const ids: number[] = d.textData?.characterStyleIDs ?? [];
      const table = new Map<number, any>(
        (d.textData?.styleOverrideTable ?? []).map((o: any) => [o.styleID, o]),
      );
      const segs: any[] = [];
      let start = 0;
      const styleAt = (i: number) => ids[i] ?? 0;
      for (let i = 1; i <= chars.length; i++) {
        if (i === chars.length || styleAt(i) !== styleAt(i - 1)) {
          const o = { ...d, ...(table.get(styleAt(start)) ?? {}) };
          const seg: any = { characters: chars.slice(start, i), start, end: i };
          for (const f of fields ?? []) {
            if (f === 'fontName') seg.fontName = { family: o.fontName?.family, style: o.fontName?.style };
            else if (f === 'fontSize') seg.fontSize = o.fontSize;
            else if (f === 'fills') seg.fills = (o.fillPaints ?? []).map((p: any) => paintToPlugin(doc, p));
            else if (f === 'textDecoration') seg.textDecoration = o.textDecoration ?? 'NONE';
            else if (f === 'textCase') seg.textCase = o.textCase ?? 'ORIGINAL';
            else if (f === 'fontWeight') seg.fontWeight = undefined;
          }
          segs.push(seg);
          start = i;
        }
      }
      if (!segs.length)
        segs.push({
          characters: '',
          start: 0,
          end: 0,
          ...(fields?.includes('fontName') ? { fontName: { ...d.fontName } } : {}),
        });
      return segs;
    }
    private setRange(start: number, end: number, fields: Record<string, unknown>) {
      this.requireText('setRange');
      requireFonts(this._d);
      const s = this._s;
      if (s.isInstanceSublayer) throw new FigtionalUnsupported('setRange* on text inside an instance');
      const raw = session.raw(this.id);
      const chars: string = raw.textData?.characters ?? '';
      if (start <= 0 && end >= chars.length) {
        Object.assign(raw, fields);
      } else {
        const td = raw.textData;
        const ids: number[] = td.characterStyleIDs?.length
          ? [...td.characterStyleIDs]
          : new Array(chars.length).fill(0);
        while (ids.length < chars.length) ids.push(0);
        const table: any[] = td.styleOverrideTable ? [...td.styleOverrideTable] : [];
        const remap = new Map<number, number>();
        let next = Math.max(0, ...table.map((o) => o.styleID)) + 1;
        for (let i = start; i < end; i++) {
          const old = ids[i]!;
          let nid = remap.get(old);
          if (nid === undefined) {
            nid = next++;
            const base = table.find((o) => o.styleID === old) ?? {};
            table.push({ ...structuredClone(base), ...fields, styleID: nid });
            remap.set(old, nid);
          }
          ids[i] = nid;
        }
        td.characterStyleIDs = ids;
        td.styleOverrideTable = table;
      }
      session.markText(this.id);
      delete raw.derivedTextData;
    }
    setRangeFontSize(start: number, end: number, v: number) {
      this.setRange(start, end, { fontSize: Number(v) });
    }
    setRangeFontName(start: number, end: number, v: { family: string; style: string }) {
      if (!isFontLoaded(v))
        throw new Error(
          `Cannot use unloaded font "${v.family} ${v.style}". Please call figma.loadFontAsync first.`,
        );
      this.setRange(start, end, { fontName: { family: v.family, style: v.style, postscript: '' } });
    }
    setRangeFills(start: number, end: number, v: any[]) {
      this.setRange(start, end, { fillPaints: v.map((p, i) => paintFromPlugin(doc, p, `[${i}]`)) });
    }
    setRangeTextDecoration(start: number, end: number, v: string) {
      this.setRange(start, end, { textDecoration: v });
    }
    setRangeTextCase(start: number, end: number, v: string) {
      this.setRange(start, end, { textCase: v });
    }
    getRangeFontName(start: number, end: number) {
      const segs = this.getStyledTextSegments(['fontName']).filter((s) => s.end > start && s.start < end);
      const names = new Set(segs.map((s) => `${s.fontName.family}|${s.fontName.style}`));
      return names.size === 1 ? segs[0].fontName : MIXED;
    }
    getRangeFontSize(start: number, end: number) {
      const segs = this.getStyledTextSegments(['fontSize']).filter((s) => s.end > start && s.start < end);
      const sizes = new Set(segs.map((s) => s.fontSize));
      return sizes.size === 1 ? segs[0].fontSize : MIXED;
    }

    // ------------------------------------------------ styles
    get fillStyleId() {
      return styles.idFor(this._d, 'styleIdForFill');
    }
    set fillStyleId(_v: string) {
      throw dynamicPage('fillStyleId', 'setFillStyleIdAsync');
    }
    async setFillStyleIdAsync(id: string) {
      styles.applyToNode(this.id, 'styleIdForFill', String(id ?? ''), editRaw);
    }
    get strokeStyleId() {
      return styles.idFor(this._d, 'styleIdForStrokeFill');
    }
    set strokeStyleId(_v: string) {
      throw dynamicPage('strokeStyleId', 'setStrokeStyleIdAsync');
    }
    async setStrokeStyleIdAsync(id: string) {
      styles.applyToNode(this.id, 'styleIdForStrokeFill', String(id ?? ''), editRaw);
      if (id && this._d.strokeWeight === undefined) editRaw(this.id, { strokeWeight: 1 });
    }
    get effectStyleId() {
      return styles.idFor(this._d, 'styleIdForEffect');
    }
    set effectStyleId(_v: string) {
      throw dynamicPage('effectStyleId', 'setEffectStyleIdAsync');
    }
    async setEffectStyleIdAsync(id: string) {
      styles.applyToNode(this.id, 'styleIdForEffect', String(id ?? ''), editRaw);
    }
    get gridStyleId() {
      return styles.idFor(this._d, 'styleIdForGrid');
    }
    set gridStyleId(_v: string) {
      throw dynamicPage('gridStyleId', 'setGridStyleIdAsync');
    }
    async setGridStyleIdAsync(id: string) {
      if (!FRAMELIKE.includes(this.type)) throw typeError('setGridStyleIdAsync', this.type);
      styles.applyToNode(this.id, 'styleIdForGrid', String(id ?? ''), editRaw);
    }
    get textStyleId() {
      this.requireText('textStyleId');
      return styles.idFor(this._d, 'styleIdForText');
    }
    set textStyleId(_v: string) {
      throw dynamicPage('textStyleId', 'setTextStyleIdAsync');
    }
    async setTextStyleIdAsync(id: string) {
      this.requireText('setTextStyleIdAsync');
      requireFonts(this._d);
      styles.applyToNode(this.id, 'styleIdForText', String(id ?? ''), editRaw);
    }

    // ------------------------------------------------ components & instances
    get mainComponent() {
      if (this.type !== 'INSTANCE') throw typeError('mainComponent', this.type);
      return wrap(this._s.mainComponent);
    }
    async getMainComponentAsync() {
      return this.mainComponent;
    }
    get componentProperties() {
      if (this.type !== 'INSTANCE') throw typeError('componentProperties', this.type);
      return deepFreeze(components.instanceProperties(this._s));
    }
    get variantProperties() {
      if (this.type === 'INSTANCE') {
        const main = this._s.mainComponent;
        return main?.parent?.type === 'COMPONENT_SET'
          ? Object.fromEntries(parseVariantName(main.name))
          : null;
      }
      if (this.type === 'COMPONENT') {
        return this._s.parent?.type === 'COMPONENT_SET'
          ? Object.fromEntries(parseVariantName(this.name))
          : null;
      }
      throw typeError('variantProperties', this.type);
    }
    get variantGroupProperties() {
      if (this.type !== 'COMPONENT_SET') throw typeError('variantGroupProperties', this.type);
      const defs = propertyDefinitionMap(doc, this._d) as Record<string, any>;
      return Object.fromEntries(
        Object.entries(defs)
          .filter(([, d]) => d.type === 'VARIANT')
          .map(([k, d]) => [k, { values: d.variantOptions }]),
      );
    }
    get defaultVariant() {
      if (this.type !== 'COMPONENT_SET') throw typeError('defaultVariant', this.type);
      return wrap(this._s.children.find((c) => c.type === 'COMPONENT'));
    }
    get componentPropertyReferences() {
      return components.references(this._d);
    }
    set componentPropertyReferences(refs: Record<string, string> | null) {
      if (this._s.isInstanceSublayer) throw new Error('Cannot bind properties on a layer inside an instance');
      const current = components.references(this._d);
      const next = refs ?? {};
      for (const field of ['characters', 'visible', 'mainComponent'] as const) {
        if (next[field] !== current[field]) {
          if (field === 'characters') requireFonts(this._d);
          components.bindProperty(this.id, field, next[field] ?? null);
        }
      }
      for (const k of Object.keys(next)) {
        if (!['characters', 'visible', 'mainComponent'].includes(k)) {
          throw new FigtionalUnsupported(`componentPropertyReferences.${k}`);
        }
      }
    }
    createInstance() {
      if (this.type !== 'COMPONENT') throw typeError('createInstance', this.type);
      const sym = this._s;
      const page = scene(currentPageId!);
      const fields: Record<string, unknown> = {
        // Instances of variants are named after their component set, as in Figma.
        name: sym.parent?.type === 'COMPONENT_SET' ? sym.parent.name : sym.name,
        visible: true,
        opacity: 1,
        transform: { ...IDENTITY_T },
        symbolData: { symbolID: { ...sym.data.guid }, symbolOverrides: [], uniformScaleFactor: 1 },
        strokeJoin: 'MITER',
      };
      copyInstanceFields(fields as NodeChange, sym.data);
      const n = session.create('INSTANCE', page.id, undefined, fields);
      return wrap(scene(guidToString(n.guid)));
    }
    detachInstance() {
      if (this.type !== 'INSTANCE') throw typeError('detachInstance', this.type);
      const frame = components.detach(this._s);
      wrappers.delete(this.id);
      return wrap(scene(guidToString(frame.guid)));
    }
    swapComponent(component: any) {
      if (this.type !== 'INSTANCE') throw typeError('swapComponent', this.type);
      if (component?.type !== 'COMPONENT') throw new Error('Expected a component node');
      const raw = session.raw(this.id);
      raw.symbolData = {
        ...raw.symbolData,
        symbolID: { ...session.raw(component.id).guid },
        symbolOverrides: [],
      };
      delete raw.derivedSymbolData;
      session.markDirty(this.id);
    }
    setProperties(props: Record<string, unknown>) {
      if (this.type !== 'INSTANCE') throw typeError('setProperties', this.type);
      const s = this._s;
      // Text properties change text: the fonts of bound text layers must be loaded, as in Figma.
      s.walk((n) => {
        if (
          n !== s &&
          n.figType === 'TEXT' &&
          (n.data.componentPropRefs ?? []).some((r: any) => r.componentPropNodeField === 'TEXT_DATA')
        ) {
          requireFonts(n.data);
        }
        return true;
      });
      components.setInstanceProperties(s, props ?? {}, (fields) => {
        if (s.isInstanceSublayer) session.setOverride(s, fields);
        else {
          Object.assign(session.raw(this.id), fields);
          session.markDirty(this.id);
        }
      });
    }
    private definitionOwnerId(prop: string): string {
      if (this.type === 'COMPONENT_SET') return this.id;
      if (this.type === 'COMPONENT') {
        if (this._s.parent?.type === 'COMPONENT_SET') {
          throw new Error(
            'Can only get/set component property definitions of a component set or non-variant component',
          );
        }
        return this.id;
      }
      throw typeError(prop, this.type);
    }
    get componentPropertyDefinitions() {
      return deepFreeze(
        propertyDefinitionMap(doc, session.raw(this.definitionOwnerId('componentPropertyDefinitions'))),
      );
    }
    addComponentProperty(
      name: string,
      type: string,
      defaultValue: unknown,
      options?: { preferredValues?: { type: string; key: string }[] },
    ) {
      const owner = this.definitionOwnerId('addComponentProperty');
      return components.addProperty(
        owner,
        String(name),
        type as PropType,
        defaultValue,
        options?.preferredValues,
      );
    }
    editComponentProperty(key: string, values: { name?: string; defaultValue?: unknown }) {
      return components.editProperty(this.definitionOwnerId('editComponentProperty'), key, values ?? {});
    }
    deleteComponentProperty(key: string) {
      components.deleteProperty(this.definitionOwnerId('deleteComponentProperty'), key);
    }

    // ------------------------------------------------ explicit variable modes
    private requireModes(prop: string) {
      if (![...FRAMELIKE, 'SECTION'].includes(this.type)) throw typeError(prop, this.type);
    }
    private modeCollection(collection: unknown): NodeChange {
      const id = typeof collection === 'string' ? collection : (collection as { id?: string } | null)?.id;
      const c = id ? collectionById(doc, id) : undefined;
      if (!c) throw new Error(`Variable collection not found: ${String(id)}`);
      return c;
    }
    get explicitVariableModes(): Record<string, string> {
      this.requireModes('explicitVariableModes');
      const out: Record<string, string> = {};
      for (const e of this._d.variableModeBySetMap?.entries ?? []) {
        const ref = e.variableSetID;
        const c = ref ? doc.resolveVariableRef(ref.guid ? { guid: ref.guid } : ref) : undefined;
        if (c && e.variableModeID)
          out[`VariableCollectionId:${guidToString(c.guid)}`] = guidToString(e.variableModeID);
      }
      return out;
    }
    get resolvedVariableModes(): Record<string, string> {
      const out: Record<string, string> = {};
      const s = scene(this.id);
      for (const c of doc.variableCollections) {
        const mode = effectiveMode(doc, s, c) ?? collectionInfo(doc, c).defaultModeId;
        if (mode) out[`VariableCollectionId:${guidToString(c.guid)}`] = mode;
      }
      return out;
    }
    setExplicitVariableModeForCollection(collection: unknown, modeId: string) {
      this.requireModes('setExplicitVariableModeForCollection');
      const c = this.modeCollection(collection);
      const mode = (c.variableSetModes ?? []).find((m: any) => guidToString(m.id) === String(modeId));
      if (!mode) throw new Error(`Mode ${String(modeId)} not found in collection "${c.name ?? ''}"`);
      // Library collections are referenced by key (as in Figma's files), local ones by guid.
      const variableSetID =
        c.sourceLibraryKey && c.key
          ? { assetRef: { key: c.key, ...(c.version ? { version: c.version } : {}) } }
          : { guid: { ...c.guid } };
      const entries = this.modeEntriesWithout(c);
      entries.push({ variableSetID, variableModeID: { ...mode.id } });
      editRaw(this.id, { variableModeBySetMap: { entries } });
    }
    clearExplicitVariableModeForCollection(collection: unknown) {
      this.requireModes('clearExplicitVariableModeForCollection');
      const entries = this.modeEntriesWithout(this.modeCollection(collection));
      if (entries.length) editRaw(this.id, { variableModeBySetMap: { entries } });
      else if (this._d.variableModeBySetMap) {
        if (scene(this.id).isInstanceSublayer)
          throw new FigtionalUnsupported('clearing explicit variable modes on a layer inside an instance');
        delete session.raw(this.id).variableModeBySetMap;
        session.markDirty(this.id);
      }
    }
    private modeEntriesWithout(c: NodeChange): any[] {
      const id = guidToString(c.guid);
      return (this._d.variableModeBySetMap?.entries ?? [])
        .filter((e: any) => {
          const ref = e.variableSetID;
          const set = ref ? doc.resolveVariableRef(ref.guid ? { guid: ref.guid } : ref) : undefined;
          return !set || guidToString(set.guid) !== id;
        })
        .map((e: any) => structuredClone(e));
    }

    // ------------------------------------------------ variables
    get boundVariables() {
      const out: Record<string, unknown> = {};
      const d = this._d;
      const fieldToProp = Object.fromEntries(Object.entries(FIELD_TO_VARIABLE).map(([k, v]) => [v, k]));
      for (const e of d.variableConsumptionMap?.entries ?? []) {
        const v = e.variableData?.value?.alias
          ? doc.resolveVariableRef(e.variableData.value.alias)
          : undefined;
        const prop = fieldToProp[e.variableField];
        if (v && prop) out[prop] = { type: 'VARIABLE_ALIAS', id: `VariableID:${guidToString(v.guid)}` };
      }
      const fills = (d.fillPaints ?? []).map((p: any) => {
        const v = p.colorVar?.value?.alias ? doc.resolveVariableRef(p.colorVar.value.alias) : undefined;
        return v ? { type: 'VARIABLE_ALIAS', id: `VariableID:${guidToString(v.guid)}` } : undefined;
      });
      if (fills.some(Boolean)) out.fills = fills.filter(Boolean);
      return out;
    }
    setBoundVariable(field: string, variable: any) {
      if (field === 'fills' || field === 'strokes') {
        throw new Error(`Use figma.variables.setBoundVariableForPaint to bind ${field}`);
      }
      const vf = FIELD_TO_VARIABLE[field];
      if (!vf) throw new FigtionalUnsupported(`setBoundVariable('${field}')`);
      if (this.type === 'TEXT') requireFonts(this._d);
      const raw = session.raw(this.id);
      const entries: any[] = (raw.variableConsumptionMap?.entries ?? []).filter(
        (e: any) => e.variableField !== vf,
      );
      if (variable) {
        const v = variableById(doc, variable.id);
        if (!v) throw new Error(`Variable ${variable.id} not found`);
        const resolved =
          v.variableResolvedType === 'BOOLEAN'
            ? 'BOOLEAN'
            : v.variableResolvedType === 'STRING'
              ? 'STRING'
              : 'FLOAT';
        entries.push({
          variableData: {
            value: { alias: { guid: { ...v.guid } } },
            dataType: 'ALIAS',
            resolvedDataType: resolved,
          },
          variableField: vf,
        });
        // Apply the current value so the file and renders are consistent.
        const val = resolveVariable(doc, v);
        if (typeof val === 'number') {
          const setters: Record<string, () => void> = {
            itemSpacing: () => (this.itemSpacing = val),
            paddingLeft: () => (this.paddingLeft = val),
            paddingRight: () => (this.paddingRight = val),
            paddingTop: () => (this.paddingTop = val),
            paddingBottom: () => (this.paddingBottom = val),
            cornerRadius: () => (this.cornerRadius = val),
            opacity: () => (this.opacity = Math.max(0, Math.min(1, val > 1 ? val / 100 : val))),
            strokeWeight: () => (this.strokeWeight = val),
            fontSize: () => (this.fontSize = val),
            width: () => this.resize(val, this.height),
            height: () => this.resize(this.width, val),
          };
          setters[field]?.();
        } else if (typeof val === 'boolean' && field === 'visible') this.visible = val;
      }
      raw.variableConsumptionMap = { entries };
      session.markDirty(this.id);
    }

    // ------------------------------------------------ tree editing
    remove() {
      if (this._s.isInstanceSublayer)
        throw new Error('Cannot remove a layer inside an instance. Hide it instead (visible = false).');
      session.remove(this.id);
    }
    clone() {
      if (this._s.isInstanceSublayer) throw new FigtionalUnsupported('clone() of a layer inside an instance');
      const c = session.clone(this.id);
      return wrap(scene(guidToString(c.guid)));
    }
    set(props: Record<string, unknown>) {
      const entries = Object.entries(props ?? {});
      // layoutMode first, width/height through resize (Figma MCP's node.set semantics).
      entries.sort(([a], [b]) => Number(b === 'layoutMode') - Number(a === 'layoutMode'));
      let w: number | undefined;
      let h: number | undefined;
      for (const [k, v] of entries) {
        if (k === 'width') w = v as number;
        else if (k === 'height') h = v as number;
        else (this as any)[k] = v;
      }
      if (w !== undefined || h !== undefined) this.resize(w ?? this.width, h ?? this.height);
      return this;
    }
    async screenshot(opts: { scale?: number; contentsOnly?: boolean } = {}) {
      session.commit();
      const s = scene(this.id);
      const b = s.absoluteBoundingBox;
      const scale = opts.scale ?? 0.5;
      const maxSize = opts.scale !== undefined ? 8192 : 1024;
      const r = renderPng(doc, s, { scale, maxSize });
      for (const [font, used] of fontFallbacksIn(r.warnings))
        (ctx.drawnFontFallbacks ??= new Map()).set(font, used);
      ctx.images.push({
        data: r.png.toString('base64'),
        caption: `${s.name} (${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}).png`,
      });
      return { width: r.width, height: r.height };
    }
    async exportAsync() {
      throw new FigtionalUnsupported('exportAsync', 'Use node.screenshot() or the get_screenshot tool.');
    }
    get reactions() {
      return deepFreeze([]);
    }
    set reactions(_v: any) {
      throw new FigtionalUnsupported(
        'editing prototype reactions',
        'Prototype editing is planned (PLAN.md M10).',
      );
    }
  }

  /**
   * Text bound to a component property is changed by setting the property on the instance that
   * owns it (an override would be shadowed by the property value, as in Figma).
   */
  function setTextProperty(s: SceneNode, textData: unknown): boolean {
    const d = s.data;
    const ref =
      (d.componentPropRefs ?? []).find((r: any) => !r.isDeleted && r.componentPropNodeField === 'TEXT_DATA')
        ?.defID ??
      (d.parameterConsumptionMap?.entries ?? []).find((e: any) => e.variableField === 'TEXT_DATA')
        ?.variableData?.value?.propRefValue?.defId;
    if (!ref) return false;
    const defId = guidToString(ref);
    for (let p = s.parent; p; p = p.parent) {
      if (p.figType !== 'INSTANCE') continue;
      const main = p.mainComponent;
      const defs = [...(main?.data.componentPropDefs ?? []), ...(main?.parent?.data.componentPropDefs ?? [])];
      const owns = defs.some(
        (def: any) =>
          (def.id && guidToString(def.id) === defId) ||
          (def.parentPropDefId && guidToString(def.parentPropDefId) === defId),
      );
      if (!owns) continue;
      const assignments = (p.data.componentPropAssignments ?? []).filter(
        (a: any) => guidToString(a.defID) !== defId,
      );
      assignments.push({ defID: { ...ref }, value: { textValue: textData } });
      if (p.isInstanceSublayer) session.setOverride(p, { componentPropAssignments: assignments });
      else {
        session.raw(p.id).componentPropAssignments = assignments;
        session.markDirty(p.id);
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ query()
  function matchesSimple(node: any, sel: string): boolean {
    const m = /^([A-Z_*]+)?(#[\w:;-]+)?((?:\[[^\]]+\])*)((?::[\w-]+(?:\([^)]*\))?)*)$/.exec(sel.trim());
    if (!m) throw new Error(`Invalid selector "${sel}"`);
    const [, type, id, attrs, pseudos] = m;
    if (type && type !== '*' && node.type !== type) return false;
    if (id && node.id !== id.slice(1)) return false;
    for (const a of attrs!.match(/\[[^\]]+\]/g) ?? []) {
      const am = /^\[([\w.*]+)\s*(\*=|\^=|\$=|=)?\s*"?([^"\]]*)"?\]$/.exec(a);
      if (!am) throw new Error(`Invalid attribute selector ${a}`);
      const [, path, op, val] = am;
      const values = getPath(node, path!.split('.'));
      const ok = values.some((v) => {
        if (!op) return v !== undefined && v !== null;
        const s = String(v);
        return op === '='
          ? s === val
          : op === '*='
            ? s.includes(val!)
            : op === '^='
              ? s.startsWith(val!)
              : s.endsWith(val!);
      });
      if (!ok) return false;
    }
    for (const p of pseudos!.match(/:[\w-]+(?:\([^)]*\))?/g) ?? []) {
      const siblings: any[] = node.parent?.children ?? [];
      const i = siblings.findIndex((x) => x.id === node.id);
      if (p === ':first-child' && i !== 0) return false;
      if (p === ':last-child' && i !== siblings.length - 1) return false;
      const nth = /^:nth-child\((\d+)\)$/.exec(p);
      if (nth && i !== Number(nth[1]) - 1) return false;
      const not = /^:not\((.*)\)$/.exec(p);
      if (not && matchesSimple(node, not[1]!)) return false;
    }
    return true;
  }
  function getPath(obj: any, parts: string[]): any[] {
    if (!parts.length) return [obj];
    const [head, ...rest] = parts;
    if (obj === null || obj === undefined) return [];
    if (head === '*') return Array.isArray(obj) ? obj.flatMap((x) => getPath(x, rest)) : [];
    let next: any;
    try {
      next = head === 'mainComponent' ? obj.mainComponent : obj[head!];
    } catch {
      return [];
    }
    if (head === 'mainComponent' && rest.length === 0) return [next?.id];
    return getPath(next, rest);
  }
  function querySelector(root: any, selector: string): any[] {
    const results = new Map<string, any>();
    for (const part of selector.split(',')) {
      const tokens = part
        .trim()
        .replace(/\s*>\s*/g, ' > ')
        .split(/\s+/)
        .filter(Boolean);
      let current: any[] = [root];
      let combinator: 'desc' | 'child' = 'desc';
      for (const tok of tokens) {
        if (tok === '>') {
          combinator = 'child';
          continue;
        }
        const next: any[] = [];
        for (const c of current) {
          const pool = combinator === 'child' ? (c.children ?? []) : c.findAll();
          for (const n of pool) if (matchesSimple(n, tok)) next.push(n);
        }
        current = next;
        combinator = 'desc';
      }
      for (const n of current) if (n !== root) results.set(n.id, n);
    }
    return [...results.values()];
  }
  function makeQueryResult(nodes: any[]) {
    return Object.assign([...nodes], {
      first: () => nodes[0] ?? null,
      last: () => nodes[nodes.length - 1] ?? null,
      toArray: () => [...nodes],
      each: (fn: (n: any, i: number) => void) => (nodes.forEach(fn), undefined),
      values: (keys: string[]) => nodes.map((n) => Object.fromEntries(keys.map((k) => [k, n[k]]))),
      set: (props: Record<string, unknown>) => (nodes.forEach((n) => n.set(props)), makeQueryResult(nodes)),
      query: (sel: string) => makeQueryResult(nodes.flatMap((n) => querySelector(n, sel))),
    });
  }

  // ------------------------------------------------------------------ creation helpers
  const pageId = () => {
    if (!currentPageId || !doc.getNodeById(currentPageId)) currentPageId = firstPage()?.id;
    if (!currentPageId) throw new Error('This file has no pages');
    return currentPageId;
  };
  const create = (type: string, fields: Record<string, unknown>) => {
    const n = session.create(type, pageId(), undefined, {
      name: (fields.name as string | undefined) ?? defaultName(type),
      visible: true,
      opacity: 1,
      size: { x: 100, y: 100 },
      transform: { ...IDENTITY_T },
      strokeWeight: 1,
      strokeAlign: type === 'TEXT' || type === 'LINE' || type === 'VECTOR' ? 'CENTER' : 'INSIDE',
      strokeJoin: 'MITER',
      ...fields,
    });
    return wrap(scene(guidToString(n.guid)));
  };
  const counters = new Map<string, number>();
  const defaultName = (type: string) => {
    const base =
      {
        ROUNDED_RECTANGLE: 'Rectangle',
        ELLIPSE: 'Ellipse',
        FRAME: 'Frame',
        TEXT: 'Text',
        LINE: 'Line',
        SYMBOL: 'Component',
        SECTION: 'Section',
      }[type] ?? type;
    const existing = [...doc.nodes.values()].filter((n) => n.type === type).length;
    const i = (counters.get(type) ?? existing) + 1;
    counters.set(type, i);
    return `${base} ${i}`;
  };
  const WHITE = {
    type: 'SOLID',
    color: { r: 1, g: 1, b: 1, a: 1 },
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
  };
  const GREY = {
    type: 'SOLID',
    color: { r: 0.851, g: 0.851, b: 0.851, a: 1 },
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
  };
  const BLACK = {
    type: 'SOLID',
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
  };

  // ------------------------------------------------------------------ variables API
  const variableApi = (v: NodeChange) => {
    const id = guidToString(v.guid);
    const api = {
      get id() {
        return `VariableID:${id}`;
      },
      get key() {
        return v.key ?? id;
      },
      get name() {
        return v.name ?? '';
      },
      set name(n: string) {
        session.raw(id).name = String(n);
        session.markDirty(id);
      },
      get resolvedType() {
        return v.variableResolvedType;
      },
      get variableCollectionId() {
        const c = doc.resolveVariableRef(
          v.variableSetID?.guid ? { guid: v.variableSetID.guid } : v.variableSetID,
        );
        return c ? `VariableCollectionId:${guidToString(c.guid)}` : '';
      },
      get description() {
        return v.description ?? '';
      },
      set description(d: string) {
        session.raw(id).description = String(d);
        session.markDirty(id);
      },
      get remote() {
        return !!v.sourceLibraryKey;
      },
      get scopes() {
        return v.variableScopes ?? ['ALL_SCOPES'];
      },
      set scopes(s: string[]) {
        session.raw(id).variableScopes = [...s];
        session.markDirty(id);
      },
      get valuesByMode() {
        const out: Record<string, unknown> = {};
        for (const e of v.variableDataValues?.entries ?? []) {
          const val = e.variableData?.value ?? {};
          const mode = `${guidToString(e.modeID)}`;
          if (val.alias) {
            const t = doc.resolveVariableRef(val.alias);
            out[mode] = { type: 'VARIABLE_ALIAS', id: t ? `VariableID:${guidToString(t.guid)}` : '' };
          } else if (val.colorValue) out[mode] = { ...val.colorValue };
          else out[mode] = val.floatValue ?? val.boolValue ?? val.textValue ?? null;
        }
        return out;
      },
      setValueForMode(modeId: string, value: any) {
        const raw = session.raw(id);
        const type = raw.variableResolvedType;
        let data: any;
        if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
          const t = variableById(doc, value.id);
          if (!t) throw new Error(`Variable ${value.id} not found`);
          data = { value: { alias: { guid: { ...t.guid } } }, dataType: 'ALIAS', resolvedDataType: type };
        } else if (type === 'COLOR') {
          if (!value || typeof value !== 'object') throw new Error('Expected a color value { r, g, b, a? }');
          checkKeys(value, ['r', 'g', 'b', 'a'], 'value');
          data = {
            value: {
              colorValue: {
                r: clamp01(value.r, 'value.r'),
                g: clamp01(value.g, 'value.g'),
                b: clamp01(value.b, 'value.b'),
                a: value.a ?? 1,
              },
            },
            dataType: 'COLOR',
            resolvedDataType: 'COLOR',
          };
        } else if (type === 'FLOAT')
          data = { value: { floatValue: Number(value) }, dataType: 'FLOAT', resolvedDataType: 'FLOAT' };
        else if (type === 'BOOLEAN')
          data = { value: { boolValue: !!value }, dataType: 'BOOLEAN', resolvedDataType: 'BOOLEAN' };
        else data = { value: { textValue: String(value) }, dataType: 'STRING', resolvedDataType: 'STRING' };
        const mode = normalizeNodeId(String(modeId).replace(/^.*?(\d+:\d+)$/, '$1'));
        if (!mode) throw new Error(`Invalid mode id ${modeId}`);
        const entries: any[] = raw.variableDataValues?.entries ?? [];
        const existing = entries.find((e) => guidToString(e.modeID) === mode);
        if (existing) existing.variableData = data;
        else entries.push({ modeID: parseGuidStr(mode), variableData: data });
        raw.variableDataValues = { entries };
        session.markDirty(id);
      },
      setVariableCodeSyntax(platform: string, value: string) {
        const raw = session.raw(id);
        const entries: any[] = (raw.codeSyntax?.entries ?? []).filter((e: any) => e.platform !== platform);
        entries.push({ platform, value: String(value) });
        raw.codeSyntax = { entries };
        session.markDirty(id);
      },
      remove() {
        session.remove(id);
      },
    };
    return Object.preventExtensions(api);
  };

  const collectionApi = (c: NodeChange) => {
    const id = guidToString(c.guid);
    return Object.preventExtensions({
      get id() {
        return `VariableCollectionId:${id}`;
      },
      get key() {
        return c.key ?? id;
      },
      get name() {
        return c.name ?? '';
      },
      set name(n: string) {
        session.raw(id).name = String(n);
        session.markDirty(id);
      },
      get remote() {
        return !!c.sourceLibraryKey;
      },
      get modes() {
        return collectionInfo(doc, c).modes.map((m) => ({ modeId: m.modeId, name: m.name }));
      },
      get defaultModeId() {
        return collectionInfo(doc, c).defaultModeId;
      },
      get variableIds() {
        return collectionInfo(doc, c).variableIds.map((v) => `VariableID:${v}`);
      },
      addMode(name: string) {
        const raw = session.raw(id);
        const modes: any[] = raw.variableSetModes ?? [];
        const guid = session.newGuid();
        modes.push({
          id: guid,
          name: String(name),
          sortPosition: session.positionAtList(modes.map((m) => m.sortPosition)),
        });
        raw.variableSetModes = modes;
        session.markDirty(id);
        return guidToString(guid);
      },
      renameMode(modeId: string, name: string) {
        const m = (session.raw(id).variableSetModes ?? []).find((x: any) => guidToString(x.id) === modeId);
        if (!m) throw new Error(`Mode ${modeId} not found`);
        m.name = String(name);
        session.markDirty(id);
      },
      removeMode(modeId: string) {
        const raw = session.raw(id);
        raw.variableSetModes = (raw.variableSetModes ?? []).filter((x: any) => guidToString(x.id) !== modeId);
        session.markDirty(id);
      },
      remove() {
        for (const v of collectionInfo(doc, c).variableIds) session.remove(v);
        session.remove(id);
      },
    });
  };

  const parseGuidStr = (s: string): GUID => {
    const [a, b] = s.split(':').map(Number);
    return { sessionID: a!, localID: b! };
  };

  const variables = {
    async getLocalVariablesAsync(type?: string) {
      return doc.variables
        .filter((v) => !v.sourceLibraryKey && (!type || v.variableResolvedType === type))
        .map(variableApi);
    },
    async getLocalVariableCollectionsAsync() {
      return doc.variableCollections.filter((c) => !c.sourceLibraryKey).map(collectionApi);
    },
    async getVariableByIdAsync(id: string) {
      const v = variableById(doc, id);
      return v ? variableApi(v) : null;
    },
    getVariableById(id: string) {
      const v = variableById(doc, id);
      return v ? variableApi(v) : null;
    },
    async getVariableCollectionByIdAsync(id: string) {
      const c = collectionById(doc, id);
      return c ? collectionApi(c) : null;
    },
    async importVariableByKeyAsync(key: string) {
      const v = doc.getByKey(key);
      if (v?.type !== 'VARIABLE') {
        throw new FigtionalUnsupported(
          `importVariableByKeyAsync('${key}')`,
          'Only library variables embedded in this .fig file can be imported.',
        );
      }
      return variableApi(v);
    },
    createVariableCollection(name: string) {
      const page = session.internalPage();
      const modeId = session.newGuid();
      const c = session.create('VARIABLE_SET', guidToString(page.guid), undefined, {
        name: String(name),
        isPublishable: true,
        variableSetModes: [{ id: modeId, name: 'Mode 1', sortPosition: '!' }],
        isCollectionExtendable: true,
      });
      return collectionApi(c);
    },
    createVariable(name: string, collection: any, type: string) {
      const cId = typeof collection === 'string' ? collection : collection?.id;
      const c = collectionById(doc, cId);
      if (!c) throw new Error(`Variable collection ${cId} not found`);
      if (!['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'].includes(type))
        throw new Error(`Invalid variable type "${type}"`);
      const page = session.internalPage();
      const defaults: Record<string, any> = {
        COLOR: {
          value: { colorValue: { r: 0, g: 0, b: 0, a: 1 } },
          dataType: 'COLOR',
          resolvedDataType: 'COLOR',
        },
        FLOAT: { value: { floatValue: 0 }, dataType: 'FLOAT', resolvedDataType: 'FLOAT' },
        STRING: { value: { textValue: '' }, dataType: 'STRING', resolvedDataType: 'STRING' },
        BOOLEAN: { value: { boolValue: false }, dataType: 'BOOLEAN', resolvedDataType: 'BOOLEAN' },
      };
      const v = session.create('VARIABLE', guidToString(page.guid), undefined, {
        name: String(name),
        isPublishable: true,
        variableSetID: { guid: { ...c.guid } },
        variableResolvedType: type,
        variableDataValues: {
          entries: (c.variableSetModes ?? []).map((m: any) => ({
            modeID: { ...m.id },
            variableData: structuredClone(defaults[type]),
          })),
        },
      });
      return variableApi(v);
    },
    createVariableAlias(v: any) {
      return { type: 'VARIABLE_ALIAS', id: v.id };
    },
    setBoundVariableForPaint(paint: any, field: string, variable: any) {
      if (field !== 'color') throw new Error(`Cannot bind field "${field}" of a paint`);
      const copy = { ...paint };
      if (variable) {
        const v = variableById(doc, variable.id);
        if (!v) throw new Error(`Variable ${variable.id} not found`);
        const val = resolveVariable(doc, v);
        if (val && typeof val === 'object' && 'r' in val) copy.color = { r: val.r, g: val.g, b: val.b };
        copy.boundVariables = {
          ...(paint.boundVariables ?? {}),
          color: { type: 'VARIABLE_ALIAS', id: variable.id },
        };
      } else {
        const { color: _c, ...rest } = paint.boundVariables ?? {};
        copy.boundVariables = rest;
      }
      return copy;
    },
    setBoundVariableForEffect() {
      throw new FigtionalUnsupported('setBoundVariableForEffect');
    },
    setBoundVariableForLayoutGrid() {
      throw new FigtionalUnsupported('setBoundVariableForLayoutGrid');
    },
  };

  // ------------------------------------------------------------------ figma global
  const notSupported = (name: string) => () => {
    throw new Error(`"${name}" is not a supported API`);
  };
  const figma: any = {
    apiVersion: '1.0.0',
    editorType: 'figma',
    mode: 'default',
    fileKey: ctx.fileKey,
    mixed: MIXED,
    get root() {
      return wrap(doc.root);
    },
    get currentPage() {
      return wrap(scene(pageId()));
    },
    set currentPage(_p: any) {
      throw new Error(
        'Setting figma.currentPage is not supported. Use await figma.setCurrentPageAsync(page) instead.',
      );
    },
    async setCurrentPageAsync(page: any) {
      if (page?.type !== 'PAGE') throw new Error('Expected a page node');
      currentPageId = page.id;
    },
    async loadAllPagesAsync() {},
    async getNodeByIdAsync(id: string) {
      const norm = normalizeNodeId(String(id));
      return norm ? wrap(doc.getNodeById(norm)) : null;
    },
    getNodeById(id: string) {
      const norm = normalizeNodeId(String(id));
      return norm ? wrap(doc.getNodeById(norm)) : null;
    },
    async loadFontAsync(font: { family: string; style: string }) {
      if (!font?.family || !font?.style) throw new Error('loadFontAsync expects { family, style }');
      loadedFonts.add(fontKey(font));
    },
    async listAvailableFontsAsync() {
      const used = new Map<string, { family: string; style: string }>();
      for (const n of doc.nodes.values())
        if (n.fontName) used.set(fontKey(n.fontName), { family: n.fontName.family, style: n.fontName.style });
      const sys = availableFonts().map((f) => f.fontName);
      for (const f of sys) used.set(fontKey(f), f);
      return [...used.values()].map((fontName) => ({ fontName }));
    },
    createFrame() {
      return create('FRAME', { fillPaints: [structuredClone(WHITE)], frameMaskDisabled: false });
    },
    createAutoLayout(direction?: any, props?: any) {
      if (direction && typeof direction === 'object') [direction, props] = ['HORIZONTAL', direction];
      const f = create('FRAME', {
        stackMode: direction === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL',
        stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
        frameMaskDisabled: false,
        size: { x: 0, y: 0 },
      });
      if (props) f.set(props);
      return f;
    },
    createComponent() {
      return create('SYMBOL', { fillPaints: [structuredClone(WHITE)], frameMaskDisabled: false });
    },
    createComponentFromNode(node: any) {
      if (!node || node.type === 'PAGE') throw new Error('Expected a node');
      const raw = session.raw(node.id);
      if (raw.type === 'INSTANCE' || raw.type === 'SYMBOL')
        throw new Error('Cannot create a component from a component or instance');
      raw.type = 'SYMBOL';
      session.markDirty(node.id);
      doc.reindex();
      return wrap(scene(node.id));
    },
    createRectangle() {
      return create('ROUNDED_RECTANGLE', { fillPaints: [structuredClone(GREY)] });
    },
    createEllipse() {
      return create('ELLIPSE', { fillPaints: [structuredClone(GREY)] });
    },
    createLine() {
      return create('LINE', { size: { x: 100, y: 0 }, strokePaints: [structuredClone(BLACK)] });
    },
    createText() {
      return create('TEXT', {
        size: { x: 0, y: 0 },
        fontSize: 12,
        fontName: { family: 'Inter', style: 'Regular', postscript: '' },
        lineHeight: { value: 100, units: 'PERCENT' },
        letterSpacing: { value: 0, units: 'PERCENT' },
        textAutoResize: 'WIDTH_AND_HEIGHT',
        textAlignHorizontal: 'LEFT',
        textAlignVertical: 'TOP',
        fillPaints: [structuredClone(BLACK)],
        autoRename: true,
        textData: {
          characters: '',
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
      });
    },
    createSection() {
      return create('SECTION', { fillPaints: [structuredClone(WHITE)] });
    },
    createPage() {
      const internal = doc.allPages.findIndex((p) => isInternalPage(p.data));
      const index = internal >= 0 ? internal : undefined;
      const n = session.create('CANVAS', guidToString(doc.root.guid), index, {
        name: `Page ${doc.pages.length + 1}`,
        visible: true,
        opacity: 1,
        transform: { ...IDENTITY_T },
        backgroundColor: { r: 0.9607843160629272, g: 0.9607843160629272, b: 0.9607843160629272, a: 1 },
        backgroundEnabled: true,
        backgroundOpacity: 1,
      });
      return wrap(scene(guidToString(n.guid)));
    },
    combineAsVariants(nodes: any[], parent: any, index?: number) {
      if (!Array.isArray(nodes) || !nodes.length)
        throw new Error('combineAsVariants requires an array of components');
      if (nodes.some((n) => n?.type !== 'COMPONENT'))
        throw new Error('combineAsVariants: all nodes must be ComponentNodes');
      if (!parent || !('appendChild' in parent)) throw new Error('combineAsVariants requires a parent node');
      const set = components.combineAsVariants(
        nodes.map((n) => n.id),
        parent.id,
        index,
      );
      return wrap(scene(guidToString(set.guid)));
    },
    group() {
      throw new FigtionalUnsupported('figma.group', 'Use a frame (createFrame / createAutoLayout) instead.');
    },
    createVector: notSupportedFigtional('createVector'),
    createNodeFromSvg: notSupportedFigtional('createNodeFromSvg'),
    createImage: notSupportedFigtional('createImage', 'Only images already in the file can be used.'),
    createImageAsync: notSupportedFigtional(
      'createImageAsync',
      'Only images already in the file can be used.',
    ),
    getImageByHash(hash: string) {
      return doc.archive?.image(hash) ? { hash } : null;
    },
    async importComponentByKeyAsync(key: string) {
      const c = [...doc.nodes.values()].find(
        (n) => n.type === 'SYMBOL' && (n.componentKey === key || n.key === key),
      );
      if (!c)
        throw new FigtionalUnsupported(
          `importComponentByKeyAsync('${key}')`,
          'Only library components embedded in this .fig file can be imported.',
        );
      return wrap(scene(guidToString(c.guid)));
    },
    async importComponentSetByKeyAsync(key: string) {
      const c = [...doc.nodes.values()].find(
        (n) => n.isStateGroup && (n.componentKey === key || n.key === key),
      );
      if (!c)
        throw new FigtionalUnsupported(
          `importComponentSetByKeyAsync('${key}')`,
          'Only library component sets embedded in this .fig file can be imported.',
        );
      return wrap(scene(guidToString(c.guid)));
    },
    async importStyleByKeyAsync(key: string) {
      const s = doc.getByKey(String(key));
      if (!s?.styleType || s.styleType === 'NONE')
        throw new FigtionalUnsupported(
          `importStyleByKeyAsync('${key}')`,
          'Only library styles embedded in this .fig file can be imported.',
        );
      return styles.wrap(s);
    },
    async getStyleByIdAsync(id: string) {
      return styles.get(String(id));
    },
    getStyleById(id: string) {
      return styles.get(String(id));
    },
    variables,
    util: {
      rgb(input: any) {
        return parseColor(input, false);
      },
      rgba(input: any) {
        return parseColor(input, true);
      },
      solidPaint(color: any, overrides: Record<string, unknown> = {}) {
        const c = typeof color === 'string' ? parseColor(color, true) : color;
        const { a, ...rgb } = c;
        return { type: 'SOLID', color: rgb, opacity: a ?? 1, ...overrides };
      },
      getSfSymbolCharacter: notSupportedFigtional('util.getSfSymbolCharacter'),
    },
    viewport: {
      center: { x: 0, y: 0 },
      zoom: 1,
      scrollAndZoomIntoView() {},
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    },
    notify() {
      throw new Error('not implemented');
    },
    closePlugin() {},
    showUI() {},
    openExternal() {},
    ui: { postMessage() {}, onmessage: null, resize() {}, close() {} },
    clientStorage: { getAsync: notSupported('clientStorage'), setAsync: notSupported('clientStorage') },
    on: notSupported('figma.on'),
    once: notSupported('figma.once'),
    off: notSupported('figma.off'),
    getLocalTextStylesAsync: async () => styles.local('TEXT'),
    getLocalPaintStylesAsync: async () => styles.local('PAINT'),
    getLocalEffectStylesAsync: async () => styles.local('EFFECT'),
    getLocalGridStylesAsync: async () => styles.local('GRID'),
    createTextStyle: () => styles.create('TEXT'),
    createPaintStyle: () => styles.create('PAINT'),
    createEffectStyle: () => styles.create('EFFECT'),
    createGridStyle: () => styles.create('GRID'),
    teamLibrary: { getAvailableLibraryVariableCollectionsAsync: async () => [] },
  };
  return figma;

  function notSupportedFigtional(name: string, detail = '') {
    return () => {
      throw new FigtionalUnsupported(name, detail);
    };
  }
}

function parseColor(input: any, alpha: boolean) {
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
