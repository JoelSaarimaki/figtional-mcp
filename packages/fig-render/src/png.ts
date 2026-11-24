import { Resvg } from '@resvg/resvg-js';
import type { FigDocument, SceneNode } from '@figtional/fig-model';
import { type RenderOptions, renderSvg } from './svg.js';

export interface PngOptions extends RenderOptions {
  /** Pixel scale (default 1). */
  scale?: number;
  /** Longest side limit in px; the scale is reduced to fit (Figma caps exports at 4096). */
  maxSize?: number;
}

export interface PngResult {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
  warnings: string[];
}

/** Fallback fonts when a design's font isn't installed (PLAN.md §2 "Fonts"). */
const DEFAULT_FONTS = {
  sansSerifFamily:
    process.platform === 'darwin' ? 'Helvetica' : process.platform === 'win32' ? 'Arial' : 'DejaVu Sans',
  serifFamily:
    process.platform === 'win32'
      ? 'Times New Roman'
      : process.platform === 'darwin'
        ? 'Times'
        : 'DejaVu Serif',
  monospaceFamily:
    process.platform === 'win32' ? 'Consolas' : process.platform === 'darwin' ? 'Menlo' : 'DejaVu Sans Mono',
};

export function svgToPng(svg: string, width: number, height: number, scale = 1, maxSize = 4096) {
  let s = scale;
  const longest = Math.max(width, height) * s;
  if (longest > maxSize) s = maxSize / Math.max(width, height);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: s },
    font: { loadSystemFonts: true, defaultFontFamily: DEFAULT_FONTS.sansSerifFamily, ...DEFAULT_FONTS },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
  });
  const img = resvg.render();
  return { png: img.asPng(), width: img.width, height: img.height, scale: s };
}

export function renderPng(doc: FigDocument, node: SceneNode, opts: PngOptions = {}): PngResult {
  const { svg, bounds, warnings } = renderSvg(doc, node, opts);
  const r = svgToPng(svg, bounds.width, bounds.height, opts.scale ?? 1, opts.maxSize ?? 4096);
  return { ...r, warnings };
}
