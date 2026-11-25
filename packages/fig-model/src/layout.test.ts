/**
 * Auto layout is verified against Figma itself: re-laying out every top-level frame of the
 * reference files must reproduce the sizes and positions Figma stored.
 */
import { FigArchive } from '@figtional/fig-format';
import { describe, expect, it } from 'vitest';
import { BIG_TESTS, REF, type RefName, hasRef } from '../../../test/references.js';
import { FigDocument, type SceneNode, computeLayout, stackProps } from './index.js';

const TOL = 0.51;

interface Mismatch {
  id: string;
  name: string;
  parent: string;
  what: string;
}

function check(doc: FigDocument) {
  let nodes = 0;
  let wrong = 0;
  // Instance sublayers: Figma stores derived layout for only some of them, so their stored geometry
  // is not always the final layout. Counted separately, as a softer signal.
  let subNodes = 0;
  let subWrong = 0;
  const samples: Mismatch[] = [];
  for (const page of doc.pages) {
    for (const top of page.children) {
      let hasStack = false;
      top.walk((n) => {
        if (stackProps(n.data)) hasStack = true;
        return !hasStack;
      });
      if (!hasStack) continue;
      const { boxes } = computeLayout(top);
      for (const [n, b] of boxes) {
        if (n === top || !n.parent || !stackProps(n.parent.data) || n.data.stackPositioning === 'ABSOLUTE') {
          // Only check children of auto-layout frames (others keep their stored geometry by design).
          if (!(n === top && stackProps(n.data))) continue;
        }
        if (isRotated(n)) continue;
        const sub = n.isInstanceSublayer;
        if (sub) subNodes++;
        else nodes++;
        const t = n.relativeTransform;
        const diffs: string[] = [];
        if (Math.abs(b.w - n.width) > TOL) diffs.push(`w ${fmt(b.w)}≠${fmt(n.width)}`);
        if (Math.abs(b.h - n.height) > TOL) diffs.push(`h ${fmt(b.h)}≠${fmt(n.height)}`);
        if (n !== top) {
          if (Math.abs(b.x - t.m02) > TOL) diffs.push(`x ${fmt(b.x)}≠${fmt(t.m02)}`);
          if (Math.abs(b.y - t.m12) > TOL) diffs.push(`y ${fmt(b.y)}≠${fmt(t.m12)}`);
        }
        if (diffs.length) {
          if (sub) {
            subWrong++;
            continue;
          }
          wrong++;
          if (samples.length < 12)
            samples.push({ id: n.id, name: n.name, parent: describeParent(n), what: diffs.join(', ') });
        }
      }
    }
  }
  return { nodes, wrong, samples, subNodes, subWrong };
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);
const isRotated = (n: SceneNode) =>
  Math.abs(n.relativeTransform.m01) > 1e-6 || Math.abs(n.relativeTransform.m10) > 1e-6;

function describeParent(n: SceneNode): string {
  const p = n.parent!;
  const s = stackProps(p.data);
  const d = n.data;
  return `${p.name} [${s ? `${s.horizontal ? 'H' : 'V'} ${s.justify}/${s.align} hug ${s.primaryHug}/${s.counterHug}${s.wrap ? ' wrap' : ''}` : 'no AL'}] child grow=${d.stackChildPrimaryGrow ?? 0} self=${d.stackChildAlignSelf ?? '-'} text=${d.textAutoResize ?? '-'}`;
}

const CASES: { ref: RefName; maxWrong: number; big?: boolean }[] = [
  // 0.1.0: responsive 100%, ttrpg 99.4%, futurice 98.3% of auto-layout children reproduced.
  { ref: 'responsive', maxWrong: 0 },
  { ref: 'prototyping', maxWrong: 0 },
  { ref: 'ttrpg', maxWrong: 0.007 },
  { ref: 'futurice', maxWrong: 0.018, big: true },
];

describe.each(CASES)('auto layout matches Figma: $ref', ({ ref, maxWrong, big }) => {
  it.skipIf(!hasRef(ref) || (big && !BIG_TESTS))('reproduces stored sizes and positions', () => {
    const doc = FigDocument.fromArchive(FigArchive.open(REF[ref]));
    const r = check(doc);
    const rate = r.nodes ? r.wrong / r.nodes : 0;
    console.log(
      `auto layout ${ref}: ${r.nodes - r.wrong}/${r.nodes} match (${(rate * 100).toFixed(2)}% differ); ` +
        `instance sublayers ${r.subNodes - r.subWrong}/${r.subNodes} match` +
        (r.samples.length
          ? '\n' + r.samples.map((s) => `  ${s.id} "${s.name}": ${s.what}\n      in ${s.parent}`).join('\n')
          : ''),
    );
    expect(rate).toBeLessThanOrEqual(maxWrong);
  });
});
