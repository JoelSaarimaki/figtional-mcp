import {
  type DecodedCanvas,
  type FigArchive,
  type GUID,
  type Matrix,
  type NodeChange,
  guidToString,
  isNullGuid,
} from '@figtional/fig-format';
import { INSTANCE_FIELDS } from './instance-fields.js';
import { IDENTITY, type Rect, multiply, transformedBounds } from './matrix.js';

/** Node types as the Plugin API names them, keyed by .fig type. */
export const PLUGIN_TYPE: Record<string, string> = {
  DOCUMENT: 'DOCUMENT',
  CANVAS: 'PAGE',
  SYMBOL: 'COMPONENT',
  ROUNDED_RECTANGLE: 'RECTANGLE',
};

export const INTERNAL_PAGE_NAME = 'Internal Only Canvas';

const pathKey = (guids: GUID[]) => guids.map(guidToString).join('/');

/**
 * The id a component's node is known by in override paths (`guidPath`) and instance sublayer ids.
 * For components copied from a library this is `overrideKey` (the node's id in the library), not
 * the local guid (verified on Futurice.com UI).
 */
export function overrideId(n: NodeChange): GUID {
  return n.overrideKey && !isNullGuid(n.overrideKey) ? n.overrideKey : n.guid;
}

/**
 * A node as seen through the Plugin API: either a real node from the file, or a node inside an
 * instance (id "I<instance>;<source>", data = component node + overrides + derived values).
 */
export class SceneNode {
  private childCache: SceneNode[] | undefined;

  constructor(
    readonly doc: FigDocument,
    /** Plugin API id ("1:2" or "I1:2;3:4"). */
    readonly id: string,
    /** Effective node data. For real nodes this is the stored NodeChange itself. */
    readonly data: NodeChange,
    readonly parent: SceneNode | undefined,
    /** Set for nodes inside an instance. */
    readonly instanceContext?: InstanceContext,
  ) {}

  get guid(): GUID {
    return this.data.guid;
  }
  get name(): string {
    return this.data.name ?? '';
  }
  /** Raw .fig type (FRAME, SYMBOL, ROUNDED_RECTANGLE, …). */
  get figType(): string {
    return this.data.type ?? 'NONE';
  }
  /** Plugin API type (FRAME, COMPONENT, COMPONENT_SET, RECTANGLE, PAGE, …). */
  get type(): string {
    if (this.figType === 'FRAME' && this.data.isStateGroup) return 'COMPONENT_SET';
    if (this.figType === 'FRAME' && isGroupData(this.data)) return 'GROUP';
    return PLUGIN_TYPE[this.figType] ?? this.figType;
  }
  get visible(): boolean {
    return this.data.visible !== false;
  }
  get isInstanceSublayer(): boolean {
    return this.instanceContext !== undefined;
  }
  get width(): number {
    return this.data.size?.x ?? 0;
  }
  get height(): number {
    return this.data.size?.y ?? 0;
  }
  get relativeTransform(): Matrix {
    return this.data.transform ?? IDENTITY;
  }

  /** Transform relative to the page. */
  get absoluteTransform(): Matrix {
    let m = this.relativeTransform;
    for (let p = this.parent; p && p.figType !== 'CANVAS' && p.figType !== 'DOCUMENT'; p = p.parent) {
      m = multiply(p.relativeTransform, m);
    }
    return m;
  }

  get absoluteBoundingBox(): Rect {
    return transformedBounds(this.absoluteTransform, this.width, this.height);
  }

  get page(): SceneNode | undefined {
    if (this.figType === 'CANVAS') return this;
    let n = this.parent;
    while (n && n.figType !== 'CANVAS') n = n.parent;
    return n;
  }

  get children(): SceneNode[] {
    if (!this.childCache) this.childCache = this.doc.buildChildren(this);
    return this.childCache;
  }

  /** Depth-first traversal (this node included). Stops descending where `visit` returns false. */
  walk(visit: (n: SceneNode) => boolean | void): void {
    if (visit(this) === false) return;
    for (const c of this.children) c.walk(visit);
  }

  findAll(pred: (n: SceneNode) => boolean): SceneNode[] {
    const out: SceneNode[] = [];
    for (const c of this.children) c.walk((n) => void (pred(n) && out.push(n)));
    return out;
  }

  findOne(pred: (n: SceneNode) => boolean): SceneNode | undefined {
    let found: SceneNode | undefined;
    for (const c of this.children) {
      c.walk((n) => {
        if (found) return false;
        if (pred(n)) {
          found = n;
          return false;
        }
        return true;
      });
      if (found) break;
    }
    return found;
  }

  /** For INSTANCE nodes: the component it shows (after instance swaps), if present in the file. */
  get mainComponent(): SceneNode | undefined {
    if (this.figType !== 'INSTANCE') return undefined;
    const id = this.doc.effectiveSymbolId(this.data);
    return id ? this.doc.getNodeById(guidToString(id)) : undefined;
  }

  /** True for an INSTANCE whose component is not in the file (rendered as a placeholder). */
  get isMissingComponent(): boolean {
    return this.figType === 'INSTANCE' && !this.mainComponent;
  }
}

/** Overrides and property values in effect while expanding an instance. */
export interface InstanceContext {
  /** The outermost instance being expanded. */
  root: SceneNode;
  /** Plugin-API id prefix for nodes created under this context, e.g. "I1:2;3:4". */
  idPrefix: string;
  /** Override ids of the nested instances between the expanded instance and the current node. */
  path: GUID[];
  /** guid-path key → override objects, innermost first (outer ones applied later win). */
  overrides: Map<string, NodeChange[]>;
  /** guid-path key → derived (laid-out) values computed by Figma. */
  derived: Map<string, NodeChange>;
  /** Component property assignments in effect (defID string → value). */
  props: Map<string, any>;
}

const DERIVED_FIELDS_SKIP = new Set(['guidPath']);
const OVERRIDE_FIELDS_SKIP = new Set(['guidPath', 'componentPropAssignments', 'overrideLevel']);

export class FigDocument {
  readonly nodes = new Map<string, NodeChange>();
  private readonly childrenIndex = new Map<string, NodeChange[]>();
  private readonly byKey = new Map<string, NodeChange>();
  private sceneCache = new Map<string, SceneNode>();
  /** The DOCUMENT node. Replaced on reindex(), so don't hold on to SceneNodes across edits. */
  root!: SceneNode;

  constructor(
    readonly canvas: DecodedCanvas,
    /** The archive images are read from; replaced after the file is saved and reopened. */
    public archive?: FigArchive,
  ) {
    if (!this.canvas.message.nodeChanges.some((n) => n.type === 'DOCUMENT'))
      throw new Error('file has no DOCUMENT node');
    this.reindex();
  }

  static fromArchive(archive: FigArchive): FigDocument {
    return new FigDocument(archive.decodeCanvas(), archive);
  }

  /** Rebuilds lookup tables. Call after structural edits to the message. */
  reindex(): void {
    this.nodes.clear();
    this.childrenIndex.clear();
    this.byKey.clear();
    this.propDefParentCache = undefined;
    for (const n of this.canvas.message.nodeChanges) {
      if (n.phase === 'REMOVED') continue;
      this.nodes.set(guidToString(n.guid), n);
      if (n.key) this.byKey.set(n.key, n);
      if (n.parentIndex) {
        const pid = guidToString(n.parentIndex.guid);
        let list = this.childrenIndex.get(pid);
        if (!list) this.childrenIndex.set(pid, (list = []));
        list.push(n);
      }
    }
    for (const list of this.childrenIndex.values()) {
      list.sort((a, b) => {
        const pa = a.parentIndex!.position;
        const pb = b.parentIndex!.position;
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
    }
    const doc = this.canvas.message.nodeChanges.find((n) => n.type === 'DOCUMENT')!;
    this.root = new SceneNode(this, guidToString(doc.guid), doc, undefined);
    this.sceneCache = new Map([[this.root.id, this.root]]);
  }

  /** Drops cached scene nodes (expanded instances, child lists) after data edits. Cheap. */
  invalidateScenes(): void {
    this.root = new SceneNode(this, this.root.id, this.root.data, undefined);
    this.sceneCache = new Map([[this.root.id, this.root]]);
  }

  get message() {
    return this.canvas.message;
  }

  get blobs() {
    return this.canvas.message.blobs ?? [];
  }

  /** Stored child NodeChanges of a real node, in sibling order. */
  rawChildren(id: string): NodeChange[] {
    return this.childrenIndex.get(id) ?? [];
  }

  /** All pages including the internal one and dividers. */
  get allPages(): SceneNode[] {
    return this.root.children;
  }

  /** Pages a user sees in Figma's page list (no internal page). Dividers are included. */
  get pages(): SceneNode[] {
    return this.allPages.filter((p) => !isInternalPage(p.data));
  }

  get internalPage(): SceneNode | undefined {
    return this.allPages.find((p) => isInternalPage(p.data));
  }

  /** Looks up a node by Plugin API id ("1:2", "1-2" or "I1:2;3:4"). */
  getNodeById(id: string): SceneNode | undefined {
    const norm = normalizeNodeId(id);
    if (!norm) return undefined;
    const cached = this.sceneCache.get(norm);
    if (cached) return cached;
    if (norm.startsWith('I')) return this.resolveInstanceSublayerId(norm);
    const raw = this.nodes.get(norm);
    if (!raw) return undefined;
    // Materialise the ancestor chain so `parent` links are right.
    const chain: NodeChange[] = [];
    for (
      let n: NodeChange | undefined = raw;
      n;
      n = n.parentIndex ? this.nodes.get(guidToString(n.parentIndex.guid)) : undefined
    ) {
      chain.unshift(n);
      if (!n.parentIndex) break;
    }
    let cur: SceneNode | undefined = this.root;
    for (const n of chain.slice(1)) {
      cur = cur?.children.find((c) => c.id === guidToString(n.guid));
      if (!cur) return undefined;
    }
    return cur;
  }

  private resolveInstanceSublayerId(id: string): SceneNode | undefined {
    // "I1:2;3:4;5:6": instance 1:2, inside it 3:4 (maybe a nested instance), inside that 5:6.
    const parts = id.slice(1).split(';');
    let cur = this.getNodeById(parts[0]!);
    for (let i = 1; cur && i < parts.length; i++) {
      const want = parts[i];
      cur = findInSubtree(
        cur,
        (n) =>
          n.isInstanceSublayer &&
          guidToString(overrideId(n.data)) === want &&
          n.id === `I${parts.slice(0, i + 1).join(';')}`,
      );
    }
    return cur;
  }

  /** Builds the children of a scene node (real children, or expanded instance content). */
  buildChildren(node: SceneNode): SceneNode[] {
    if (node.figType === 'INSTANCE') return this.expandInstance(node);
    if (node.instanceContext) return this.expandInstanceDescendant(node);
    return this.rawChildren(node.id).map((c) => this.scene(c, node));
  }

  private scene(n: NodeChange, parent: SceneNode): SceneNode {
    const id = guidToString(n.guid);
    let s = this.sceneCache.get(id);
    if (!s) {
      s = new SceneNode(this, id, n, parent);
      this.sceneCache.set(id, s);
    }
    return s;
  }

  /** Component id an instance shows, after any instance swap override on itself. */
  effectiveSymbolId(data: NodeChange): GUID | undefined {
    const swapped = data.overriddenSymbolID;
    if (swapped && !isNullGuid(swapped)) return swapped;
    const id = data.symbolData?.symbolID;
    return id && !isNullGuid(id) ? id : undefined;
  }

  private expandInstance(inst: SceneNode): SceneNode[] {
    const symId = this.effectiveSymbolId(inst.data);
    const symbol = symId ? this.nodes.get(guidToString(symId)) : undefined;
    if (!symbol) return [];

    const outer = inst.instanceContext;
    // Overrides keyed relative to this instance's component.
    const overrides = new Map<string, NodeChange[]>();
    const derived = new Map<string, NodeChange>();
    const add = (key: string, o: NodeChange) => {
      const list = overrides.get(key);
      if (list) list.push(o);
      else overrides.set(key, [o]);
    };
    // Innermost first: the instance's own overrides…
    for (const o of inst.data.symbolData?.symbolOverrides ?? []) add(pathKey(o.guidPath?.guids ?? []), o);
    for (const d of inst.data.derivedSymbolData ?? []) derived.set(pathKey(d.guidPath?.guids ?? []), d);
    // …then overrides from enclosing instances that reach into this one (they win).
    let props = new Map<string, any>();
    if (outer) {
      const here = [...outer.path, overrideId(inst.data)];
      const prefix = pathKey(here) + '/';
      for (const [k, list] of outer.overrides) {
        if (k.startsWith(prefix)) for (const o of list) add(k.slice(prefix.length), o);
      }
      for (const [k, d] of outer.derived) {
        if (k.startsWith(prefix)) derived.set(k.slice(prefix.length), d);
      }
      props = new Map(outer.props); // outer assignments stay visible for nested refs
    }
    for (const a of inst.data.componentPropAssignments ?? []) {
      // Figma's layout for an assigned text lives on the assignment, next to the value.
      props.set(
        guidToString(a.defID),
        a.legacyDerivedTextData ? { ...a.value, legacyDerivedTextData: a.legacyDerivedTextData } : a.value,
      );
    }

    const ctx: InstanceContext = {
      root: outer?.root ?? inst,
      idPrefix: inst.id.startsWith('I') ? inst.id : `I${inst.id}`,
      path: [],
      overrides,
      derived,
      props,
    };
    return this.rawChildren(guidToString(symbol.guid)).map((c) => this.instanceNode(c, inst, ctx));
  }

  private expandInstanceDescendant(node: SceneNode): SceneNode[] {
    const ctx = node.instanceContext!;
    // guidPath only lists nested instances (plus the target), not intermediate frames (verified),
    // so the path stays the same below plain frames.
    const childCtx: InstanceContext = ctx;
    return this.rawChildren(guidToString(node.guid)).map((c) => this.instanceNode(c, node, childCtx));
  }

  private instanceNode(src: NodeChange, parent: SceneNode, ctx: InstanceContext): SceneNode {
    const key = pathKey([...ctx.path, overrideId(src)]);
    const data: NodeChange = { ...src };
    for (const o of ctx.overrides.get(key) ?? []) {
      for (const [f, v] of Object.entries(o)) if (!OVERRIDE_FIELDS_SKIP.has(f)) data[f] = v;
      // Property assignments targeted at a nested instance become that instance's own.
      if (o.componentPropAssignments) {
        data.componentPropAssignments = [
          ...(data.componentPropAssignments ?? []),
          ...o.componentPropAssignments,
        ];
      }
    }
    const d = ctx.derived.get(key);
    if (d) for (const [f, v] of Object.entries(d)) if (!DERIVED_FIELDS_SKIP.has(f)) data[f] = v;
    // Text changed by an override without Figma's layout for it: the component's glyphs are stale.
    if (data.textData !== src.textData && !d?.derivedTextData && textChanged(src, data))
      delete data.derivedTextData;
    this.applyComponentProps(data, ctx);
    // A swapped nested instance looks like its new component at the root, except for overrides.
    const swapped = data.type === 'INSTANCE' ? this.effectiveSymbolId(data) : undefined;
    if (swapped && guidToString(swapped) !== guidToString(src.symbolData?.symbolID ?? swapped)) {
      const symbol = this.nodes.get(guidToString(swapped));
      if (symbol) {
        const overridden = new Set<string>();
        for (const o of ctx.overrides.get(key) ?? []) for (const f of Object.keys(o)) overridden.add(f);
        for (const f of Object.keys(d ?? {})) overridden.add(f);
        for (const f of INSTANCE_FIELDS) {
          if (overridden.has(f)) continue;
          if (symbol[f] !== undefined) data[f] = symbol[f];
          else delete data[f];
        }
      }
    }
    const id = `${ctx.idPrefix};${guidToString(overrideId(src))}`;
    return new SceneNode(this, id, data, parent, { ...ctx, path: ctx.path });
  }

  private applyComponentProps(data: NodeChange, ctx: InstanceContext): void {
    // Newer files bind properties through parameterConsumptionMap (verified: VISIBLE in Futurice.com UI).
    for (const e of data.parameterConsumptionMap?.entries ?? []) {
      const defId = e.variableData?.value?.propRefValue?.defId;
      if (!defId) continue;
      const value = this.lookupProp(ctx.props, defId);
      if (value === undefined) continue;
      if (e.variableField === 'VISIBLE' && value.boolValue !== undefined) data.visible = value.boolValue;
      else if (e.variableField === 'TEXT_DATA' && value.textValue) {
        const before = data.textData;
        data.textData = value.textValue;
        if (value.legacyDerivedTextData) data.derivedTextData = value.legacyDerivedTextData;
        else if (textChanged({ textData: before }, data)) delete data.derivedTextData;
      }
    }
    for (const ref of data.componentPropRefs ?? []) {
      if (ref.isDeleted) continue;
      const value = this.lookupProp(ctx.props, ref.defID);
      if (value === undefined) continue;
      switch (ref.componentPropNodeField) {
        case 'TEXT_DATA':
          if (value.textValue) {
            const before = data.textData;
            data.textData = value.textValue;
            // The assignment may carry Figma's layout for the new text; otherwise it's stale.
            if (value.legacyDerivedTextData) data.derivedTextData = value.legacyDerivedTextData;
            else if (textChanged({ textData: before }, data)) delete data.derivedTextData;
          }
          break;
        case 'VISIBLE':
          if (value.boolValue !== undefined) data.visible = value.boolValue;
          break;
        case 'OVERRIDDEN_SYMBOL_ID':
          if (value.guidValue && !isNullGuid(value.guidValue)) data.overriddenSymbolID = value.guidValue;
          break;
      }
    }
  }

  /** Finds an assignment for a property definition, following `parentPropDefId` links. */
  private lookupProp(props: Map<string, any>, defID: GUID | undefined): any {
    if (!defID) return undefined;
    const direct = props.get(guidToString(defID));
    if (direct !== undefined) return direct;
    const parentId = this.propDefParents().get(guidToString(defID));
    return parentId ? props.get(parentId) : undefined;
  }

  private propDefParentCache: Map<string, string> | undefined;
  private propDefParents(): Map<string, string> {
    if (!this.propDefParentCache) {
      const m = new Map<string, string>();
      for (const n of this.nodes.values()) {
        for (const def of n.componentPropDefs ?? []) {
          if (def.id && def.parentPropDefId) m.set(guidToString(def.id), guidToString(def.parentPropDefId));
        }
      }
      this.propDefParentCache = m;
    }
    return this.propDefParentCache;
  }

  /** A style, variable or component by its library key (`assetRef.key`). */
  getByKey(key: string): NodeChange | undefined {
    return this.byKey.get(key);
  }

  /** Resolves a style reference (`styleIdForFill` etc.): `{ guid }` or `{ assetRef: { key } }`. */
  resolveStyleRef(ref: any): NodeChange | undefined {
    if (!ref) return undefined;
    if (ref.assetRef?.key) return this.byKey.get(ref.assetRef.key);
    if (ref.guid && !isNullGuid(ref.guid)) return this.nodes.get(guidToString(ref.guid));
    return undefined;
  }

  /** Resolves a variable alias (`{ guid }` or `{ assetRef: { key } }`). */
  resolveVariableRef(ref: any): NodeChange | undefined {
    return this.resolveStyleRef(ref);
  }

  /** Style definition nodes (local and embedded library styles). */
  get styles(): NodeChange[] {
    return [...this.nodes.values()].filter((n) => n.styleType && n.styleType !== 'NONE');
  }

  get variableCollections(): NodeChange[] {
    return [...this.nodes.values()].filter((n) => n.type === 'VARIABLE_SET');
  }

  get variables(): NodeChange[] {
    return [...this.nodes.values()].filter((n) => n.type === 'VARIABLE');
  }

  /** Components (SYMBOL) in the file, including embedded library copies. */
  get components(): NodeChange[] {
    return [...this.nodes.values()].filter((n) => n.type === 'SYMBOL');
  }
}

/**
 * Groups are stored as FRAMEs with `resizeToFit: true` (verified). Some resize-to-fit frames have
 * fills, which groups can't, so we also require no fills/strokes and no auto layout (assumed).
 */
export function isGroupData(n: NodeChange): boolean {
  return (
    n.type === 'FRAME' &&
    n.resizeToFit === true &&
    !n.fillPaints?.length &&
    !n.strokePaints?.length &&
    (!n.stackMode || n.stackMode === 'NONE')
  );
}

function textChanged(a: Record<string, any>, b: Record<string, any>): boolean {
  return (a.textData?.characters ?? '') !== (b.textData?.characters ?? '');
}

export function isInternalPage(n: NodeChange): boolean {
  return n.type === 'CANVAS' && (n.internalOnly === true || n.name === INTERNAL_PAGE_NAME);
}

/** Accepts "1:2", "1-2" (URL form) and instance ids "I1:2;3:4". Returns the canonical form. */
export function normalizeNodeId(id: string): string | undefined {
  const s = id.trim();
  if (/^\d+[:-]\d+$/.test(s)) return s.replace('-', ':');
  if (/^I\d+[:-]\d+(;\d+[:-]\d+)+$/.test(s)) return s.replace(/(\d+)-(\d+)/g, '$1:$2');
  return undefined;
}

function findInSubtree(root: SceneNode, pred: (n: SceneNode) => boolean): SceneNode | undefined {
  return root.findOne(pred);
}
