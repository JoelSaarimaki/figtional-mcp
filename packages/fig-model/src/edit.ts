/**
 * Structural editing of a FigDocument: creating, moving, cloning and removing nodes, instance
 * overrides, and the follow-up work Figma expects (re-layout, dropping stale derived data).
 *
 * Rules (docs/fig-format.md, docs/compat-log.md):
 * - New nodes get guids in a fresh sessionID, so they never collide with existing ones.
 * - Sibling order uses fractional `parentIndex.position` keys; siblings are renumbered when no key fits.
 * - Existing node objects are edited in place (keeps key order, so untouched fields re-encode identically).
 * - Derived data that edits make stale is removed; Figma recomputes it on import (verified for text).
 */
import { type GUID, type NodeChange, guidToString } from '@figtional/fig-format';
import {
  type FigDocument,
  type SceneNode,
  INTERNAL_PAGE_NAME,
  isInternalPage,
  overrideId,
} from './document.js';
import { keyBetween, spreadKeys } from './fractional-index.js';
import { measureText } from './fonts.js';
import { computeLayout, stackProps } from './layout.js';

export class EditSession {
  readonly sessionID: number;
  private nextLocal = 1;
  /** Ids of nodes whose content or size changed (for re-layout). */
  readonly dirty = new Set<string>();
  /** Text nodes whose text or typography changed (re-measured on commit). */
  readonly dirtyText = new Set<string>();
  changed = false;

  constructor(readonly doc: FigDocument) {
    let max = 0;
    for (const n of doc.message.nodeChanges) max = Math.max(max, n.guid.sessionID);
    this.sessionID = max + 1;
  }

  newGuid(): GUID {
    return { sessionID: this.sessionID, localID: this.nextLocal++ };
  }

  raw(id: string): NodeChange {
    const n = this.doc.nodes.get(id);
    if (!n) throw new Error(`The node with id ${id} does not exist`);
    return n;
  }

  /** Position key for inserting at `index` among the children of `parentId` (excluding `moving`). */
  positionAt(parentId: string, index: number | undefined, moving?: string): string {
    const siblings = this.doc.rawChildren(parentId).filter((c) => guidToString(c.guid) !== moving);
    const i = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    const before = siblings[i - 1]?.parentIndex?.position;
    const after = siblings[i]?.parentIndex?.position;
    const key = keyBetween(before, after);
    if (key !== undefined) return key;
    // No room: renumber all siblings, leaving a gap at i.
    const keys = spreadKeys(siblings.length + 1);
    siblings.forEach((s, j) => {
      s.parentIndex!.position = keys[j < i ? j : j + 1]!;
    });
    return keys[i]!;
  }

  /** A key after all keys in `existing` (for sortPosition-style lists). */
  positionAtList(existing: (string | undefined)[]): string {
    const last = existing
      .filter((k): k is string => !!k)
      .sort()
      .pop();
    return keyBetween(last, undefined) ?? `${last ?? ''}P`;
  }

  /** Adds a new node. `fields` should not contain guid/parentIndex. */
  create(type: string, parentId: string, index: number | undefined, fields: Partial<NodeChange>): NodeChange {
    this.raw(parentId);
    const guid = this.newGuid();
    const node: NodeChange = {
      guid,
      phase: 'CREATED',
      parentIndex: { guid: this.raw(parentId).guid, position: this.positionAt(parentId, index) },
      type,
      ...fields,
    } as NodeChange;
    this.doc.message.nodeChanges.push(node);
    this.touchStructure(parentId);
    this.markDirty(guidToString(guid));
    return node;
  }

  move(id: string, parentId: string, index?: number): void {
    const n = this.raw(id);
    const newParent = this.raw(parentId);
    for (
      let p: NodeChange | undefined = newParent;
      p;
      p = p.parentIndex ? this.doc.nodes.get(guidToString(p.parentIndex.guid)) : undefined
    ) {
      if (p === n) throw new Error('Cannot move a node inside itself');
      if (!p.parentIndex) break;
    }
    const oldParent = n.parentIndex ? guidToString(n.parentIndex.guid) : undefined;
    n.parentIndex = { guid: newParent.guid, position: this.positionAt(parentId, index, id) };
    if (oldParent) this.touchStructure(oldParent);
    this.touchStructure(parentId);
  }

  /** Deep copy of a node and its subtree, inserted right after it (or into `parentId`). */
  clone(id: string, parentId?: string, index?: number): NodeChange {
    const src = this.raw(id);
    const parent = parentId ?? guidToString(src.parentIndex!.guid);
    const siblings = this.doc.rawChildren(parent);
    const at = index ?? (parentId ? undefined : siblings.indexOf(src) + 1);
    const copy = (n: NodeChange, newParent: GUID, position: string): NodeChange => {
      const c = structuredClone(n);
      c.guid = this.newGuid();
      c.parentIndex = { guid: newParent, position };
      delete c.overrideKey;
      this.doc.message.nodeChanges.push(c);
      for (const child of this.doc.rawChildren(guidToString(n.guid)))
        copy(child, c.guid, child.parentIndex!.position);
      return c;
    };
    const root = copy(src, this.raw(parent).guid, this.positionAt(parent, at));
    this.touchStructure(parent);
    return root;
  }

  /** Removes a node and its subtree from the file. */
  remove(id: string): void {
    const n = this.raw(id);
    if (n.type === 'DOCUMENT') throw new Error('Cannot remove the document');
    const doomed = new Set<NodeChange>();
    const collect = (x: NodeChange) => {
      doomed.add(x);
      for (const c of this.doc.rawChildren(guidToString(x.guid))) collect(c);
    };
    collect(n);
    const parent = n.parentIndex ? guidToString(n.parentIndex.guid) : undefined;
    const list = this.doc.message.nodeChanges;
    let w = 0;
    for (const x of list) if (!doomed.has(x)) list[w++] = x;
    list.length = w;
    if (parent) this.touchStructure(parent);
  }

  /** Records that a node's content/size changed. */
  markDirty(id: string): void {
    this.dirty.add(id);
    this.changed = true;
    // Expanded instance content and cached children may depend on what changed.
    this.doc.invalidateScenes();
  }

  markText(id: string): void {
    this.dirtyText.add(id);
    this.markDirty(id);
  }

  private touchStructure(parentId: string): void {
    this.doc.reindex();
    this.markDirty(parentId);
  }

  /** Sets a field on an instance sublayer via the outermost instance's symbolOverrides. */
  setOverride(node: SceneNode, fields: Record<string, unknown>): void {
    const ctx = node.instanceContext;
    if (!ctx) throw new Error('not an instance sublayer');
    const root = ctx.root;
    const rootRaw = this.raw(root.id);
    const path = [...ctx.path, overrideId(node.data)];
    const key = path.map(guidToString).join('/');
    rootRaw.symbolData ??= { symbolID: rootRaw.symbolData?.symbolID, symbolOverrides: [] };
    const list: any[] = (rootRaw.symbolData.symbolOverrides ??= []);
    let o = list.find((x) => (x.guidPath?.guids ?? []).map(guidToString).join('/') === key);
    if (!o) {
      o = { guidPath: { guids: path.map((g) => ({ ...g })) } };
      list.push(o);
    }
    Object.assign(o, fields);
    // Figma's derived layout for this sublayer is now stale.
    if (rootRaw.derivedSymbolData) {
      rootRaw.derivedSymbolData = rootRaw.derivedSymbolData.filter(
        (d: any) => (d.guidPath?.guids ?? []).map(guidToString).join('/') !== key,
      );
    }
    this.doc.reindex();
    this.markDirty(root.id);
  }

  /**
   * Finishes a batch of edits: measures edited text, re-runs auto layout around everything that
   * changed, and drops derived data that is no longer valid.
   */
  commit(): void {
    if (!this.changed) return;
    this.doc.reindex();
    // 1. Text sizes from installed fonts.
    for (const id of this.dirtyText) {
      const n = this.doc.nodes.get(id);
      if (n?.type === 'TEXT') this.measure(n);
    }
    // 2. Auto layout for each top-level tree with changes (twice: text height can depend on width).
    for (let pass = 0; pass < 2; pass++) {
      const tops = new Map<string, SceneNode>();
      const dirtyScene = new Set<SceneNode>();
      for (const id of this.dirty) {
        const s = this.doc.getNodeById(id);
        if (!s) continue;
        dirtyScene.add(s);
        let top = s;
        while (top.parent && top.parent.figType !== 'CANVAS' && top.parent.figType !== 'DOCUMENT')
          top = top.parent;
        if (top.figType !== 'CANVAS' && top.figType !== 'DOCUMENT') tops.set(top.id, top);
      }
      let widthChanged = false;
      for (const top of tops.values()) {
        const { boxes } = computeLayout(top, {
          dirty: dirtyScene,
          measure: (n) => this.measureSublayer(n, dirtyScene),
        });
        for (const [s, b] of boxes) {
          if (s.isInstanceSublayer) {
            this.writeDerived(s, b, dirtyScene);
            continue;
          }
          const raw = this.doc.nodes.get(s.id);
          if (!raw) continue;
          const t = raw.transform;
          const inFlow = s.parent && stackProps(s.parent.data) && raw.stackPositioning !== 'ABSOLUTE';
          if (inFlow && t && (Math.abs(t.m02 - b.x) > 1e-3 || Math.abs(t.m12 - b.y) > 1e-3)) {
            t.m02 = b.x;
            t.m12 = b.y;
          }
          const size = raw.size;
          if (size && (Math.abs(size.x - b.w) > 1e-3 || Math.abs(size.y - b.h) > 1e-3)) {
            if (raw.type === 'TEXT' && Math.abs(size.x - b.w) > 1e-3) widthChanged = true;
            size.x = b.w;
            size.y = b.h;
            this.invalidateGeometry(raw);
            if (raw.type === 'TEXT') this.dirtyText.add(s.id);
          }
        }
      }
      if (!widthChanged) break;
      for (const id of this.dirtyText) {
        const n = this.doc.nodes.get(id);
        if (n?.type === 'TEXT' && n.textAutoResize === 'HEIGHT') this.measure(n);
      }
    }
    // 3. Component sets fit their variants (when they have no auto layout of their own).
    const sets = new Set<NodeChange>();
    for (const id of this.dirty) {
      for (
        let n = this.doc.nodes.get(id);
        n;
        n = n.parentIndex ? this.doc.nodes.get(guidToString(n.parentIndex.guid)) : undefined
      ) {
        if (n.type === 'FRAME' && n.isStateGroup && !stackProps(n)) sets.add(n);
        if (!n.parentIndex) break;
      }
    }
    for (const set of sets) {
      const kids = this.doc.rawChildren(guidToString(set.guid)).filter((c) => c.visible !== false);
      if (!kids.length || !set.size) continue;
      const w = Math.max(...kids.map((c) => (c.transform?.m02 ?? 0) + (c.size?.x ?? 0)));
      const h = Math.max(...kids.map((c) => (c.transform?.m12 ?? 0) + (c.size?.y ?? 0)));
      if (Math.abs(w - set.size.x) > 1e-3 || Math.abs(h - set.size.y) > 1e-3) {
        set.size = { x: w, y: h };
        this.invalidateGeometry(set);
      }
    }
    this.doc.reindex();
    this.dirty.clear();
    this.dirtyText.clear();
  }

  /** True if `s` sits inside an instance that was edited in this session. */
  private inDirtyInstance(s: SceneNode, dirty: Set<SceneNode>): boolean {
    const root = s.instanceContext?.root;
    if (!root) return false;
    for (const d of dirty) if (d.id === root.id) return true;
    return false;
  }

  /**
   * Size of a text layer inside an edited instance whose text no longer matches Figma's stored
   * layout (no derivedTextData): measured with installed fonts.
   */
  private measureSublayer(n: SceneNode, dirty: Set<SceneNode>): { w: number; h: number } | undefined {
    if (n.figType !== 'TEXT' || !n.isInstanceSublayer || n.data.derivedTextData) return undefined;
    if (!this.inDirtyInstance(n, dirty)) return undefined;
    const copy = { ...n.data, size: { ...(n.data.size ?? { x: 0, y: 0 }) } };
    this.measure(copy);
    return { w: copy.size.x, h: copy.size.y };
  }

  /**
   * Stores the laid-out size/position of a layer inside an edited instance in the instance's
   * derivedSymbolData, which is where Figma keeps per-instance layout results.
   */
  private writeDerived(
    s: SceneNode,
    b: { x: number; y: number; w: number; h: number },
    dirty: Set<SceneNode>,
  ): void {
    if (!this.inDirtyInstance(s, dirty)) return;
    const ctx = s.instanceContext!;
    const rootRaw = this.doc.nodes.get(ctx.root.id);
    if (!rootRaw || ctx.root.isInstanceSublayer) return;
    const t = s.relativeTransform;
    const sizeChanged = Math.abs(s.width - b.w) > 1e-3 || Math.abs(s.height - b.h) > 1e-3;
    const posChanged = Math.abs(t.m02 - b.x) > 1e-3 || Math.abs(t.m12 - b.y) > 1e-3;
    if (!sizeChanged && !posChanged) return;
    const path = [...ctx.path, overrideId(s.data)];
    const key = path.map(guidToString).join('/');
    const list: any[] = (rootRaw.derivedSymbolData ??= []);
    let entry = list.find((x) => (x.guidPath?.guids ?? []).map(guidToString).join('/') === key);
    if (!entry) {
      entry = { guidPath: { guids: path.map((g) => ({ ...g })) } };
      list.push(entry);
    }
    entry.size = { x: b.w, y: b.h };
    entry.transform = { ...t, m02: b.x, m12: b.y };
    if (sizeChanged && s.figType !== 'TEXT') {
      // Stored outlines are for the old size; an empty list makes renderers use the shape itself.
      entry.fillGeometry = [];
      entry.strokeGeometry = [];
    }
  }

  /** Measures a text node with installed fonts and updates its size per textAutoResize. */
  measure(n: NodeChange): void {
    const chars: string = n.textData?.characters ?? '';
    const style = {
      family: n.fontName?.family ?? 'Inter',
      style: n.fontName?.style ?? 'Regular',
      size: n.fontSize ?? 12,
      lineHeight: n.lineHeight,
      letterSpacing: n.letterSpacing,
    };
    const mode = n.textAutoResize ?? 'NONE';
    n.size ??= { x: 0, y: 0 };
    if (mode === 'WIDTH_AND_HEIGHT') {
      const m = measureText(chars, style);
      n.size.x = Math.ceil(m.width);
      n.size.y = m.height;
    } else if (mode === 'HEIGHT') {
      const m = measureText(chars, style, n.size.x);
      n.size.y = m.height;
    }
    delete n.derivedTextData;
  }

  /** Stored outlines no longer match the node's size. */
  invalidateGeometry(n: NodeChange): void {
    delete n.fillGeometry;
    delete n.strokeGeometry;
    if (n.type === 'TEXT') delete n.derivedTextData;
    if (n.type === 'INSTANCE') delete n.derivedSymbolData;
  }

  /** The internal page, created if the file has none (holds variables). */
  internalPage(): NodeChange {
    const existing = this.doc.allPages.find((p) => isInternalPage(p.data));
    if (existing) return existing.data;
    return this.create('CANVAS', guidToString(this.doc.root.guid), undefined, {
      name: INTERNAL_PAGE_NAME,
      visible: false,
      opacity: 1,
      internalOnly: true,
    });
  }
}
