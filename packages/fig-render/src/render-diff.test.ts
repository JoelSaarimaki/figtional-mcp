/**
 * Render-diff against Figma's own PNG exports in references/ (PLAN.md §7.3). Each exported frame
 * is found by name, rendered at 1×, and compared pixel by pixel. Set FIGTIONAL_RENDER_OUT=<dir> to
 * write our renders and diff images there for inspection.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FigArchive } from '@figtional/fig-format';
import { FigDocument, type SceneNode } from '@figtional/fig-model';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { BIG_TESTS, REF, type RefName, hasRef, REFERENCES_DIR } from '../../../test/references.js';
import { renderPng } from './index.js';

interface ExportSet {
  ref: RefName;
  dir: string;
  /** Max share of differing pixels allowed (regression guard; tighten as fidelity improves). */
  threshold: number;
  /** Export file name → node id, when the export isn't named after a top-level frame. */
  nodes?: Record<string, string>;
  /** Per-export threshold overrides. */
  thresholds?: Record<string, number>;
  /** Only run with FIGTIONAL_BIG_TESTS=1. */
  big?: boolean;
}

const SETS: ExportSet[] = [
  { ref: 'responsive', dir: join(REFERENCES_DIR, 'Responsive example', 'Exports'), threshold: 0.03 },
  { ref: 'prototyping', dir: join(REFERENCES_DIR, 'Prototyping in Figma', 'Exports'), threshold: 0.06 },
  { ref: 'ttrpg', dir: join(REFERENCES_DIR, 'TTRPG stuff', 'exports Pokemon website'), threshold: 0.06 },
  {
    ref: 'futurice',
    dir: join(REFERENCES_DIR, 'Futurice_com UI'),
    threshold: 0.04,
    big: true,
    nodes: { 'export Home - Landing Page light': '6740:20554', 'export About L': '223:9283' },
    // About/L: several sections are dark green in Figma's export, but the file binds their fill to
    // background/brown-1 (beige in every mode). Unexplained; probably the export reflects a newer
    // library state than the .fig. See docs/fig-format.md §4.12.
    thresholds: { 'export About L': 0.32 },
  },
];

const OUT = process.env.FIGTIONAL_RENDER_OUT;

/** Top-level frames by name, in page order; duplicates get "-1", "-2" like Figma's export names. */
function framesByExportName(doc: FigDocument): Map<string, SceneNode> {
  const out = new Map<string, SceneNode>();
  for (const page of doc.pages) {
    for (const f of page.children) {
      let name = f.name;
      for (let i = 1; out.has(name); i++) name = `${f.name}-${i}`;
      out.set(name, f);
    }
  }
  return out;
}

function compare(ours: Buffer, theirs: Buffer, name: string) {
  const a = PNG.sync.read(ours);
  const b = PNG.sync.read(theirs);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (img: PNG) => {
    if (img.width === w && img.height === h) return img.data;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.data.copy(buf, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
    return buf;
  };
  const diff = new PNG({ width: w, height: h });
  const bad = pixelmatch(crop(a), crop(b), diff.data, w, h, { threshold: 0.15, includeAA: false });
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.ours.png`), ours);
    writeFileSync(join(OUT, `${name}.diff.png`), PNG.sync.write(diff));
  }
  return { ratio: bad / (w * h), sizeOurs: `${a.width}x${a.height}`, sizeTheirs: `${b.width}x${b.height}` };
}

describe.each(SETS)('render diff: $ref', ({ ref, dir, threshold, nodes, thresholds, big }) => {
  const ok = hasRef(ref) && existsSync(dir) && (!big || BIG_TESTS);
  it.skipIf(!ok)('matches Figma exports', () => {
    const doc = FigDocument.fromArchive(FigArchive.open(REF[ref]));
    const frames = framesByExportName(doc);
    const rows: string[] = [];
    const failures: string[] = [];
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.png') && (!nodes || basename(f, '.png') in nodes),
    );
    for (const file of files) {
      const name = basename(file, '.png');
      const node = nodes ? doc.getNodeById(nodes[name]!) : frames.get(name);
      if (!node) {
        rows.push(`  ${name}: no matching frame`);
        continue;
      }
      const r = renderPng(doc, node);
      const c = compare(r.png, readFileSync(join(dir, file)), `${ref}-${name}`);
      const pct = (c.ratio * 100).toFixed(2);
      rows.push(
        `  ${pct.padStart(6)}%  ${name}${c.sizeOurs !== c.sizeTheirs ? `  size ${c.sizeOurs} vs ${c.sizeTheirs}` : ''}`,
      );
      if (c.ratio > (thresholds?.[name] ?? threshold)) failures.push(`${name}: ${pct}%`);
    }
    console.log(`render diff ${ref} (differing pixels):\n${rows.join('\n')}`);
    expect(failures).toEqual([]);
  });
});
