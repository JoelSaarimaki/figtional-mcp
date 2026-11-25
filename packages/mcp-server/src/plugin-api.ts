/**
 * A subset of Figma's Plugin API (`figma` global and node objects) on top of fig-model, for the
 * use_figma tool. Behaviour, names and error messages follow Figma where known
 * (docs/figma-mcp-tools.md §5); unsupported APIs throw NotSupportedInFigtional.
 */
import {
  type NodeChange,
  decodeVectorNetwork,
  encodeVectorNetwork,
  guidToString,
} from '@figtional/fig-format';
import {
  ComponentOps,
  type EditSession,
  type FigDocument,
  type SceneNode,
  availableFonts,
  resolveVariableAt,
  isInternalPage,
  normalizeNodeId,
  rotationDegrees,
  stackProps,
  type Subpath,
  SvgUnsupported,
  mergeNetwork,
  parseSvgDocument,
  subpathBounds,
  subpathsToNetwork,
  transformSubpaths,
  textDataOf,
  INSTANCE_FIELDS,
  invert,
  multiply,
  transformedBounds,
  isGroupData,
  outlineOf,
} from '@figtional/fig-model';
import { fontFallbacksIn, renderPng, renderSvg } from '@figtional/fig-render';
import { nodeCss } from './design-context.js';

import { FigtionalUnsupported } from './unsupported.js';
import {
  FIELD_TO_VARIABLE,
  IDENTITY_T,
  MIXED,
  clamp01,
  componentKeyOf,
  deepFreeze,
  effectFromPlugin,
  effectToPlugin,
  paintFromPlugin,
  paintToPlugin,
  parseColor,
} from './plugin-values.js';
import { createStyleApi } from './plugin-styles.js';
import { imageInfo } from './image-size.js';
import { type PluginRuntime, mixMembers } from './plugin-runtime.js';
import { makeQueryResult, querySelector } from './plugin-query.js';
import { createVariablesApi } from './plugin-variables.js';
import { componentsMembers } from './node-components.js';
import { layoutMembers } from './node-layout.js';
import { paintMembers } from './node-paint.js';
import { stylesMembers } from './node-styles.js';
import { textMembers } from './node-text.js';
import { variablesMembers } from './node-variables.js';
import { vectorsMembers } from './node-vectors.js';

export { FigtionalUnsupported };

/** Plugin id under which use_figma's own plugin data is stored (Figma MCP's id isn't known). */
const PLUGIN_ID = 'figma-mcp-use-figma';
const checkNamespace = (ns: string) => {
  if (typeof ns !== 'string' || !/^[A-Za-z0-9_.]{3,}$/.test(ns))
    throw new Error('Invalid namespace: it must be at least 3 characters of letters, digits, _ and .');
};

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

  /**
   * Stores subpaths (in the parent's coordinates) as a vector node's network: the node is placed
   * at the paths' bounds and the network is relative to that corner (Figma's normalizedSize).
   */
  const vectorFields = (paths: Subpath[], fill: 'NONZERO' | 'ODD' | null, extra: Subpath[] = []) => {
    const all = [...paths, ...extra];
    const b = subpathBounds(all);
    const shift = { m00: 1, m01: 0, m02: -b.x, m10: 0, m11: 1, m12: -b.y };
    const net = subpathsToNetwork(transformSubpaths(paths, shift), fill);
    if (extra.length) mergeNetwork(net, subpathsToNetwork(transformSubpaths(extra, shift), null));
    const size = { x: Math.max(b.width, 0.01), y: Math.max(b.height, 0.01) };
    return {
      size,
      transform: { m00: 1, m01: 0, m02: b.x, m10: 0, m11: 1, m12: b.y },
      vectorData: {
        vectorNetworkBlob: session.addBlob(encodeVectorNetwork(net)),
        normalizedSize: { ...size },
      },
    };
  };
  const networkOf = (d: NodeChange) => {
    const i = d.vectorData?.vectorNetworkBlob;
    return i === undefined || !doc.blobs[i]
      ? { vertices: [], segments: [], regions: [] }
      : decodeVectorNetwork(doc.blobs[i]!.bytes);
  };

  const VARIABLE_TO_FIELD: Record<string, string> = Object.fromEntries(
    Object.entries(FIELD_TO_VARIABLE).map(([k, v]) => [v, k]),
  );

  /**
   * Writes a bound variable's value, resolved in the mode in effect at the node, into the bound
   * field (Figma shows the stored value after import, see docs/fig-format.md §9.3). Text values
   * are written directly, so a mode change doesn't need the fonts loaded (as in Figma).
   */
  const applyBoundValue = (n: SceneNode, variableField: string, v: NodeChange) => {
    const field = VARIABLE_TO_FIELD[variableField];
    const val = resolveVariableAt(doc, n, v);
    if (!field || val === undefined || val === null || typeof val === 'object') return;
    const raw = session.raw(n.id);
    if (field === 'characters') {
      if (n.figType !== 'TEXT') return;
      raw.textData = { ...textDataOf(String(val)) };
      delete raw.derivedTextData;
      session.markText(n.id);
    } else if (field === 'visible') {
      raw.visible = val === true || val === 'true';
      session.markDirty(n.id);
    } else if (typeof val === 'number') {
      if (field === 'fontSize') raw.fontSize = val;
      else if (field === 'letterSpacing') raw.letterSpacing = { value: val, units: 'PIXELS' };
      else if (field === 'lineHeight') raw.lineHeight = { value: val, units: 'PIXELS' };
      else {
        const node = wrap(n);
        if (field === 'opacity') node.opacity = Math.max(0, Math.min(1, val > 1 ? val / 100 : val));
        else if (field === 'width') node.resize(val, node.height);
        else if (field === 'height') node.resize(node.width, val);
        else if (field in node) node[field] = val;
        return;
      }
      if (n.figType === 'TEXT') session.markText(n.id);
      else session.markDirty(n.id);
    }
  };

  /**
   * After a mode change, stores each bound value (paint colours and every bound field) as resolved
   * in the mode now in effect, so the stored values match the variables.
   */
  const syncBoundValues = (rootId: string) => {
    scene(rootId).walk((n) => {
      if (n.isInstanceSublayer) return false;
      let changed = false;
      for (const field of ['fillPaints', 'strokePaints'] as const) {
        for (const p of session.raw(n.id)[field] ?? []) {
          const alias = p.colorVar?.value?.alias;
          const v = alias ? doc.resolveVariableRef(alias) : undefined;
          const val = v ? resolveVariableAt(doc, n, v) : undefined;
          if (val && typeof val === 'object' && 'r' in val) {
            p.color = { r: val.r, g: val.g, b: val.b, a: val.a ?? 1 };
            changed = true;
          }
        }
      }
      if (changed) session.markDirty(n.id);
      for (const e of n.data.variableConsumptionMap?.entries ?? []) {
        const alias = e.variableData?.value?.alias;
        const v = alias ? doc.resolveVariableRef(alias) : undefined;
        if (v) applyBoundValue(n, e.variableField, v);
      }
      return true;
    });
  };

  const imageApi = (hash: string) => ({
    hash,
    async getBytesAsync() {
      return Uint8Array.from(doc.archive!.image(hash)!);
    },
    async getSizeAsync() {
      const info = imageInfo(doc.archive!.image(hash)!);
      if (!info) throw new Error('Image type is unsupported');
      return { width: info.width, height: info.height };
    },
  });

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
    const rootFields = Object.keys(fields).filter((f) => (INSTANCE_FIELDS as readonly string[]).includes(f));
    if (!rootFields.length) return;
    // An instance's own root value is an override at guidPath [component id], as Figma stores it.
    if (raw.type === 'INSTANCE') recordRootOverride(raw, rootFields);
    // A component's root value reaches its instances, except where they override it.
    if (raw.type === 'SYMBOL') propagateRootFields(raw, rootFields);
  };

  const rootOverrideOf = (inst: NodeChange, create: boolean): any => {
    const sym = inst.symbolData?.symbolID;
    if (!sym) return undefined;
    const list: any[] = inst.symbolData.symbolOverrides ?? [];
    let entry = list.find(
      (o) => o.guidPath?.guids?.length === 1 && guidToString(o.guidPath.guids[0]) === guidToString(sym),
    );
    if (!entry && create) {
      entry = { guidPath: { guids: [{ ...sym }] } };
      inst.symbolData = { ...inst.symbolData, symbolOverrides: [...list, entry] };
    }
    return entry;
  };
  const recordRootOverride = (inst: NodeChange, fields: string[]) => {
    const entry = rootOverrideOf(inst, true);
    if (!entry) return;
    for (const f of fields) entry[f] = structuredClone(inst[f]);
  };
  const propagateRootFields = (symbol: NodeChange, fields: string[]) => {
    const symId = guidToString(symbol.guid);
    for (const n of doc.message.nodeChanges) {
      if (
        n.type !== 'INSTANCE' ||
        guidToString(n.symbolData?.symbolID ?? symbol.guid) !== symId ||
        n === symbol
      )
        continue;
      if (!n.symbolData?.symbolID) continue;
      const overridden = rootOverrideOf(n, false) ?? {};
      let changed = false;
      for (const f of fields) {
        if (f in overridden) continue;
        if (symbol[f] !== undefined) n[f] = structuredClone(symbol[f]);
        else delete n[f];
        changed = true;
      }
      if (changed) session.markDirty(guidToString(n.guid));
    }
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
      // In Figma, naming a text layer stops it from following its content (autoRename = false).
      const fixed = this.type === 'TEXT' && !scene(this.id).isInstanceSublayer;
      editRaw(this.id, fixed ? { name: String(v), autoRename: false } : { name: String(v) });
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
    // Plugin data is stored as { pluginID, key, value } (verified). Shared plugin data uses an
    // empty pluginID and "<namespace>-<key>" (assumed from Futurice: "tokens-fill" etc.).
    private pluginEntries(): any[] {
      return doc.getNodeById(this.id)?.data.pluginData ?? [];
    }
    private writePluginData(pluginID: string, key: string, value: string) {
      if (scene(this.id).isInstanceSublayer)
        throw new FigtionalUnsupported('plugin data on a layer inside an instance');
      const raw = session.raw(this.id);
      const list = (raw.pluginData ?? []).filter((e: any) => !(e.pluginID === pluginID && e.key === key));
      if (value !== '') list.push({ pluginID, value, key });
      if (list.length) raw.pluginData = list;
      else delete raw.pluginData;
      session.markDirty(this.id);
    }
    getPluginData(key: string) {
      return this.pluginEntries().find((e) => e.pluginID === PLUGIN_ID && e.key === String(key))?.value ?? '';
    }
    setPluginData(key: string, value: string) {
      if (typeof value !== 'string') throw new Error('setPluginData value must be a string');
      this.writePluginData(PLUGIN_ID, String(key), value);
    }
    getPluginDataKeys() {
      return this.pluginEntries()
        .filter((e) => e.pluginID === PLUGIN_ID)
        .map((e) => e.key);
    }
    getSharedPluginData(namespace: string, key: string) {
      checkNamespace(namespace);
      const k = `${namespace}-${key}`;
      return this.pluginEntries().find((e) => e.pluginID === '' && e.key === k)?.value ?? '';
    }
    setSharedPluginData(namespace: string, key: string, value: string) {
      checkNamespace(namespace);
      if (typeof value !== 'string') throw new Error('setSharedPluginData value must be a string');
      this.writePluginData('', `${namespace}-${key}`, value);
    }
    getSharedPluginDataKeys(namespace: string) {
      checkNamespace(namespace);
      const prefix = `${namespace}-`;
      return this.pluginEntries()
        .filter((e) => e.pluginID === '' && e.key.startsWith(prefix))
        .map((e) => e.key.slice(prefix.length));
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
    async exportAsync(settings: { format?: string; constraint?: { type: string; value: number } } = {}) {
      session.commit();
      const s = scene(this.id);
      const format = settings.format ?? 'PNG';
      if (format === 'SVG' || format === 'SVG_STRING') {
        const r = renderSvg(doc, s);
        for (const [font, used] of fontFallbacksIn(r.warnings))
          (ctx.drawnFontFallbacks ??= new Map()).set(font, used);
        return format === 'SVG_STRING' ? r.svg : Uint8Array.from(Buffer.from(r.svg));
      }
      if (format === 'PNG') {
        const c = settings.constraint;
        const scale =
          c?.type === 'WIDTH'
            ? c.value / Math.max(s.width, 1e-6)
            : c?.type === 'HEIGHT'
              ? c.value / Math.max(s.height, 1e-6)
              : (c?.value ?? 1);
        const r = renderPng(doc, s, { scale, maxSize: 4096 });
        for (const [font, used] of fontFallbacksIn(r.warnings))
          (ctx.drawnFontFallbacks ??= new Map()).set(font, used);
        return Uint8Array.from(r.png);
      }
      if (['JPG', 'PDF', 'JSON_REST_V1'].includes(format))
        throw new FigtionalUnsupported(
          `exportAsync with format ${format}`,
          'PNG, SVG and SVG_STRING are supported.',
        );
      throw new Error(`Invalid export format "${format}"`);
    }
    async getCSSAsync() {
      session.commit();
      return nodeCss(doc, ctx.fileKey, scene(this.id));
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
        GROUP: 'Group',
        REGULAR_POLYGON: 'Polygon',
        STAR: 'Star',
      }[type] ?? type;
    const existing =
      type === 'GROUP'
        ? [...doc.nodes.values()].filter((n) => isGroupData(n)).length
        : [...doc.nodes.values()].filter((n) => n.type === type).length;
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
  const notSupported = (name: string) => () => {
    throw new Error(`"${name}" is not a supported API`);
  };
  // Node members live in node-*.ts modules; they reach these helpers through the runtime.
  const rt: PluginRuntime = {
    FRAMELIKE,
    components,
    detachStyle,
    doc,
    dynamicPage,
    editRaw,
    isFontLoaded,
    networkOf,
    pageId,
    requireFonts,
    scene,
    session,
    setTextProperty,
    styles,
    applyBoundValue,
    syncBoundValues,
    typeError,
    vectorFields,
    wrap,
    wrappers,
  };
  mixMembers(
    Node,
    paintMembers(rt),
    layoutMembers(rt),
    textMembers(rt),
    vectorsMembers(rt),
    stylesMembers(rt),
    componentsMembers(rt),
    variablesMembers(rt),
  );

  /**
   * Wraps layers in a new parent node (group or boolean operation) without moving them on the
   * canvas; the new node starts at the layers' bounds (the end-of-call fitting refines it).
   */
  const wrapNodes = (
    fn: string,
    nodes: any[],
    parent: any,
    index: number | undefined,
    makeFields: (items: SceneNode[]) => Record<string, unknown>,
    type = 'FRAME',
  ) => {
    if (!Array.isArray(nodes) || !nodes.length)
      throw new Error(`First argument to ${fn}() must be an array of at least one node`);
    const parentId: string = parent?.id ?? pageId();
    const p = scene(parentId);
    const items = nodes.map((n) => {
      if (!n?.id || !doc.getNodeById(n.id)) throw new Error('Expected a node');
      const s = scene(n.id);
      if (s.isInstanceSublayer) throw new Error('Cannot group a layer inside an instance');
      if (s.figType === 'CANVAS' || s.figType === 'DOCUMENT') throw new Error('Cannot group a page');
      return s;
    });
    // Keep the layers' stacking order when they share a parent.
    items.sort((a, b) =>
      a.parent === b.parent
        ? (a.data.parentIndex?.position ?? '') < (b.data.parentIndex?.position ?? '')
          ? -1
          : 1
        : 0,
    );
    // Each layer's transform in the new parent's space, and the bounds of them all.
    const toParent = invert(p.figType === 'CANVAS' ? IDENTITY_T : p.absoluteTransform);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const rel = items.map((s) => {
      const m = multiply(toParent, s.absoluteTransform);
      const b = transformedBounds(m, s.width, s.height);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
      return m;
    });
    const g = session.create(type, parentId, index, {
      visible: true,
      opacity: 1,
      size: { x: maxX - minX, y: maxY - minY },
      transform: { ...IDENTITY_T, m02: minX, m12: minY },
      ...makeFields(items),
    });
    const gid = guidToString(g.guid);
    items.forEach((s, i) => {
      session.move(s.id, gid);
      const m = rel[i]!;
      session.raw(s.id).transform = { ...m, m02: m.m02 - minX, m12: m.m12 - minY };
      session.markDirty(s.id);
    });
    return wrap(scene(gid));
  };

  const BOOLEAN_NAMES: Record<string, string> = {
    UNION: 'Union',
    SUBTRACT: 'Subtract',
    INTERSECT: 'Intersect',
    EXCLUDE: 'Exclude',
  };
  /** A boolean operation takes the fill and stroke of its bottom-most layer, as in Figma. */
  const booleanOp = (op: string, nodes: any[], parent: any, index: number | undefined) =>
    wrapNodes(
      op.toLowerCase(),
      nodes,
      parent,
      index,
      (items) => {
        const bottom = items[0]!.data;
        return {
          name: BOOLEAN_NAMES[op]!,
          strokeWeight: bottom.strokeWeight ?? 1,
          strokeAlign: bottom.strokeAlign ?? 'INSIDE',
          strokeJoin: bottom.strokeJoin ?? 'MITER',
          fillPaints: structuredClone(bottom.fillPaints ?? []),
          ...(bottom.strokePaints?.length ? { strokePaints: structuredClone(bottom.strokePaints) } : {}),
          // The file's BooleanOperation enum calls EXCLUDE "XOR".
          booleanOperation: op === 'EXCLUDE' ? 'XOR' : op,
        };
      },
      'BOOLEAN_OPERATION',
    );

  const { variables } = createVariablesApi(rt);

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
    createPolygon() {
      return create('REGULAR_POLYGON', { count: 3, fillPaints: [structuredClone(GREY)] });
    },
    createStar() {
      return create('STAR', { count: 5, starInnerScale: 0.382, fillPaints: [structuredClone(GREY)] });
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
    group(nodes: any[], parent: any, index?: number) {
      return wrapNodes('group', nodes, parent, index, () => ({
        name: defaultName('GROUP'),
        strokeWeight: 1,
        strokeAlign: 'INSIDE',
        strokeJoin: 'MITER',
        frameMaskDisabled: false,
        resizeToFit: true,
      }));
    },
    union(nodes: any[], parent: any, index?: number) {
      return booleanOp('UNION', nodes, parent, index);
    },
    subtract(nodes: any[], parent: any, index?: number) {
      return booleanOp('SUBTRACT', nodes, parent, index);
    },
    intersect(nodes: any[], parent: any, index?: number) {
      return booleanOp('INTERSECT', nodes, parent, index);
    },
    exclude(nodes: any[], parent: any, index?: number) {
      return booleanOp('EXCLUDE', nodes, parent, index);
    },
    flatten(nodes: any[], parent?: any, index?: number) {
      if (!Array.isArray(nodes) || !nodes.length)
        throw new Error('First argument to flatten() must be an array of at least one node');
      const items = nodes.map((n) => {
        if (!n?.id || !doc.getNodeById(n.id)) throw new Error('Expected a node');
        const s = scene(n.id);
        if (s.isInstanceSublayer) throw new Error('Cannot flatten a layer inside an instance');
        return s;
      });
      const first = items[0]!;
      const parentScene = parent?.id ? scene(parent.id) : first.parent!;
      const at =
        index ?? Math.max(...items.map((s) => parentScene.children.findIndex((c) => c.id === s.id))) + 1;
      const toParent = invert(parentScene.figType === 'CANVAS' ? IDENTITY_T : parentScene.absoluteTransform);
      const paths: Subpath[] = [];
      let rule: 'NONZERO' | 'ODD' = 'NONZERO';
      for (const s of items) {
        const m = multiply(toParent, s.absoluteTransform);
        for (const o of outlineOf(doc, s.data)) {
          paths.push(...transformSubpaths(o.paths, m));
          if (o.rule === 'ODD') rule = 'ODD';
        }
      }
      if (!paths.length) throw new Error('Nothing to flatten: the layers have no outline');
      const bottom = first.data;
      const v = session.create('VECTOR', parentScene.id, at, {
        name: 'Vector',
        visible: true,
        opacity: 1,
        ...vectorFields(paths, rule),
        strokeWeight: bottom.strokeWeight ?? 0,
        strokeAlign: bottom.strokeAlign ?? 'CENTER',
        strokeJoin: bottom.strokeJoin ?? 'MITER',
        fillPaints: structuredClone(bottom.fillPaints ?? []),
        strokePaints: structuredClone(bottom.strokePaints ?? []),
      });
      for (const s of items) session.remove(s.id);
      return wrap(scene(guidToString(v.guid)));
    },
    ungroup(node: any) {
      const s = node?.id ? scene(node.id) : undefined;
      if (!s || s.type !== 'GROUP') throw new Error('Expected a group node');
      const parent = s.parent!;
      const at = parent.children.findIndex((c) => c.id === s.id);
      const groupT = s.relativeTransform;
      const kids = [...s.children];
      kids.forEach((c, i) => {
        const t = multiply(groupT, c.relativeTransform);
        session.move(c.id, parent.id, at + i);
        session.raw(c.id).transform = t;
        session.markDirty(c.id);
      });
      session.remove(s.id);
      return kids.map((c) => wrap(scene(c.id)));
    },
    createVector() {
      return create('VECTOR', {
        size: { x: 0.01, y: 0.01 },
        fillPaints: [],
        strokePaints: [structuredClone(BLACK)],
        vectorData: {
          vectorNetworkBlob: session.addBlob(
            encodeVectorNetwork({ vertices: [], segments: [], regions: [] }),
          ),
          normalizedSize: { x: 0.01, y: 0.01 },
        },
      });
    },
    createNodeFromSvg(svg: string) {
      let parsed: ReturnType<typeof parseSvgDocument>;
      try {
        parsed = parseSvgDocument(String(svg));
      } catch (e) {
        if (e instanceof SvgUnsupported)
          throw new FigtionalUnsupported(`createNodeFromSvg with ${e.message}`);
        throw e;
      }
      const frame = create('FRAME', {
        name: 'Frame',
        size: { x: parsed.width, y: parsed.height },
        fillPaints: [],
        frameMaskDisabled: false,
      });
      for (const shape of parsed.shapes) {
        const solid = (c: { r: number; g: number; b: number; a: number }) => ({
          type: 'SOLID',
          color: { r: c.r, g: c.g, b: c.b, a: 1 },
          opacity: c.a,
          visible: true,
          blendMode: 'NORMAL',
        });
        session.create('VECTOR', frame.id, undefined, {
          name: shape.name,
          visible: true,
          opacity: shape.opacity,
          ...vectorFields(shape.paths, shape.fill ? shape.fillRule : null),
          strokeWeight: shape.stroke ? shape.strokeWidth : 0,
          strokeAlign: 'CENTER',
          strokeJoin: shape.strokeJoin,
          ...(shape.strokeCap !== 'NONE' ? { strokeCap: shape.strokeCap } : {}),
          fillPaints: shape.fill ? [solid(shape.fill)] : [],
          strokePaints: shape.stroke ? [solid(shape.stroke)] : [],
        });
      }
      return frame;
    },
    createImage(data: Uint8Array) {
      if (!ArrayBuffer.isView(data)) throw new Error('createImage expects a Uint8Array');
      const bytes = Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      const info = imageInfo(bytes);
      if (!info) throw new Error('Image type is unsupported');
      if (info.width > 4096 || info.height > 4096) throw new Error('Image is too large');
      if (!doc.archive) throw new FigtionalUnsupported('createImage without a .fig archive');
      return imageApi(doc.archive.addImage(bytes));
    },
    async createImageAsync(src: string) {
      const m = /^data:image\/[a-z+.-]+;base64,(.*)$/is.exec(String(src));
      if (!m)
        throw new FigtionalUnsupported(
          'createImageAsync with a URL',
          'Figtional makes no network requests. Pass the bytes to figma.createImage(), or use a data: URL.',
        );
      return figma.createImage(Uint8Array.from(Buffer.from(m[1]!, 'base64')));
    },
    base64Encode(data: Uint8Array) {
      if (!ArrayBuffer.isView(data)) throw new Error('base64Encode expects a Uint8Array');
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
    },
    base64Decode(data: string) {
      return Uint8Array.from(Buffer.from(String(data), 'base64'));
    },
    getImageByHash(hash: string) {
      return doc.archive?.image(String(hash)) ? imageApi(String(hash).toLowerCase()) : null;
    },
    async importComponentByKeyAsync(key: string) {
      const c = [...doc.nodes.values()].find((n) => n.type === 'SYMBOL' && componentKeyOf(n) === key);
      if (!c)
        throw new FigtionalUnsupported(
          `importComponentByKeyAsync('${key}')`,
          'Only library components embedded in this .fig file can be imported.',
        );
      return wrap(scene(guidToString(c.guid)));
    },
    async importComponentSetByKeyAsync(key: string) {
      const c = [...doc.nodes.values()].find((n) => n.isStateGroup && componentKeyOf(n) === key);
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
