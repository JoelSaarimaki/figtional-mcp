/**
 * get_design_context: reference code for a node, in the style of Figma MCP's output
 * (docs/figma-mcp-tools.md §3.3). Nodes become a small element tree with CSS properties, which
 * is emitted either as React + Tailwind (default, like Figma) or as HTML with inline CSS.
 */
import { type NodeChange } from '@figtional/fig-format';
import {
  type FigDocument,
  type SceneNode,
  colorToHex,
  fontWeight,
  isGroupData,
  stackProps,
  variableDefs,
} from '@figtional/fig-model';
import { renderSvg } from '@figtional/fig-render';
import type { AssetServer } from './assets.js';

export type CodeTarget = 'react-tailwind' | 'html-css';

interface El {
  tag: string;
  name: string;
  nodeId: string;
  css: [string, string][];
  attrs?: Record<string, string>;
  /** Asset constant used as src (React) / URL (HTML). */
  asset?: { constName: string; url: string };
  text?: string;
  spans?: { text: string; css: [string, string][] }[];
  children: El[];
}

export interface DesignContextOptions {
  target: CodeTarget;
  /** Max characters of code before truncating (Figma truncates large selections too). */
  maxChars?: number;
}

export interface DesignContextResult {
  code: string;
  truncated: boolean;
  nodeCount: number;
  assets: { name: string; url: string }[];
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const r = (v: number) => Math.round(v * 100) / 100;
const cssVarName = (name: string) => `--${name.replace(/\s+/g, '-')}`;

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON', 'LINE', 'BRUSH']);

class Builder {
  readonly assets = new Map<string, { constName: string; url: string }>();
  private constNames = new Set<string>();
  nodeCount = 0;

  constructor(
    readonly doc: FigDocument,
    readonly fileKey: string,
    readonly assetServer: AssetServer,
    readonly baseUrl: string,
  ) {}

  /** `var(--name, fallback)` when the value is bound to a variable. */
  colorValue(paint: any): string {
    const hex = colorToHex(paint.color ?? { r: 0, g: 0, b: 0, a: 1 }, paint.opacity ?? 1).toLowerCase();
    const alias = paint.colorVar?.value?.alias;
    const v = alias ? this.doc.resolveVariableRef(alias) : undefined;
    return v?.name ? `var(${cssVarName(v.name)}, ${hex})` : hex;
  }

  boundFloat(d: NodeChange, field: string, value: number): string {
    const e = (d.variableConsumptionMap?.entries ?? []).find((x: any) => x.variableField === field);
    const v = e?.variableData?.value?.alias
      ? this.doc.resolveVariableRef(e.variableData.value.alias)
      : undefined;
    return v?.name ? `var(${cssVarName(v.name)}, ${px(value)})` : px(value);
  }

  constName(base: string): string {
    const clean = base
      .replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
      .replace(/^[^A-Za-z]+/, '');
    let name = `img${clean ? clean[0]!.toUpperCase() + clean.slice(1) : ''}`.slice(0, 40) || 'img';
    for (let i = 1; this.constNames.has(name); i++) name = `${name.replace(/\d+$/, '')}${i}`;
    this.constNames.add(name);
    return name;
  }

  imageAsset(hash: Uint8Array, nodeName: string) {
    const hex = Buffer.from(hash).toString('hex');
    const key = `img:${hex}`;
    let a = this.assets.get(key);
    if (!a) {
      const bytes = this.doc.archive?.image(hash);
      const ext = bytes && bytes[0] === 0xff ? 'jpg' : bytes && bytes[0] === 0x47 ? 'gif' : 'png';
      const path = this.assetServer.register(
        `${this.fileKey}:${hex}`,
        ext,
        ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
        () => {
          const b = this.doc.archive?.image(hash);
          if (!b) throw new Error('image not in file');
          return b;
        },
      );
      a = { constName: this.constName(nodeName), url: this.baseUrl + path };
      this.assets.set(key, a);
    }
    return a;
  }

  vectorAsset(node: SceneNode) {
    const key = `svg:${node.id}`;
    let a = this.assets.get(key);
    if (!a) {
      const doc = this.doc;
      const id = node.id;
      const path = this.assetServer.register(`${this.fileKey}:${id}:svg`, 'svg', 'image/svg+xml', () => {
        const n = doc.getNodeById(id);
        if (!n) throw new Error('node not found');
        return renderSvg(doc, n).svg;
      });
      a = { constName: this.constName(node.name || 'vector'), url: this.baseUrl + path };
      this.assets.set(key, a);
    }
    return a;
  }

  build(node: SceneNode, parent: SceneNode | undefined, isRoot: boolean): El | undefined {
    if (!node.visible) return undefined;
    this.nodeCount++;
    const d = node.data;
    const el: El = { tag: 'div', name: node.name, nodeId: node.id, css: [], children: [] };
    const css = el.css;
    const parentStack = parent ? stackProps(parent.data) : undefined;
    const ownStack = stackProps(d);
    const t = node.relativeTransform;
    const absolute = !isRoot && (!parentStack || d.stackPositioning === 'ABSOLUTE');

    // ---- placement and size
    if (absolute) {
      css.push(['position', 'absolute'], ['left', px(t.m02)], ['top', px(t.m12)]);
    } else {
      css.push(['position', 'relative']);
      if (parentStack) css.push(['flex-shrink', '0']);
    }
    const W = node.width;
    const H = node.height;
    if (parentStack && !absolute) {
      const H_ = parentStack.horizontal;
      const grow = (d.stackChildPrimaryGrow ?? 0) > 0;
      const stretch = d.stackChildAlignSelf === 'STRETCH';
      const hugW = ownStack
        ? ownStack.horizontal
          ? ownStack.primaryHug
          : ownStack.counterHug
        : d.textAutoResize === 'WIDTH_AND_HEIGHT';
      const hugH = ownStack
        ? ownStack.horizontal
          ? ownStack.counterHug
          : ownStack.primaryHug
        : d.textAutoResize === 'HEIGHT' || d.textAutoResize === 'WIDTH_AND_HEIGHT';
      const fillW = H_ ? grow : stretch;
      const fillH = H_ ? stretch : grow;
      if (grow) css.push(['flex', '1 0 0']);
      if (fillW && !H_) css.push(['align-self', 'stretch']);
      if (fillH && H_) css.push(['align-self', 'stretch']);
      if (!fillW && !hugW) css.push(['width', px(W)]);
      if (!fillH && !hugH) css.push(['height', px(H)]);
      if (fillW && H_) css.push(['min-width', '1px']);
      if (fillH && !H_) css.push(['min-height', '1px']);
    } else if (!(ownStack && (ownStack.primaryHug || ownStack.counterHug) && isRoot)) {
      css.push(['width', px(W)], ['height', px(H)]);
    } else {
      if (!(ownStack.horizontal ? ownStack.primaryHug : ownStack.counterHug)) css.push(['width', px(W)]);
      if (!(ownStack.horizontal ? ownStack.counterHug : ownStack.primaryHug)) css.push(['height', px(H)]);
    }
    if (d.minSize?.value?.x) css.push(['min-width', px(d.minSize.value.x)]);
    if (d.maxSize?.value?.x) css.push(['max-width', px(d.maxSize.value.x)]);
    const rot = Math.atan2(t.m10, t.m00);
    if (Math.abs(rot) > 1e-4)
      css.push(['transform', `rotate(${r((rot * 180) / Math.PI)}deg)`], ['transform-origin', 'top left']);
    if (d.opacity !== undefined && d.opacity < 1) css.push(['opacity', String(r(d.opacity))]);

    // ---- vectors become SVG assets
    if (
      VECTOR_TYPES.has(node.figType) ||
      (node.figType === 'ELLIPSE' && !(d.fillPaints ?? []).every((p: any) => p.type === 'SOLID'))
    ) {
      const a = this.vectorAsset(node);
      el.tag = 'img';
      el.asset = a;
      css.push(['display', 'block'], ['max-width', 'none']);
      return el;
    }

    // ---- text
    if (node.figType === 'TEXT') {
      this.text(node, el);
      return el;
    }

    // ---- auto layout
    if (ownStack) {
      css.push(['display', 'flex'], ['flex-direction', ownStack.horizontal ? 'row' : 'column']);
      if (ownStack.wrap) css.push(['flex-wrap', 'wrap']);
      const justify = {
        MIN: 'flex-start',
        CENTER: 'center',
        MAX: 'flex-end',
        SPACE_BETWEEN: 'space-between',
        SPACE_EVENLY: 'space-between',
        SPACE_AROUND: 'space-around',
      }[ownStack.justify];
      const align = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }[
        ownStack.align
      ];
      if (align !== 'flex-start') css.push(['align-items', align]);
      if (justify !== 'flex-start') css.push(['justify-content', justify]);
      if (ownStack.spacing && !ownStack.autoSpacing)
        css.push(['gap', this.boundFloat(d, 'STACK_SPACING', ownStack.spacing)]);
      if (ownStack.wrap && ownStack.counterSpacing) css.push(['row-gap', px(ownStack.counterSpacing)]);
      const pads: [string, string, number][] = [
        ['padding-top', 'STACK_PADDING_TOP', d.stackVerticalPadding ?? 0],
        ['padding-right', 'STACK_PADDING_RIGHT', d.stackPaddingRight ?? d.stackHorizontalPadding ?? 0],
        ['padding-bottom', 'STACK_PADDING_BOTTOM', d.stackPaddingBottom ?? d.stackVerticalPadding ?? 0],
        ['padding-left', 'STACK_PADDING_LEFT', d.stackHorizontalPadding ?? 0],
      ];
      for (const [prop, field, v] of pads) if (v) css.push([prop, this.boundFloat(d, field, v)]);
    }

    // ---- appearance
    const fills = (d.fillPaints ?? []).filter((p: any) => p.visible !== false);
    const backgrounds: string[] = [];
    for (const p of [...fills].reverse()) {
      if (p.type === 'SOLID') backgrounds.push(this.colorValue(p));
      else if (p.type === 'GRADIENT_LINEAR') {
        const angle = gradientAngle(p);
        backgrounds.push(
          `linear-gradient(${angle}deg, ${(p.stops ?? []).map((s: any) => `${colorToHex(s.color).toLowerCase()} ${r(s.position * 100)}%`).join(', ')})`,
        );
      } else if (p.type?.startsWith('GRADIENT')) {
        backgrounds.push(
          `radial-gradient(${(p.stops ?? []).map((s: any) => `${colorToHex(s.color).toLowerCase()} ${r(s.position * 100)}%`).join(', ')})`,
        );
      } else if (p.type === 'IMAGE' && p.image?.hash) {
        const a = this.imageAsset(p.image.hash, node.name);
        el.children.push({
          tag: 'div',
          name: '',
          nodeId: '',
          css: [
            ['position', 'absolute'],
            ['inset', '0'],
            ['overflow', 'hidden'],
            ['pointer-events', 'none'],
          ],
          children: [
            {
              tag: 'img',
              name: '',
              nodeId: '',
              asset: a,
              css: [
                ['position', 'absolute'],
                ['width', '100%'],
                ['height', '100%'],
                ['object-fit', p.imageScaleMode === 'FIT' ? 'contain' : 'cover'],
                ['max-width', 'none'],
              ],
              children: [],
            },
          ],
        });
      }
    }
    if (backgrounds.length === 1 && !backgrounds[0]!.includes('gradient'))
      css.push(['background-color', backgrounds[0]!]);
    else if (backgrounds.length) {
      css.push([
        'background-image',
        backgrounds.map((b) => (b.includes('gradient') ? b : `linear-gradient(${b}, ${b})`)).join(', '),
      ]);
    }
    if (node.figType === 'ELLIPSE') css.push(['border-radius', '9999px']);
    else if (d.rectangleCornerRadiiIndependent) {
      const rr = [
        d.rectangleTopLeftCornerRadius,
        d.rectangleTopRightCornerRadius,
        d.rectangleBottomRightCornerRadius,
        d.rectangleBottomLeftCornerRadius,
      ].map((v) => px(v ?? 0));
      if (rr.some((v) => v !== '0px')) css.push(['border-radius', rr.join(' ')]);
    } else if (d.cornerRadius)
      css.push(['border-radius', this.boundFloat(d, 'CORNER_RADIUS', d.cornerRadius)]);
    const strokes = (d.strokePaints ?? []).filter((p: any) => p.visible !== false && p.type === 'SOLID');
    if (strokes.length && (d.strokeWeight ?? 0) > 0) {
      const color = this.colorValue(strokes[strokes.length - 1]);
      const w = d.strokeWeight ?? 1;
      const lineStyle = (d.dashPattern ?? []).length ? 'dashed' : 'solid';
      if (d.borderStrokeWeightsIndependent) {
        for (const [side, v] of [
          ['top', d.borderTopWeight],
          ['right', d.borderRightWeight],
          ['bottom', d.borderBottomWeight],
          ['left', d.borderLeftWeight],
        ] as const) {
          if (v) css.push([`border-${side}`, `${px(v)} ${lineStyle} ${color}`]);
        }
      } else if (d.strokeAlign === 'OUTSIDE') css.push(['outline', `${px(w)} ${lineStyle} ${color}`]);
      else if (d.strokeAlign === 'CENTER')
        css.push(['outline', `${px(w)} ${lineStyle} ${color}`], ['outline-offset', px(-w / 2)]);
      else css.push(['border', `${px(w)} ${lineStyle} ${color}`]);
      if (d.strokeAlign === 'INSIDE' || d.strokeAlign === undefined) css.push(['box-sizing', 'border-box']);
    }
    const shadows = (d.effects ?? [])
      .filter((e: any) => e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'))
      .map(
        (e: any) =>
          `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius ?? 0)} ${px(e.spread ?? 0)} ${colorToHex(e.color).toLowerCase()}`,
      );
    if (shadows.length) css.push(['box-shadow', shadows.join(', ')]);
    const blur = (d.effects ?? []).find(
      (e: any) => e.visible !== false && (e.type === 'FOREGROUND_BLUR' || e.type === 'LAYER_BLUR'),
    );
    if (blur) css.push(['filter', `blur(${px((blur.radius ?? 0) / 2)})`]);
    const bgBlur = (d.effects ?? []).find((e: any) => e.visible !== false && e.type === 'BACKGROUND_BLUR');
    if (bgBlur) css.push(['backdrop-filter', `blur(${px((bgBlur.radius ?? 0) / 2)})`]);
    const clips =
      ['FRAME', 'SYMBOL', 'INSTANCE'].includes(node.figType) &&
      !isGroupData(d) &&
      d.frameMaskDisabled !== true;
    if (clips && node.children.length) css.push(['overflow', 'clip']);

    // ---- children
    if (node.figType !== 'BOOLEAN_OPERATION') {
      for (const c of node.children) {
        if (c.data.mask) continue; // masks are approximated by the clipping of their parent
        const ce = this.build(c, node, false);
        if (ce) el.children.push(ce);
      }
    }
    return el;
  }

  private text(node: SceneNode, el: El) {
    const d = node.data;
    el.tag = 'p';
    const css = el.css;
    css.push(...this.fontCss(d, d));
    if (d.textAlignHorizontal && d.textAlignHorizontal !== 'LEFT') {
      css.push([
        'text-align',
        { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[d.textAlignHorizontal as string] ?? 'left',
      ]);
    }
    if (d.textAutoResize === 'WIDTH_AND_HEIGHT') css.push(['white-space', 'nowrap']);
    else css.push(['white-space', 'pre-wrap']);
    const chars: string = d.textData?.characters ?? '';
    const ids: number[] = d.textData?.characterStyleIDs ?? [];
    const table = new Map<number, any>(
      (d.textData?.styleOverrideTable ?? []).map((s: any) => [s.styleID, s]),
    );
    if (!ids.length || ids.every((i) => i === ids[0]) || !table.size) {
      el.text = chars;
      return;
    }
    // Mixed styles: one span per run.
    el.spans = [];
    let start = 0;
    for (let i = 1; i <= chars.length; i++) {
      const prev = ids[i - 1] ?? 0;
      const cur = i < chars.length ? (ids[i] ?? 0) : -1;
      if (cur !== prev) {
        const o = table.get(prev);
        el.spans.push({ text: chars.slice(start, i), css: o ? this.fontCss({ ...d, ...o }, d) : [] });
        start = i;
      }
    }
  }

  /** Typography CSS. Only properties differing from `base` are emitted for spans. */
  private fontCss(d: any, base: any): [string, string][] {
    const out: [string, string][] = [];
    const isBase = d === base;
    const fam = d.fontName?.family;
    const style = d.fontName?.style ?? 'Regular';
    if (isBase || d.fontName !== base.fontName) {
      out.push(['font-family', `'${fam}', sans-serif`], ['font-weight', String(fontWeight(style))]);
      if (/italic/i.test(style)) out.push(['font-style', 'italic']);
    }
    if (isBase || d.fontSize !== base.fontSize) if (d.fontSize) out.push(['font-size', px(d.fontSize)]);
    if (isBase || d.lineHeight !== base.lineHeight) {
      const lh = d.lineHeight;
      if (lh?.units === 'PIXELS') out.push(['line-height', px(lh.value)]);
      else if (lh?.units === 'PERCENT' && lh.value !== 100) out.push(['line-height', `${r(lh.value / 100)}`]);
      else if (lh?.units === 'RAW') out.push(['line-height', `${r(lh.value)}`]);
      else if (isBase) out.push(['line-height', 'normal']);
    }
    if ((isBase || d.letterSpacing !== base.letterSpacing) && d.letterSpacing?.value) {
      const ls = d.letterSpacing;
      out.push(['letter-spacing', ls.units === 'PERCENT' ? `${r(ls.value / 100)}em` : px(ls.value)]);
    }
    if (isBase || d.fillPaints !== base.fillPaints) {
      const fill = (d.fillPaints ?? []).filter((p: any) => p.visible !== false && p.type === 'SOLID').pop();
      if (fill) out.push(['color', this.colorValue(fill)]);
    }
    if (
      d.textDecoration &&
      d.textDecoration !== 'NONE' &&
      (isBase || d.textDecoration !== base.textDecoration)
    ) {
      out.push(['text-decoration', d.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'underline']);
    }
    if (d.textCase && d.textCase !== 'ORIGINAL' && (isBase || d.textCase !== base.textCase)) {
      out.push([
        'text-transform',
        { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[d.textCase as string] ?? 'none',
      ]);
    }
    return out;
  }
}

function gradientAngle(p: any): number {
  // Direction of the gradient (unit gradient goes from (0,0.5) to (1,0.5)) in node space.
  const m = p.transform ?? { m00: 1, m01: 0, m10: 0, m11: 1 };
  const det = m.m00 * m.m11 - m.m01 * m.m10 || 1;
  const dx = m.m11 / det;
  const dy = -m.m10 / det;
  return r(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360);
}

// ------------------------------------------------------------------ emitters

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrEsc = (s: string) => esc(s).replace(/"/g, '&quot;');

const TW_SIMPLE: Record<string, Record<string, string>> = {
  position: { absolute: 'absolute', relative: 'relative' },
  display: { flex: 'flex', block: 'block' },
  'flex-direction': { row: 'flex-row', column: 'flex-col' },
  'flex-wrap': { wrap: 'flex-wrap' },
  'flex-shrink': { '0': 'shrink-0' },
  'align-items': { center: 'items-center', 'flex-end': 'items-end', baseline: 'items-baseline' },
  'justify-content': {
    center: 'justify-center',
    'flex-end': 'justify-end',
    'space-between': 'justify-between',
    'space-around': 'justify-around',
  },
  'align-self': { stretch: 'self-stretch' },
  overflow: { clip: 'overflow-clip', hidden: 'overflow-hidden' },
  'white-space': { nowrap: 'whitespace-nowrap', 'pre-wrap': 'whitespace-pre-wrap' },
  'text-align': { center: 'text-center', right: 'text-right', justify: 'text-justify' },
  'font-style': { italic: 'italic' },
  'text-decoration': { underline: 'underline', 'line-through': 'line-through' },
  'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize' },
  'pointer-events': { none: 'pointer-events-none' },
  'object-fit': { cover: 'object-cover', contain: 'object-contain' },
  'box-sizing': { 'border-box': 'box-border' },
  inset: { '0': 'inset-0' },
  'max-width': { none: 'max-w-none' },
  width: { '100%': 'size-full' },
};
const TW_PREFIX: Record<string, string> = {
  left: 'left',
  top: 'top',
  width: 'w',
  height: 'h',
  'min-width': 'min-w',
  'max-width': 'max-w',
  'min-height': 'min-h',
  gap: 'gap',
  'row-gap': 'gap-y',
  'padding-top': 'pt',
  'padding-right': 'pr',
  'padding-bottom': 'pb',
  'padding-left': 'pl',
  'border-radius': 'rounded',
  opacity: 'opacity',
  'background-color': 'bg',
  'background-image': 'bg',
  color: 'text',
  'font-size': 'text',
  'line-height': 'leading',
  'letter-spacing': 'tracking',
  'font-weight': 'font',
  'box-shadow': 'shadow',
  flex: 'flex',
};

const twValue = (v: string) => v.replace(/\s*,\s*/g, ',').replace(/\s+/g, '_');

function tailwind(css: [string, string][]): string {
  const out: string[] = [];
  const map = new Map(css);
  // Collapse equal paddings.
  const [pt, pr, pb, pl] = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].map((k) =>
    map.get(k),
  );
  const skip = new Set<string>();
  if (pt && pt === pb && pr && pr === pl && pt === pr) {
    out.push(`p-[${twValue(pt)}]`);
    ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'].forEach((k) => skip.add(k));
  } else {
    if (pl && pl === pr) {
      out.push(`px-[${twValue(pl)}]`);
      skip.add('padding-left').add('padding-right');
    }
    if (pt && pt === pb) {
      out.push(`py-[${twValue(pt)}]`);
      skip.add('padding-top').add('padding-bottom');
    }
  }
  if (map.get('width') === '100%' && map.get('height') === '100%') skip.add('height');
  for (const [k, v] of css) {
    if (skip.has(k)) continue;
    const simple = TW_SIMPLE[k]?.[v];
    if (simple) {
      out.push(simple);
      continue;
    }
    if (k === 'font-family') {
      const fam = v.replace(/^'([^']+)'.*$/, '$1');
      out.push(`font-['${fam.replace(/\s+/g, '_')}',sans-serif]`);
      continue;
    }
    // `border` / `outline` / `border-<side>` shorthands only: `border-radius` is `rounded` below.
    if (k === 'border' || k === 'outline' || /^border-(top|right|bottom|left)$/.test(k)) {
      const [w, style, ...color] = v.split(' ');
      const side = k === 'border' || k === 'outline' ? '' : `-${k.split('-')[1]![0]}`;
      const base = k === 'outline' ? 'outline' : 'border';
      out.push(`${base}${side}-[${w}]`, `${base}-${style}`, `${base}-[${twValue(color.join(' '))}]`);
      continue;
    }
    if (k === 'color') {
      out.push(v.startsWith('#') ? `text-[${v}]` : `text-[color:${twValue(v)}]`);
      continue;
    }
    if (k === 'font-size') {
      out.push(v.startsWith('var(') ? `text-[length:${twValue(v)}]` : `text-[${v}]`);
      continue;
    }
    const prefix = TW_PREFIX[k];
    if (prefix) out.push(`${prefix}-[${twValue(v)}]`);
    else out.push(`[${k}:${twValue(v)}]`);
  }
  return out.join(' ');
}

function emitReact(root: El, componentName: string, assets: { constName: string; url: string }[]): string {
  const lines: string[] = [];
  for (const a of assets) lines.push(`const ${a.constName} = "${a.url}";`);
  if (assets.length) lines.push('');
  lines.push(`export default function ${componentName}() {`, '  return (');
  const emit = (e: El, depth: number, isRoot: boolean) => {
    const pad = '  '.repeat(depth);
    const attrs: string[] = [];
    if (e.asset) attrs.push(`alt=""`);
    const cls = tailwind(e.css);
    if (cls) attrs.push(`className="${cls}"`);
    if (e.name) attrs.push(`data-name="${attrEsc(e.name)}"`);
    if (e.nodeId) attrs.push(`data-node-id="${e.nodeId}"`);
    if (e.asset) attrs.push(`src={${e.asset.constName}}`);
    void isRoot;
    const open = `${pad}<${e.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    if (e.tag === 'img') {
      lines.push(`${open} />`);
      return;
    }
    if (e.spans) {
      lines.push(`${open}>`);
      for (const s of e.spans) {
        const c = tailwind(s.css);
        lines.push(`${pad}  <span${c ? ` className="${c}"` : ''}>${jsxText(s.text)}</span>`);
      }
      lines.push(`${pad}</${e.tag}>`);
      return;
    }
    if (e.text !== undefined) {
      lines.push(`${open}>${jsxText(e.text)}</${e.tag}>`);
      return;
    }
    if (!e.children.length) {
      lines.push(`${open} />`);
      return;
    }
    lines.push(`${open}>`);
    for (const c of e.children) emit(c, depth + 1, false);
    lines.push(`${pad}</${e.tag}>`);
  };
  emit(root, 2, true);
  lines.push('  );', '}');
  return lines.join('\n');
}

function jsxText(s: string): string {
  if (/[{}<>]/.test(s) || s.includes('\n')) return `{${JSON.stringify(s)}}`;
  return s;
}

function emitHtml(root: El): string {
  const lines: string[] = [];
  const style = (css: [string, string][]) => css.map(([k, v]) => `${k}: ${v}`).join('; ');
  const emit = (e: El, depth: number) => {
    const pad = '  '.repeat(depth);
    const attrs: string[] = [];
    const st = style(e.css);
    if (st) attrs.push(`style="${attrEsc(st)}"`);
    if (e.name) attrs.push(`data-name="${attrEsc(e.name)}"`);
    if (e.nodeId) attrs.push(`data-node-id="${e.nodeId}"`);
    if (e.asset) attrs.push(`src="${e.asset.url}" alt=""`);
    const open = `${pad}<${e.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    if (e.tag === 'img') {
      lines.push(open);
      return;
    }
    if (e.spans) {
      lines.push(
        `${open}${e.spans.map((s) => `<span${s.css.length ? ` style="${attrEsc(style(s.css))}"` : ''}>${esc(s.text)}</span>`).join('')}</${e.tag}>`,
      );
      return;
    }
    if (e.text !== undefined) {
      lines.push(`${open}${esc(e.text)}</${e.tag}>`);
      return;
    }
    if (!e.children.length) {
      lines.push(`${open}</${e.tag}>`);
      return;
    }
    lines.push(open);
    for (const c of e.children) emit(c, depth + 1);
    lines.push(`${pad}</${e.tag}>`);
  };
  emit(root, 0);
  return lines.join('\n');
}

function componentName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const n = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(n) ? n : `Node${n}`;
}

/** Picks the output style from Figma MCP's clientLanguages / clientFrameworks hints. */
export function codeTarget(clientLanguages?: string, clientFrameworks?: string): CodeTarget {
  const fw = (clientFrameworks ?? '').toLowerCase();
  const lang = (clientLanguages ?? '').toLowerCase();
  if (fw.includes('react') || fw.includes('next')) return 'react-tailwind';
  if (
    /\bhtml\b/.test(fw) ||
    (/\bhtml\b/.test(lang) && !/(typescript|javascript|jsx|tsx)/.test(lang)) ||
    fw === 'vanilla'
  ) {
    return 'html-css';
  }
  return 'react-tailwind';
}

export async function designContext(
  doc: FigDocument,
  fileKey: string,
  node: SceneNode,
  assetServer: AssetServer,
  opts: DesignContextOptions,
): Promise<DesignContextResult> {
  const baseUrl = await assetServer.baseUrl();
  const b = new Builder(doc, fileKey, assetServer, baseUrl);
  const root = b.build(node, undefined, true) ?? {
    tag: 'div',
    name: node.name,
    nodeId: node.id,
    css: [],
    children: [],
  };
  const assets = [...b.assets.values()];
  let code = opts.target === 'html-css' ? emitHtml(root) : emitReact(root, componentName(node.name), assets);
  const max = opts.maxChars ?? 100_000;
  let truncated = false;
  if (code.length > max) {
    truncated = true;
    code = code.slice(0, max);
  }
  return {
    code,
    truncated,
    nodeCount: b.nodeCount,
    assets: assets.map((a) => ({ name: a.constName, url: a.url })),
  };
}

/**
 * CSS of one node as `node.getCSSAsync()` returns it (property → value), from the same rules as
 * get_design_context. Images are referenced by their asset path without a running asset server.
 */
export function nodeCss(doc: FigDocument, fileKey: string, node: SceneNode): Record<string, string> {
  const paths = { register: (key: string, ext: string) => `/assets/${key.replace(/[^\w-]/g, '_')}.${ext}` };
  const b = new Builder(doc, fileKey, paths as unknown as AssetServer, '');
  const el = b.build(node, node.parent, true);
  return Object.fromEntries(el?.css ?? []);
}

/** The full tool response text, framed like Figma MCP's output. */
export async function designContextText(
  doc: FigDocument,
  fileKey: string,
  node: SceneNode,
  assetServer: AssetServer,
  target: CodeTarget,
): Promise<string> {
  const r = await designContext(doc, fileKey, node, assetServer, { target });
  const parts: string[] = [];
  if (r.truncated) {
    parts.push(
      `The output was truncated because the selection is too large (${r.nodeCount} layers). Use get_metadata to get an overview of the node structure, then call get_design_context on the specific child nodes you need.`,
      '',
    );
  }
  parts.push(r.code, '');
  if (target === 'react-tailwind') {
    parts.push(
      "SUPER CRITICAL: The generated React+Tailwind code MUST be converted to match the target project's technology stack and styling system.",
      '1. Analyze the target codebase to identify: technology stack, styling approach, component patterns, and design tokens.',
      '2. Convert React syntax to the target framework/library (if different).',
      '3. Transform all Tailwind classes to the target styling system while preserving exact visual design.',
      "4. Follow the project's existing patterns and conventions.",
      'DO NOT install any Tailwind as a dependency unless the user instructs you to do so.',
    );
  } else {
    parts.push(
      "Reference HTML with inline CSS. Convert it to the project's components, styling system and design tokens while preserving the visual design.",
    );
  }
  if (r.assets.length) {
    parts.push(
      '',
      `Images and vectors are served by Figtional's local asset server (${r.assets[0]!.url.replace(/\/assets\/.*$/, '')}). Download the assets you need into the project; the URLs only work while this Figtional session is running.`,
    );
  }
  const defs = variableDefs(doc, node);
  const names = Object.keys(defs);
  if (names.length) {
    parts.push('', "These variables and styles are used in this design (use the project's matching tokens):");
    for (const n of names.slice(0, 80)) parts.push(`- ${n}: ${defs[n]}`);
    if (names.length > 80) parts.push(`- … ${names.length - 80} more (see get_variable_defs)`);
  }
  if (r.nodeCount < 3 && node.children.length > 0) {
    parts.push(
      '',
      'Note: this response is sparse. Call get_design_context on the visible child nodes for more detail.',
    );
  }
  return parts.join('\n');
}
