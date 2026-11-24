import { FigArchive } from '@figtional/fig-format';
import { describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { FigDocument, computeLayout } from './index.js';

/** Synthetic doc with auto-layout fields set in memory (the synthetic schema doesn't encode them). */
function setup(
  screen: Record<string, unknown>,
  photo: Record<string, unknown> = {},
  title: Record<string, unknown> = {},
) {
  const doc = FigDocument.fromArchive(FigArchive.fromBytes(syntheticFig()));
  Object.assign(doc.nodes.get('1:2')!, screen);
  Object.assign(doc.nodes.get('1:3')!, photo); // 100×50
  Object.assign(doc.nodes.get('1:4')!, title); // 200×30
  const frame = doc.getNodeById('1:2')!;
  const { boxes } = computeLayout(frame);
  const box = (id: string) => boxes.get(doc.getNodeById(id)!)!;
  return { frame: boxes.get(frame)!, photo: box('1:3'), title: box('1:4') };
}

describe('computeLayout (synthetic)', () => {
  it('vertical hug with padding and spacing', () => {
    const r = setup({
      stackMode: 'VERTICAL',
      stackHorizontalPadding: 10,
      stackVerticalPadding: 20,
      stackSpacing: 5,
      stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    });
    expect(r.frame).toMatchObject({ w: 220, h: 20 + 50 + 5 + 30 + 20 });
    expect(r.photo).toMatchObject({ x: 10, y: 20 });
    expect(r.title).toMatchObject({ x: 10, y: 75 });
  });

  it('fixed horizontal frame: fill, centre alignment and space-between', () => {
    const fill = setup(
      {
        stackMode: 'HORIZONTAL',
        stackPrimarySizing: 'FIXED',
        stackSpacing: 10,
        stackCounterAlignItems: 'CENTER',
      },
      { stackChildPrimaryGrow: 1 },
    );
    expect(fill.frame).toMatchObject({ w: 390, h: 800 });
    expect(fill.photo).toMatchObject({ x: 0, w: 390 - 200 - 10, y: (800 - 50) / 2 });
    expect(fill.title).toMatchObject({ x: 390 - 200 });

    const between = setup({
      stackMode: 'HORIZONTAL',
      stackPrimarySizing: 'FIXED',
      stackPrimaryAlignItems: 'SPACE_BETWEEN',
    });
    expect(between.photo.x).toBe(0);
    expect(between.title.x).toBe(390 - 200);
  });

  it('stretch, min/max, borders as padding, and hug beating a stale fill flag', () => {
    const r = setup(
      {
        stackMode: 'VERTICAL',
        stackPrimarySizing: 'FIXED',
        stackCounterAlignItems: 'CENTER',
        bordersTakeSpace: true,
        strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
        strokeWeight: 2,
      },
      { stackChildAlignSelf: 'STRETCH', maxSize: { value: { x: 300, y: null } } },
      { stackChildAlignSelf: 'STRETCH', textAutoResize: 'WIDTH_AND_HEIGHT' },
    );
    expect(r.photo).toMatchObject({ w: 300, x: 2 + (386 - 300) / 2, y: 2 }); // capped stretch is centred
    expect(r.title).toMatchObject({ w: 200, x: 2 + (386 - 200) / 2 }); // auto-width text keeps its width
  });
});
