/**
 * Node → SVG. Uses Figma's own precomputed geometry (fillGeometry / strokeGeometry blobs) for
 * shapes, and glyph outlines (derivedTextData) for text, so unedited content looks the way Figma
 * laid it out. See docs/fig-format.md.
 */
import { type Matrix, type NodeChange, decodePathCommands, pathCommandsToSvg } from '@figtional/fig-format';
import {
  type FigDocument,
  type Rect,
  type SceneNode,
  invert,
  isGroupData,
  measureText,
  multiply,
  styleWeight,
} from '@figtional/fig-model';

export interface RenderOptions {
  /** Draw a background behind the node (CSS colour). Default: transparent. */
  background?: string;
  /** Embed images (default true). Disable for faster structural renders. */
  images?: boolean;
  /** Extra space around the content, in px. */
  padding?: number;
}

export interface SvgResult {
  svg: string;
  /** Bounds of the rendered area in page coordinates. */
  bounds: Rect;
  /** Problems worth reporting (missing images, unsupported effects …). */
  warnings: string[];
}

const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const matrixAttr = (m: Matrix) =>
  m.m00 === 1 && m.m01 === 0 && m.m10 === 0 && m.m11 === 1
    ? m.m02 === 0 && m.m12 === 0
      ? ''
      : ` transform="translate(${fmt(m.m02)} ${fmt(m.m12)})"`
    : ` transform="matrix(${fmt(m.m00)} ${fmt(m.m10)} ${fmt(m.m01)} ${fmt(m.m11)} ${fmt(m.m02)} ${fmt(m.m12)})"`;

const BLEND: Record<string, string> = {
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

function rgb(c: { r: number; g: number; b: number }): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return 'application/octet-stream';
}

/** True if a frame-like node clips its children. Groups never clip. */
export function clipsContent(n: NodeChange): boolean {
  if (isGroupData(n)) return false;
  const t = n.type;
  // Sections are exported at their own bounds (verified against Futurice.com UI exports).
  if (t === 'SECTION') return true;
  if (t !== 'FRAME' && t !== 'SYMBOL' && t !== 'INSTANCE' && t !== 'SECTION') return false;
  return n.frameMaskDisabled !== true;
}

class SvgBuilder {
  private defs: string[] = [];
  private nextId = 0;
  readonly warnings = new Set<string>();
  private imageCache = new Map<string, string | null>();

  constructor(
    readonly doc: FigDocument,
    readonly opts: RenderOptions,
  ) {}

  id(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }

  def(xml: string): void {
    this.defs.push(xml);
  }

  defsXml(): string {
    return this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
  }

  blobPath(index: number | undefined): string | undefined {
    if (index === undefined) return undefined;
    const blob = this.doc.blobs[index];
    if (!blob) return undefined;
    try {
      return pathCommandsToSvg(decodePathCommands(blob.bytes));
    } catch {
      this.warnings.add('undecodable geometry blob');
      return undefined;
    }
  }

  imageDataUri(hash: Uint8Array): string | null {
    const key = Buffer.from(hash).toString('hex');
    let uri = this.imageCache.get(key);
    if (uri === undefined) {
      const bytes = this.doc.archive?.image(hash);
      uri = bytes ? `data:${sniffMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}` : null;
      if (!bytes) this.warnings.add(`missing image ${key}`);
      this.imageCache.set(key, uri);
    }
    return uri;
  }

  /** SVG fill value for a paint, defining gradients/patterns as needed. */
  paintFill(p: any, w: number, h: number): { fill: string; opacity: number } | undefined {
    const opacity = p.opacity ?? 1;
    switch (p.type) {
      case 'SOLID':
        return { fill: rgb(p.color), opacity: (p.color?.a ?? 1) * opacity };
      case 'GRADIENT_LINEAR':
      case 'GRADIENT_RADIAL':
      case 'GRADIENT_ANGULAR':
      case 'GRADIENT_DIAMOND': {
        const id = this.id('g');
        // Paint transform maps node-normalised space to gradient space; invert to place the unit gradient.
        let m: Matrix;
        try {
          m = multiply({ m00: w, m01: 0, m02: 0, m10: 0, m11: h, m12: 0 }, invert(p.transform ?? IDENTITY_M));
        } catch {
          return undefined;
        }
        const tr = `matrix(${fmt(m.m00)} ${fmt(m.m10)} ${fmt(m.m01)} ${fmt(m.m11)} ${fmt(m.m02)} ${fmt(m.m12)})`;
        const stops = (p.stops ?? [])
          .map(
            (s: any) =>
              `<stop offset="${fmt(s.position)}" stop-color="${rgb(s.color)}"${(s.color?.a ?? 1) < 1 ? ` stop-opacity="${fmt(s.color.a)}"` : ''}/>`,
          )
          .join('');
        if (p.type === 'GRADIENT_LINEAR') {
          this.def(
            `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="${tr}">${stops}</linearGradient>`,
          );
        } else {
          if (p.type !== 'GRADIENT_RADIAL') this.warnings.add(`${p.type} approximated as radial gradient`);
          this.def(
            `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="${tr}">${stops}</radialGradient>`,
          );
        }
        return { fill: `url(#${id})`, opacity };
      }
      case 'IMAGE': {
        if (this.opts.images === false || !p.image?.hash) return { fill: '#d9d9d9', opacity };
        const uri = this.imageDataUri(p.image.hash);
        if (!uri) return { fill: '#d9d9d9', opacity };
        const id = this.id('p');
        this.def(
          `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmt(w)}" height="${fmt(h)}">${this.imageElement(p, uri, w, h)}</pattern>`,
        );
        return { fill: `url(#${id})`, opacity };
      }
      default:
        this.warnings.add(`paint type ${p.type} not rendered`);
        return undefined;
    }
  }

  private imageElement(p: any, uri: string, w: number, h: number): string {
    const iw = p.originalImageWidth || w;
    const ih = p.originalImageHeight || h;
    const mode = p.imageScaleMode ?? 'FILL';
    if (mode === 'STRETCH') {
      // Plugin API "CROP": transform maps node-normalised space to image-normalised space.
      try {
        const m = multiply(
          { m00: w, m01: 0, m02: 0, m10: 0, m11: h, m12: 0 },
          invert(p.transform ?? IDENTITY_M),
        );
        return `<image href="${uri}" width="1" height="1" preserveAspectRatio="none" transform="matrix(${fmt(m.m00)} ${fmt(m.m10)} ${fmt(m.m01)} ${fmt(m.m11)} ${fmt(m.m02)} ${fmt(m.m12)})"/>`;
      } catch {
        return `<image href="${uri}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none"/>`;
      }
    }
    if (mode === 'TILE') {
      const s = p.scale ?? 1;
      const tw = iw * s;
      const th = ih * s;
      const parts: string[] = [];
      for (let y = 0; y < h && parts.length < 400; y += th)
        for (let x = 0; x < w && parts.length < 400; x += tw)
          parts.push(
            `<image href="${uri}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(tw)}" height="${fmt(th)}"/>`,
          );
      return parts.join('');
    }
    const fit = mode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice';
    const rot = p.rotation ? ` transform="rotate(${fmt(p.rotation)} ${fmt(w / 2)} ${fmt(h / 2)})"` : '';
    return `<image href="${uri}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="${fit}"${rot}/>`;
  }
}

const IDENTITY_M: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** Rectangle path with optional (independent) corner radii, for nodes without stored geometry. */
function rectPath(n: NodeChange, w: number, h: number): string {
  const r = n.cornerRadius ?? 0;
  const ind = n.rectangleCornerRadiiIndependent;
  const tl = Math.min(ind ? (n.rectangleTopLeftCornerRadius ?? r) : r, w / 2, h / 2);
  const tr = Math.min(ind ? (n.rectangleTopRightCornerRadius ?? r) : r, w / 2, h / 2);
  const br = Math.min(ind ? (n.rectangleBottomRightCornerRadius ?? r) : r, w / 2, h / 2);
  const bl = Math.min(ind ? (n.rectangleBottomLeftCornerRadius ?? r) : r, w / 2, h / 2);
  if (!tl && !tr && !br && !bl) return `M0 0H${fmt(w)}V${fmt(h)}H0Z`;
  return (
    `M${fmt(tl)} 0H${fmt(w - tr)}A${fmt(tr)} ${fmt(tr)} 0 0 1 ${fmt(w)} ${fmt(tr)}` +
    `V${fmt(h - br)}A${fmt(br)} ${fmt(br)} 0 0 1 ${fmt(w - br)} ${fmt(h)}` +
    `H${fmt(bl)}A${fmt(bl)} ${fmt(bl)} 0 0 1 0 ${fmt(h - bl)}V${fmt(tl)}A${fmt(tl)} ${fmt(tl)} 0 0 1 ${fmt(tl)} 0Z`
  );
}

function ellipsePath(w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  return `M0 ${fmt(ry)}A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(w)} ${fmt(ry)}A${fmt(rx)} ${fmt(ry)} 0 1 0 0 ${fmt(ry)}Z`;
}

/** Outline of the node's own shape (for fills, clipping and masks). */
function shapePaths(b: SvgBuilder, n: NodeChange): { d: string; rule: string }[] {
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const geo = (n.fillGeometry ?? [])
    .map((g: any) => ({
      d: b.blobPath(g.commandsBlob),
      rule: g.windingRule === 'ODD' ? 'evenodd' : 'nonzero',
    }))
    .filter((g: { d?: string }) => g.d) as { d: string; rule: string }[];
  if (geo.length) return geo;
  if (n.type === 'ELLIPSE') return [{ d: ellipsePath(w, h), rule: 'nonzero' }];
  if (['FRAME', 'SYMBOL', 'INSTANCE', 'ROUNDED_RECTANGLE', 'RECTANGLE', 'SECTION'].includes(n.type ?? '')) {
    return w > 0 && h > 0 ? [{ d: rectPath(n, w, h), rule: 'nonzero' }] : [];
  }
  return [];
}

function filterFor(b: SvgBuilder, n: NodeChange): string | undefined {
  const effects = (n.effects ?? []).filter((e: any) => e.visible !== false);
  if (!effects.length) return undefined;
  const parts: string[] = [];
  const merge: string[] = [];
  let i = 0;
  for (const e of effects) {
    const sd = fmt((e.radius ?? 0) / 2);
    const c = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
    if (e.type === 'DROP_SHADOW') {
      const r = `ds${i++}`;
      const spread = e.spread ?? 0;
      parts.push(
        `<feMorphology in="SourceAlpha" operator="${spread >= 0 ? 'dilate' : 'erode'}" radius="${fmt(Math.abs(spread))}" result="${r}m"/>` +
          `<feOffset in="${r}m" dx="${fmt(e.offset?.x ?? 0)}" dy="${fmt(e.offset?.y ?? 0)}" result="${r}o"/>` +
          `<feGaussianBlur in="${r}o" stdDeviation="${sd}" result="${r}b"/>` +
          `<feFlood flood-color="${rgb(c)}" flood-opacity="${fmt(c.a ?? 1)}"/>` +
          `<feComposite in2="${r}b" operator="in" result="${r}"/>`,
      );
      merge.push(r);
    } else if (e.type === 'INNER_SHADOW') {
      const r = `is${i++}`;
      parts.push(
        `<feOffset in="SourceAlpha" dx="${fmt(e.offset?.x ?? 0)}" dy="${fmt(e.offset?.y ?? 0)}" result="${r}o"/>` +
          `<feGaussianBlur in="${r}o" stdDeviation="${sd}" result="${r}b"/>` +
          `<feComposite in="SourceAlpha" in2="${r}b" operator="out" result="${r}c"/>` +
          `<feFlood flood-color="${rgb(c)}" flood-opacity="${fmt(c.a ?? 1)}"/>` +
          `<feComposite in2="${r}c" operator="in" result="${r}"/>`,
      );
      merge.push('__SRC__', r);
    } else if (e.type === 'LAYER_BLUR') {
      parts.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${sd}" result="lb${i}"/>`);
      merge.push(`lb${i++}`);
    } else {
      b.warnings.add(`${e.type} effect not rendered`);
    }
  }
  if (!parts.length) return undefined;
  const id = b.id('f');
  // Drop shadows go underneath the source; inner shadows and layer blur on top.
  const shadows = merge.filter((m) => m.startsWith('ds'));
  const rest = merge.filter((m) => !m.startsWith('ds') && m !== '__SRC__');
  const hasBlur = rest.some((m) => m.startsWith('lb'));
  const nodes = [...shadows, ...(hasBlur ? [] : ['SourceGraphic']), ...rest]
    .map((m) => `<feMergeNode in="${m}"/>`)
    .join('');
  b.def(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join('')}<feMerge>${nodes}</feMerge></filter>`,
  );
  return id;
}

/** Text from glyph outlines when available; otherwise SVG <text> with installed fonts. */
function textXml(b: SvgBuilder, n: NodeChange): string {
  const fills = (n.fillPaints ?? []).filter((p: any) => p.visible !== false);
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const styleTable = new Map<number, any>(
    (n.textData?.styleOverrideTable ?? []).map((s: any) => [s.styleID, s]),
  );
  const charStyles: number[] = n.textData?.characterStyleIDs ?? [];
  const fillFor = (styleId: number) => {
    const o = styleTable.get(styleId);
    const paints = (o?.fillPaints ?? fills).filter((p: any) => p.visible !== false);
    const p = paints[paints.length - 1];
    return p ? b.paintFill(p, w, h) : undefined;
  };
  const glyphs = n.derivedTextData?.glyphs;
  const parts: string[] = [];
  if (glyphs?.length) {
    // Group glyphs by style so each run is one <path>.
    const runs = new Map<number, string[]>();
    for (const g of glyphs) {
      if (g.commandsBlob === undefined) continue; // spaces, emoji images
      const blob = b.doc.blobs[g.commandsBlob];
      if (!blob) continue;
      const cmds = decodePathCommands(blob.bytes);
      const s = g.fontSize ?? n.fontSize ?? 12;
      // Glyph outlines are in em units with y pointing up.
      const d = pathCommandsToSvg(
        cmds.map((c) => flipY(c)),
        s,
        g.position?.x ?? 0,
        g.position?.y ?? 0,
      );
      const style = charStyles[g.firstCharacter ?? 0] ?? 0;
      let list = runs.get(style);
      if (!list) runs.set(style, (list = []));
      list.push(d);
    }
    for (const [style, ds] of runs) {
      const f = fillFor(style);
      if (!f) continue;
      parts.push(
        `<path d="${ds.join('')}" fill="${f.fill}"${f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : ''}/>`,
      );
    }
    for (const deco of n.derivedTextData?.decorations ?? []) {
      const f = fillFor(deco.styleID ?? 0);
      if (!f) continue;
      for (const r of deco.rects ?? []) {
        parts.push(
          `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" fill="${f.fill}"${f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : ''}/>`,
        );
      }
    }
    return parts.join('');
  }
  // Fallback: edited/new text without Figma's layout: lay it out with installed fonts
  // (same measurement as fig-model uses for text sizes), drawn by the font, not glyph outlines.
  const chars: string = n.textData?.characters ?? '';
  if (!chars) return '';
  const f = fillFor(0);
  const size = n.fontSize ?? 12;
  const family = n.fontName?.family ?? 'Inter';
  const style = n.fontName?.style ?? 'Regular';
  const wrapWidth = n.textAutoResize === 'WIDTH_AND_HEIGHT' ? undefined : w;
  const m = measureText(
    chars,
    { family, style, size, lineHeight: n.lineHeight, letterSpacing: n.letterSpacing },
    wrapWidth,
  );
  const lineH = Math.round(m.lineHeight);
  const total = lineH * m.lines.length;
  const vAlign = n.textAlignVertical ?? 'TOP';
  const top = vAlign === 'CENTER' ? (h - total) / 2 : vAlign === 'BOTTOM' ? h - total : 0;
  const align = n.textAlignHorizontal ?? 'LEFT';
  const anchor = align === 'CENTER' ? 'middle' : align === 'RIGHT' ? 'end' : 'start';
  const x = anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0;
  const tspans = m.lines
    .map((line, i) => `<tspan x="${fmt(x)}" y="${fmt(top + lineH * i + m.ascent)}">${esc(line.text)}</tspan>`)
    .join('');
  b.warnings.add('text without stored layout drawn with installed fonts');
  const ls = n.letterSpacing?.value
    ? ` letter-spacing="${fmt(n.letterSpacing.units === 'PIXELS' ? n.letterSpacing.value : (size * n.letterSpacing.value) / 100)}"`
    : '';
  const deco =
    n.textDecoration === 'UNDERLINE'
      ? ' text-decoration="underline"'
      : n.textDecoration === 'STRIKETHROUGH'
        ? ' text-decoration="line-through"'
        : '';
  return (
    `<text font-family="${esc(family)}, sans-serif" font-size="${fmt(size)}" font-weight="${styleWeight(style)}"` +
    `${/italic/i.test(style) ? ' font-style="italic"' : ''} text-anchor="${anchor}" xml:space="preserve" fill="${f?.fill ?? '#000'}"` +
    `${f && f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : ''}${ls}${deco}>${tspans}</text>`
  );
}

function flipY<T extends { type: string }>(c: T): T {
  const o: any = { ...c };
  for (const k of ['y', 'y1', 'y2']) if (k in o) o[k] = -o[k];
  return o;
}

/** Paths for fills + strokes of a node's own shape (not its children). */
function ownPaint(b: SvgBuilder, n: NodeChange): string {
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const out: string[] = [];
  if (n.type === 'TEXT') return textXml(b, n);
  const fills = (n.fillPaints ?? []).filter((p: any) => p.visible !== false);
  if (fills.length) {
    const shapes = shapePaths(b, n);
    for (const p of fills) {
      const f = b.paintFill(p, w, h);
      if (!f) continue;
      const blend = p.blendMode && BLEND[p.blendMode] ? ` style="mix-blend-mode:${BLEND[p.blendMode]}"` : '';
      for (const s of shapes) {
        out.push(
          `<path d="${s.d}" fill="${f.fill}"${f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : ''}${s.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${blend}/>`,
        );
      }
    }
  }
  const strokes = (n.strokePaints ?? []).filter((p: any) => p.visible !== false);
  if (strokes.length && (n.strokeWeight ?? 1) > 0) {
    const geo = (n.strokeGeometry ?? [])
      .map((g: any) => b.blobPath(g.commandsBlob))
      .filter(Boolean) as string[];
    // For INSIDE/OUTSIDE strokes, strokeGeometry is a centred outline of twice the weight
    // (verified: extends ±weight around the edge); clip it to inside / outside the shape.
    let clip = '';
    const align = n.strokeAlign ?? 'CENTER';
    if (geo.length && align !== 'CENTER') {
      const shapes = shapePaths(b, n);
      if (shapes.length) {
        const id = b.id(align === 'INSIDE' ? 'si' : 'so');
        if (align === 'INSIDE') {
          b.def(
            `<clipPath id="${id}">${shapes.map((s) => `<path d="${s.d}" clip-rule="${s.rule}"/>`).join('')}</clipPath>`,
          );
          clip = ` clip-path="url(#${id})"`;
        } else {
          b.def(
            `<mask id="${id}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><rect x="-100000" y="-100000" width="200000" height="200000" fill="#fff"/>${shapes.map((s) => `<path d="${s.d}" fill="#000"/>`).join('')}</mask>`,
          );
          clip = ` mask="url(#${id})"`;
        }
      }
    }
    for (const p of strokes) {
      const f = b.paintFill(p, w, h);
      if (!f) continue;
      const op = f.opacity < 1 ? ` fill-opacity="${fmt(f.opacity)}"` : '';
      if (geo.length) {
        const paths = geo.map((d) => `<path d="${d}" fill="${f.fill}"${op}/>`).join('');
        out.push(clip ? `<g${clip}>${paths}</g>` : paths);
      } else {
        const shapes = shapePaths(b, n);
        for (const s of shapes) {
          out.push(
            `<path d="${s.d}" fill="none" stroke="${f.fill}" stroke-width="${fmt(n.strokeWeight ?? 1)}"${f.opacity < 1 ? ` stroke-opacity="${fmt(f.opacity)}"` : ''}/>`,
          );
        }
      }
    }
  }
  return out.join('');
}

function renderNode(b: SvgBuilder, node: SceneNode, transform: Matrix): string {
  const n = node.data;
  if (!node.visible) return '';
  if ((n.opacity ?? 1) <= 0) return '';
  const inner: string[] = [];

  if (node.isMissingComponent) {
    // Placeholder for a component that isn't in the file (no approximation).
    const w = node.width;
    const h = node.height;
    b.warnings.add('missing component drawn as placeholder');
    inner.push(
      `<rect width="${fmt(w)}" height="${fmt(h)}" fill="#f5f5f5" stroke="#b3b3b3" stroke-dasharray="4 3"/>` +
        `<text x="${fmt(w / 2)}" y="${fmt(h / 2)}" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#8c8c8c">${esc(node.name)} (missing component)</text>`,
    );
  } else {
    inner.push(ownPaint(b, n));
    // Boolean operation children are operands, already merged into its geometry.
    if (n.type !== 'BOOLEAN_OPERATION') {
      const kids = renderChildren(b, node);
      if (kids) {
        if (clipsContent(n)) {
          const shapes = shapePaths(b, { ...n, fillGeometry: n.fillGeometry });
          if (shapes.length) {
            const id = b.id('c');
            b.def(`<clipPath id="${id}">${shapes.map((s) => `<path d="${s.d}"/>`).join('')}</clipPath>`);
            inner.push(`<g clip-path="url(#${id})">${kids}</g>`);
          } else inner.push(kids);
        } else inner.push(kids);
      }
    }
  }

  const attrs: string[] = [];
  const t = matrixAttr(transform);
  if (t) attrs.push(t.trim());
  if ((n.opacity ?? 1) < 1) attrs.push(`opacity="${fmt(n.opacity!)}"`);
  const blend = n.blendMode && BLEND[n.blendMode];
  if (blend) attrs.push(`style="mix-blend-mode:${blend}"`);
  const filter = filterFor(b, n);
  if (filter) attrs.push(`filter="url(#${filter})"`);
  const body = inner.join('');
  if (!body) return '';
  return `<g${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</g>`;
}

/** Children in order, applying masks (a `mask: true` layer masks the siblings above it). */
function renderChildren(b: SvgBuilder, node: SceneNode): string {
  const out: string[] = [];
  let maskId: string | undefined;
  let masked: string[] = [];
  const flush = () => {
    if (maskId && masked.length) out.push(`<g mask="url(#${maskId})">${masked.join('')}</g>`);
    masked = [];
  };
  for (const c of node.children) {
    if (c.data.mask && c.visible) {
      flush();
      maskId = b.id('m');
      const shape = shapePaths(b, c.data)
        .map((s) => `<path d="${s.d}" fill="#fff"/>`)
        .join('');
      const alpha = c.data.maskType === 'LUMINANCE' ? '' : ' style="mask-type:alpha"';
      b.def(
        `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"${alpha}><g${matrixAttr(c.relativeTransform)}>${c.data.maskType === 'ALPHA' || c.data.maskType === 'LUMINANCE' ? renderNode(b, c, IDENTITY_M) : shape}</g></mask>`,
      );
      continue;
    }
    const xml = renderNode(b, c, c.relativeTransform);
    if (maskId) masked.push(xml);
    else out.push(xml);
  }
  flush();
  return out.join('');
}

/** Approximate extent of what gets drawn, in page coordinates (like Figma's export bounds). */
export function renderBounds(node: SceneNode): Rect {
  const own = node.absoluteBoundingBox;
  let { x: x0, y: y0 } = own;
  let x1 = own.x + own.width;
  let y1 = own.y + own.height;
  const grow = (r: Rect) => {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  };
  if (!clipsContent(node.data) && node.figType !== 'BOOLEAN_OPERATION') {
    for (const c of node.children) if (c.visible && !c.data.mask) grow(renderBounds(c));
  }
  for (const e of node.data.effects ?? []) {
    if (e.visible === false || e.type !== 'DROP_SHADOW') continue;
    const r = (e.radius ?? 0) + Math.max(0, e.spread ?? 0);
    grow({
      x: own.x + (e.offset?.x ?? 0) - r,
      y: own.y + (e.offset?.y ?? 0) - r,
      width: own.width + 2 * r,
      height: own.height + 2 * r,
    });
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Renders a node (and its subtree) to a standalone SVG document. */
export function renderSvg(doc: FigDocument, node: SceneNode, opts: RenderOptions = {}): SvgResult {
  const b = new SvgBuilder(doc, opts);
  const pad = opts.padding ?? 0;
  let content: string;
  let bounds: Rect;
  if (node.figType === 'CANVAS' || node.figType === 'DOCUMENT') {
    const kids = node.children.filter((c) => c.visible);
    const rects = kids.map(renderBounds);
    const x0 = Math.min(...rects.map((r) => r.x), 0);
    const y0 = Math.min(...rects.map((r) => r.y), 0);
    const x1 = Math.max(...rects.map((r) => r.x + r.width), x0 + 1);
    const y1 = Math.max(...rects.map((r) => r.y + r.height), y0 + 1);
    bounds = rects.length
      ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      : { x: 0, y: 0, width: 1, height: 1 };
    content = renderChildren(b, node);
    if (!opts.background && node.figType === 'CANVAS' && node.data.backgroundColor) {
      opts = { ...opts, background: rgb(node.data.backgroundColor) };
    }
  } else {
    bounds = renderBounds(node);
    content = renderNode(b, node, node.absoluteTransform);
  }
  bounds = {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + 2 * pad,
    height: bounds.height + 2 * pad,
  };
  const bg = opts.background
    ? `<rect x="${fmt(bounds.x)}" y="${fmt(bounds.y)}" width="${fmt(bounds.width)}" height="${fmt(bounds.height)}" fill="${esc(opts.background)}"/>`
    : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(bounds.width)}" height="${fmt(bounds.height)}" ` +
    `viewBox="${fmt(bounds.x)} ${fmt(bounds.y)} ${fmt(bounds.width)} ${fmt(bounds.height)}">` +
    `${b.defsXml()}${bg}${content}</svg>`;
  return { svg, bounds, warnings: [...b.warnings] };
}
