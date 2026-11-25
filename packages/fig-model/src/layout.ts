/**
 * Auto layout. Recomputes sizes and positions of auto-layout frames and their children the way
 * Figma does, so edited content gets a correct layout. Two passes, like Figma: `measure` (bottom-up
 * hug sizes) and `arrange` (top-down: fill sizes and positions).
 *
 * Semantics were derived from the .fig fields (docs/fig-format.md §6) and are checked by
 * re-laying out every auto-layout frame in the reference files and comparing with the layout
 * Figma stored (layout.test.ts).
 */
import type { NodeChange } from '@figtional/fig-format';
import type { SceneNode } from './document.js';
import { transformedBounds } from './matrix.js';

export interface Size {
  w: number;
  h: number;
}

export interface Box extends Size {
  x: number;
  y: number;
}

type Justify = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'SPACE_EVENLY' | 'SPACE_AROUND';
type Align = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';

export interface StackProps {
  horizontal: boolean;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  spacing: number;
  counterSpacing: number;
  wrap: boolean;
  /** Primary axis hugs its content (Plugin API primaryAxisSizingMode = AUTO). */
  primaryHug: boolean;
  /** Counter axis hugs its content (Plugin API counterAxisSizingMode = AUTO). */
  counterHug: boolean;
  justify: Justify;
  align: Align;
  /** SPACE_BETWEEN in Figma's UI ("auto" spacing). */
  autoSpacing: boolean;
}

/** Auto-layout properties of a frame, or undefined when it isn't an auto-layout frame. */
export function stackProps(d: NodeChange): StackProps | undefined {
  if (d.stackMode !== 'HORIZONTAL' && d.stackMode !== 'VERTICAL') return undefined;
  const horizontal = d.stackMode === 'HORIZONTAL';
  // bordersTakeSpace (Plugin API strokesIncludedInLayout): the frame's own strokes count as padding.
  const b = borderWidths(d);
  const padLeft = (d.stackHorizontalPadding ?? 0) + b.left;
  const padTop = (d.stackVerticalPadding ?? 0) + b.top;
  const justify = (d.stackPrimaryAlignItems ?? 'MIN') as Justify;
  // Missing fields hold the enum's first value, except primary sizing, which Figma stores
  // explicitly as FIXED and omits when it hugs (verified by layout.test.ts).
  const primaryHug = d.stackPrimarySizing !== 'FIXED';
  const counterHug =
    d.stackCounterSizing === 'RESIZE_TO_FIT' || d.stackCounterSizing === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
  return {
    horizontal,
    padLeft,
    padRight: (d.stackPaddingRight ?? d.stackHorizontalPadding ?? 0) + b.right,
    padTop,
    padBottom: (d.stackPaddingBottom ?? d.stackVerticalPadding ?? 0) + b.bottom,
    spacing: d.stackSpacing ?? 0,
    counterSpacing: Number.isFinite(d.stackCounterSpacing) ? d.stackCounterSpacing : (d.stackSpacing ?? 0),
    wrap: d.stackWrap === 'WRAP',
    primaryHug,
    counterHug,
    justify,
    align: (d.stackCounterAlignItems ?? 'MIN') as Align,
    autoSpacing: justify === 'SPACE_EVENLY' || justify === 'SPACE_BETWEEN',
  };
}

function borderWidths(d: NodeChange) {
  const none = { left: 0, right: 0, top: 0, bottom: 0 };
  if (d.bordersTakeSpace !== true) return none;
  if (!(d.strokePaints ?? []).some((p: any) => p.visible !== false)) return none;
  if (d.borderStrokeWeightsIndependent) {
    return {
      left: d.borderLeftWeight ?? 0,
      right: d.borderRightWeight ?? 0,
      top: d.borderTopWeight ?? 0,
      bottom: d.borderBottomWeight ?? 0,
    };
  }
  const w = d.strokeWeight ?? 0;
  return { left: w, right: w, top: w, bottom: w };
}

const isAbsolute = (d: NodeChange) => d.stackPositioning === 'ABSOLUTE';

/** True if `d` is an auto-layout frame that hugs its content along the horizontal (or vertical) axis. */
function hugsAxis(d: NodeChange, horizontalAxis: boolean): boolean {
  if (d.type === 'TEXT') {
    // Auto-height text hugs vertically; auto-width text hugs both ways.
    return d.textAutoResize === 'WIDTH_AND_HEIGHT' || (!horizontalAxis && d.textAutoResize === 'HEIGHT');
  }
  const p = stackProps(d);
  if (!p) return false;
  return p.horizontal === horizontalAxis ? p.primaryHug : p.counterHug;
}

// "Hug contents" wins over a fill flag left on the same axis (verified: Futurice "Contact card").
const grows = (d: NodeChange, parentHorizontal: boolean) =>
  (d.stackChildPrimaryGrow ?? 0) > 0 && !hugsAxis(d, parentHorizontal);
const stretches = (d: NodeChange, parentHorizontal: boolean) =>
  d.stackChildAlignSelf === 'STRETCH' && !hugsAxis(d, !parentHorizontal);

/** Children that take part in the flow. */
function flowChildren(n: SceneNode): SceneNode[] {
  return n.children.filter((c) => c.visible && !isAbsolute(c.data));
}

function clamp(d: NodeChange, s: Size): Size {
  const min = d.minSize?.value;
  const max = d.maxSize?.value;
  let { w, h } = s;
  if (min?.x != null) w = Math.max(w, min.x);
  if (min?.y != null) h = Math.max(h, min.y);
  if (max?.x != null) w = Math.min(w, max.x);
  if (max?.y != null) h = Math.min(h, max.y);
  return { w, h };
}

export interface LayoutOptions {
  /**
   * Nodes whose content changed (edited text, added/removed/resized children…). When given, only
   * these and their ancestors are re-measured; everything else keeps the size Figma stored, which
   * is the most faithful choice for unedited content. When omitted, auto-layout frames are
   * re-measured from their content, except instances, which keep their stored size unless dirty.
   */
  dirty?: Set<SceneNode>;
  /** Intrinsic size for leaves whose stored size is stale (e.g. edited text inside an instance). */
  measure?: (n: SceneNode) => Size | undefined;
}

export interface LayoutResult {
  /** Computed boxes (position relative to the parent) for the root and every laid-out descendant. */
  boxes: Map<SceneNode, Box>;
}

/**
 * Lays out `root` and its subtree. Sizes of leaves (text, shapes, non-auto-layout frames) are taken
 * from the stored data, so this reproduces Figma's result for unedited content; edited text must
 * be measured and its size updated before calling this.
 */
export function computeLayout(root: SceneNode, opts: LayoutOptions = {}): LayoutResult {
  const measured = new Map<SceneNode, Size>();
  const boxes = new Map<SceneNode, Box>();
  // Nodes that must be re-measured: dirty nodes and their ancestors.
  let affected: Set<SceneNode> | undefined;
  if (opts.dirty) {
    affected = new Set();
    for (const d of opts.dirty) for (let n: SceneNode | undefined = d; n; n = n.parent) affected.add(n);
  }
  const remeasure = (n: SceneNode) => (affected ? affected.has(n) : n.figType !== 'INSTANCE' || n === root);

  // Rotated children take up their rotated bounding box (e.g. a vertical LINE: width 0).
  const stored = (n: SceneNode): Size => {
    const m = opts.measure?.(n);
    if (m) return m;
    const t = n.relativeTransform;
    if (Math.abs(t.m01) < 1e-6 && Math.abs(t.m10) < 1e-6) return { w: n.width, h: n.height };
    const b = transformedBounds({ ...t, m02: 0, m12: 0 }, n.width, n.height);
    return { w: b.width, h: b.height };
  };

  // Pass 1: intrinsic (hug) sizes, bottom-up.
  const measure = (n: SceneNode): Size => {
    const cached = measured.get(n);
    if (cached) return cached;
    const p = stackProps(n.data);
    let size = stored(n);
    if (p && remeasure(n)) {
      const kids = flowChildren(n);
      // An empty auto-layout frame keeps its stored ("implicit") size (verified: TTRPG "Text container").
      if (!kids.length) {
        measured.set(n, size);
        return size;
      }
      const sizes = kids.map(measure);
      const prim = (s: Size) => (p.horizontal ? s.w : s.h);
      const ctr = (s: Size) => (p.horizontal ? s.h : s.w);
      const padP = p.horizontal ? p.padLeft + p.padRight : p.padTop + p.padBottom;
      const padC = p.horizontal ? p.padTop + p.padBottom : p.padLeft + p.padRight;
      let hugP: number;
      let hugC: number;
      if (p.wrap && !p.primaryHug) {
        const lines = wrapLines(sizes.map(prim), (p.horizontal ? size.w : size.h) - padP, p.spacing);
        hugP = p.horizontal ? size.w : size.h;
        hugC =
          lines.reduce((sum, line) => sum + Math.max(0, ...line.map((i) => ctr(sizes[i]!))), 0) +
          p.counterSpacing * Math.max(0, lines.length - 1) +
          padC;
      } else {
        hugP = sizes.reduce((sum, s) => sum + prim(s), 0) + p.spacing * Math.max(0, kids.length - 1) + padP;
        hugC = Math.max(0, ...sizes.map(ctr)) + padC;
      }
      const w = p.horizontal ? (p.primaryHug ? hugP : size.w) : p.counterHug ? hugC : size.w;
      const h = p.horizontal ? (p.counterHug ? hugC : size.h) : p.primaryHug ? hugP : size.h;
      size = clamp(n.data, { w, h });
    }
    measured.set(n, size);
    return size;
  };

  // Pass 2: final sizes and positions, top-down.
  const arrange = (n: SceneNode, size: Size) => {
    const p = stackProps(n.data);
    if (!p) {
      for (const c of n.children) {
        const s = measure(c);
        boxes.set(c, { x: c.relativeTransform.m02, y: c.relativeTransform.m12, ...s });
        arrange(c, s);
      }
      return;
    }
    const H = p.horizontal;
    const innerP = (H ? size.w : size.h) - (H ? p.padLeft + p.padRight : p.padTop + p.padBottom);
    const innerC = (H ? size.h : size.w) - (H ? p.padTop + p.padBottom : p.padLeft + p.padRight);
    const startP = H ? p.padLeft : p.padTop;
    const startC = H ? p.padTop : p.padLeft;
    const kids = flowChildren(n);

    const lines = p.wrap
      ? wrapLines(
          kids.map((k) => (H ? measure(k).w : measure(k).h)),
          innerP,
          p.spacing,
        )
      : [kids.map((_, i) => i)];

    let lineStart = startC;
    for (const line of lines) {
      const items = line.map((i) => kids[i]!);
      const base = items.map(measure);
      const primSizes = items.map((k, i) => (H ? base[i]!.w : base[i]!.h));
      // Fill children share what's left along the primary axis (only when the frame doesn't hug).
      const growing = items.map((k) => grows(k.data, H) && !p.primaryHug);
      const fixedSum = primSizes.reduce((s, v, i) => s + (growing[i] ? 0 : v), 0);
      const gapCount = Math.max(0, items.length - 1);
      const nGrow = growing.filter(Boolean).length;
      if (nGrow) {
        const free = Math.max(0, innerP - fixedSum - p.spacing * gapCount);
        items.forEach((k, i) => {
          if (growing[i]) {
            const c = clamp(k.data, H ? { w: free / nGrow, h: 0 } : { w: 0, h: free / nGrow });
            primSizes[i] = H ? c.w : c.h;
          }
        });
      }
      const lineCounter = p.wrap
        ? Math.max(0, ...items.map((k, i) => (H ? base[i]!.h : base[i]!.w)))
        : innerC;
      const ctrSizes = items.map((k, i) => {
        if (stretches(k.data, H)) {
          const c = clamp(k.data, H ? { w: 0, h: lineCounter } : { w: lineCounter, h: 0 });
          return H ? c.h : c.w;
        }
        return H ? base[i]!.h : base[i]!.w;
      });

      // Primary positions.
      const used = primSizes.reduce((s, v) => s + v, 0);
      let gap = p.spacing;
      let pos = startP;
      const free = innerP - used - p.spacing * gapCount;
      if (!nGrow) {
        if (p.autoSpacing && !p.primaryHug && items.length > 1) {
          gap = (innerP - used) / gapCount;
        } else if (p.autoSpacing && !p.primaryHug && items.length === 1) {
          pos += (innerP - used) / 2; // a single item is centred
        } else if (p.justify === 'SPACE_AROUND' && !p.primaryHug) {
          gap = (innerP - used) / items.length;
          pos += gap / 2;
        } else if (p.justify === 'CENTER') pos += free / 2;
        else if (p.justify === 'MAX') pos += free;
      }

      items.forEach((k, i) => {
        const ps = primSizes[i]!;
        const cs = ctrSizes[i]!;
        let cpos = lineStart;
        // Non-stretching children, and stretching ones capped by maxSize, follow the alignment.
        if (!stretches(k.data, H) || cs < lineCounter - 0.01) {
          if (p.align === 'CENTER') cpos += (lineCounter - cs) / 2;
          else if (p.align === 'MAX') cpos += lineCounter - cs;
        }
        const box: Box = H ? { x: pos, y: cpos, w: ps, h: cs } : { x: cpos, y: pos, w: cs, h: ps };
        boxes.set(k, box);
        arrange(k, { w: box.w, h: box.h });
        pos += ps + gap;
      });
      lineStart += lineCounter + p.counterSpacing;
    }

    // Absolutely positioned children keep their place.
    for (const c of n.children) {
      if (!c.visible || !isAbsolute(c.data)) continue;
      const s = measure(c);
      boxes.set(c, { x: c.relativeTransform.m02, y: c.relativeTransform.m12, ...s });
      arrange(c, s);
    }
  };

  const rootSize = measure(root);
  boxes.set(root, { x: root.relativeTransform.m02, y: root.relativeTransform.m12, ...rootSize });
  arrange(root, rootSize);
  return { boxes };
}

/** Greedy line breaking for wrapping auto layout: returns item indices per line. */
function wrapLines(sizes: number[], available: number, spacing: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  sizes.forEach((s, i) => {
    const next = line.length ? used + spacing + s : s;
    if (line.length && next > available + 0.01) {
      lines.push(line);
      line = [i];
      used = s;
    } else {
      line.push(i);
      used = next;
    }
  });
  if (line.length) lines.push(line);
  return lines;
}
