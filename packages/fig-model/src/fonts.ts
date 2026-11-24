/**
 * System fonts and text measurement (PLAN.md §2 "Fonts"): only fonts installed on the machine are
 * used, discovered lazily from the standard font folders of each OS. A missing font falls back to a
 * basic sans-serif / serif / monospace font of the closest weight. The node keeps its original
 * fontName; the fallback only affects measurement and drawing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const require = createRequire(import.meta.url);

export interface FontFace {
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  path: string;
  /** postscript name, to pick a face inside a .ttc collection */
  postscript?: string;
}

/** Font folders per OS. Extra folders can be added with FIGTIONAL_FONT_DIRS (path-delimited). */
export function fontDirectories(): string[] {
  const dirs: string[] = [];
  const home = homedir();
  if (process.platform === 'win32') {
    dirs.push(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts'));
  } else {
    dirs.push(
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      join(home, '.local', 'share', 'fonts'),
      join(home, '.fonts'),
    );
  }
  const extra = process.env.FIGTIONAL_FONT_DIRS;
  if (extra) dirs.push(...extra.split(process.platform === 'win32' ? ';' : ':').filter(Boolean));
  return dirs.filter((d) => existsSync(d));
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];
export function styleWeight(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w;
  return 400;
}
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

let index: FontFace[] | undefined;

/** All installed font faces (scanned once per process). */
export function systemFonts(): FontFace[] {
  if (index) return index;
  const fontkit = require('fontkit');
  const faces: FontFace[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const ext = extname(name).toLowerCase();
      if (!ext) {
        if (depth < 4) {
          try {
            if (statSync(full).isDirectory()) walk(full, depth + 1);
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      if (!['.ttf', '.otf', '.ttc', '.otc'].includes(ext)) continue;
      try {
        const f = fontkit.openSync(full);
        for (const face of f.fonts ?? [f]) {
          const family: string = face.familyName ?? '';
          const style: string = face.subfamilyName ?? 'Regular';
          const key = `${norm(family)}|${norm(style)}`;
          if (!family || seen.has(key)) continue;
          seen.add(key);
          faces.push({
            family,
            style,
            weight: face['OS/2']?.usWeightClass ?? styleWeight(style),
            italic: /italic|oblique/i.test(style),
            path: full,
            postscript: face.postscriptName,
          });
        }
      } catch {
        /* unreadable font file */
      }
    }
  };
  for (const d of fontDirectories()) walk(d, 0);
  index = faces;
  return faces;
}

const FALLBACKS = {
  sans: [
    'Inter',
    'Arial',
    'Helvetica',
    'Helvetica Neue',
    'Segoe UI',
    'DejaVu Sans',
    'Liberation Sans',
    'Noto Sans',
  ],
  serif: ['Times New Roman', 'Times', 'Georgia', 'DejaVu Serif', 'Liberation Serif', 'Noto Serif'],
  mono: ['Consolas', 'Menlo', 'Courier New', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono'],
};

function genericOf(family: string): keyof typeof FALLBACKS {
  if (/mono|code|courier|consol/i.test(family)) return 'mono';
  if (/serif|times|georgia|garamond|roman|goudy|baskerville|castoro/i.test(family) && !/sans/i.test(family))
    return 'serif';
  return 'sans';
}

export interface ResolvedFont {
  face: FontFace;
  /** True when the requested family isn't installed and a fallback is used. */
  substituted: boolean;
}

/** Best installed face for a Figma font name. */
export function resolveFont(family: string, style: string): ResolvedFont | undefined {
  const faces = systemFonts();
  const wantWeight = styleWeight(style);
  const wantItalic = /italic|oblique/i.test(style);
  const pick = (cands: FontFace[]) => {
    const exact = cands.find((f) => norm(f.style) === norm(style));
    if (exact) return exact;
    return [...cands].sort(
      (a, b) =>
        Number(a.italic !== wantItalic) - Number(b.italic !== wantItalic) ||
        Math.abs(a.weight - wantWeight) - Math.abs(b.weight - wantWeight),
    )[0];
  };
  const fam = faces.filter((f) => norm(f.family) === norm(family));
  if (fam.length) return { face: pick(fam)!, substituted: false };
  for (const fb of FALLBACKS[genericOf(family)]) {
    const c = faces.filter((f) => norm(f.family) === norm(fb));
    if (c.length) return { face: pick(c)!, substituted: true };
  }
  return faces.length ? { face: pick(faces)!, substituted: true } : undefined;
}

const loaded = new Map<string, any>();
function openFace(face: FontFace): any {
  const key = `${face.path}|${face.postscript ?? ''}`;
  let f = loaded.get(key);
  if (!f) {
    const fontkit = require('fontkit');
    const file = fontkit.openSync(face.path);
    f = file.fonts
      ? (file.fonts.find((x: any) => x.postscriptName === face.postscript) ?? file.fonts[0])
      : file;
    loaded.set(key, f);
  }
  return f;
}

export interface TextStyleInput {
  family: string;
  style: string;
  size: number;
  /** .fig lineHeight: { units: 'RAW' | 'PERCENT' | 'PIXELS', value } (PERCENT 100 = auto). */
  lineHeight?: { units: string; value: number };
  /** .fig letterSpacing: { units: 'PERCENT' | 'PIXELS', value } */
  letterSpacing?: { units: string; value: number };
}

export interface TextMeasure {
  width: number;
  height: number;
  lines: { text: string; width: number }[];
  lineHeight: number;
  /** Distance from a line's top to its baseline. */
  ascent: number;
  substituted: boolean;
  fontPath?: string;
}

/**
 * Lays out text the way Figma sizes text boxes: lines break at \n and, with `maxWidth`, at word
 * boundaries; line height follows the .fig semantics (RAW = multiple of the font size,
 * PERCENT = percent of the font's natural line height, PIXELS); each line's height is rounded.
 */
export function measureText(text: string, s: TextStyleInput, maxWidth?: number): TextMeasure {
  const resolved = resolveFont(s.family, s.style);
  const size = s.size;
  let natural = 1.2;
  let ascentRatio = 0.9;
  let advance = (str: string) => str.length * size * 0.55;
  if (resolved) {
    const font = openFace(resolved.face);
    const upm = font.unitsPerEm || 1000;
    const hhea = font.hhea ?? {};
    const asc = hhea.ascent ?? font.ascent ?? upm * 0.9;
    const desc = Math.abs(hhea.descent ?? font.descent ?? upm * 0.2);
    const gap = hhea.lineGap ?? font.lineGap ?? 0;
    natural = (asc + desc + gap) / upm;
    ascentRatio = asc / upm;
    const spacing =
      s.letterSpacing?.units === 'PIXELS'
        ? s.letterSpacing.value
        : ((s.letterSpacing?.value ?? 0) / 100) * size;
    advance = (str: string) => {
      if (!str) return 0;
      const run = font.layout(str);
      return (run.advanceWidth / upm) * size + spacing * [...str].length;
    };
  }
  const lh = s.lineHeight;
  const lineHeight =
    lh?.units === 'PIXELS'
      ? lh.value
      : lh?.units === 'RAW'
        ? lh.value * size
        : lh?.units === 'PERCENT'
          ? (lh.value / 100) * natural * size
          : natural * size;

  const lines: { text: string; width: number }[] = [];
  for (const para of text.split('\n')) {
    if (maxWidth === undefined) {
      lines.push({ text: para, width: advance(para) });
      continue;
    }
    const words = para.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      const next = cur + w;
      if (cur && advance(next.trimEnd()) > maxWidth + 0.01 && w.trim()) {
        lines.push({ text: cur.trimEnd(), width: advance(cur.trimEnd()) });
        cur = w.trimStart();
      } else cur = next;
    }
    lines.push({ text: cur, width: advance(cur.trimEnd()) });
  }
  const width = Math.max(0, ...lines.map((l) => l.width));
  return {
    width,
    height: Math.round(lineHeight) * Math.max(1, lines.length),
    lines,
    lineHeight,
    ascent: (lineHeight - natural * size) / 2 + ascentRatio * size,
    substituted: resolved?.substituted ?? true,
    ...(resolved ? { fontPath: resolved.face.path } : {}),
  };
}

/** Plugin-API style font list (figma.listAvailableFontsAsync). */
export function availableFonts(): { fontName: { family: string; style: string } }[] {
  return systemFonts().map((f) => ({ fontName: { family: f.family, style: f.style } }));
}
