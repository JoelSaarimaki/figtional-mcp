import { FigArchive, encodePathCommands } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { syntheticFig, syntheticMessage } from '../../../test/synthetic.js';
import { renderPng, renderSvg } from './index.js';

const doc = () => FigDocument.fromArchive(FigArchive.fromBytes(syntheticFig()));

describe('renderSvg (synthetic)', () => {
  it('renders a frame with its children at the origin of its bounds', () => {
    const d = doc();
    const { svg, bounds } = renderSvg(d, d.getNodeById('1:2')!);
    expect(bounds).toEqual({ x: 0, y: 0, width: 390, height: 800 });
    expect(svg).toContain('width="390" height="800" viewBox="0 0 390 800"');
    expect(svg).toContain('fill="#ffffff"'); // frame fill
    expect(svg).toContain('<pattern'); // image fill of "Photo"
    expect(svg).toContain('>Hello</tspan>'); // text without stored layout → installed fonts
    expect(svg).toContain('clip-path='); // frames clip their content
  });

  it('skips hidden layers and uses the page background for pages', () => {
    const d = doc();
    const { svg } = renderSvg(d, d.pages[0]!);
    expect(svg).not.toContain('Hidden');
    expect(svg).toContain('fill="#e5e5e5"'); // page background: 0.9 as float32, rounded down
  });

  it('draws stored geometry, and clips INSIDE strokes to the shape', () => {
    const msg = syntheticMessage();
    const square = encodePathCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 0, y: 10 },
      { type: 'Z' },
    ]);
    msg.blobs = [{ bytes: square }];
    const rect = msg.nodeChanges.find((n) => n.name === 'Photo')!;
    rect.fillPaints = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }];
    rect.fillGeometry = [{ windingRule: 'NONZERO', commandsBlob: 0 }];
    rect.strokePaints = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }];
    rect.strokeGeometry = [{ windingRule: 'NONZERO', commandsBlob: 0 }];
    rect.strokeAlign = 'INSIDE';
    rect.strokeWeight = 1;
    // The synthetic schema lacks these fields, so render straight from the in-memory model.
    const d = doc();
    d.message.blobs = msg.blobs;
    Object.assign(d.nodes.get('1:3')!, rect);
    const { svg } = renderSvg(d, d.getNodeById('1:3')!);
    expect(svg).toContain('d="M0 0L10 0L10 10L0 10Z" fill="#ff0000"');
    expect(svg).toMatch(/<clipPath id="si\d+">/);
  });
});

describe('renderPng (synthetic)', () => {
  it('produces a PNG of the node size, scaled and capped', () => {
    const d = doc();
    const node = d.getNodeById('1:2')!;
    const one = PNG.sync.read(renderPng(d, node).png);
    expect([one.width, one.height]).toEqual([390, 800]);
    const two = renderPng(d, node, { scale: 2 });
    expect([two.width, two.height]).toEqual([780, 1600]);
    const capped = renderPng(d, node, { scale: 2, maxSize: 400 });
    expect(capped.height).toBe(400);
  });
});
