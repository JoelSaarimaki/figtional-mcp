#!/usr/bin/env node
/**
 * Writes test variants of a .fig file for the manual Figma import check (PLAN.md M4 gate).
 * Import each output into Figma (drag into the file browser) and log the result in
 * docs/compat-log.md.
 *
 *   npm run build
 *   node scripts/make-compat-files.mjs "references/Playground/Playground.fig" compat-out
 */
import { mkdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { FigArchive, encodeCanvas, saveFigArchive } from '@figtional/fig-format';

const [input, outDir = 'compat-out'] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/make-compat-files.mjs <file.fig> [outDir]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const stem = basename(input, extname(input)).replace(/\s+/g, '-');

function variant(name, description, mutate) {
  const fig = FigArchive.open(resolve(input));
  const canvas = fig.decodeCanvas();
  const notes = mutate ? mutate(canvas.message) : [];
  const meta = { ...fig.meta(), file_name: `${fig.meta().file_name ?? stem} (figtional ${name})` };
  const target = join(outDir, `${stem}.${name}.fig`);
  saveFigArchive(fig, target, { canvas: encodeCanvas(canvas), meta, backup: false });
  console.log(`${target}\n  ${description}${notes.length ? '\n  ' + notes.join('\n  ') : ''}`);
}

const firstText = (msg) => msg.nodeChanges.find((n) => n.type === 'TEXT' && n.textData?.characters);
const firstSolidShape = (msg) =>
  msg.nodeChanges.find(
    (n) => n.type !== 'TEXT' && n.type !== 'CANVAS' && n.fillPaints?.some((p) => p.type === 'SOLID'),
  );
const id = (n) => `${n.guid.sessionID}:${n.guid.localID}`;

variant('roundtrip', 'No changes: decode and re-encode only (tests the container, ZIP and encoder).');

variant('color', 'One solid fill changed to pure red (no derived data involved).', (msg) => {
  const n = firstSolidShape(msg);
  if (!n) return ['(no solid fill found; file unchanged)'];
  const p = n.fillPaints.find((p) => p.type === 'SOLID');
  p.color = { r: 1, g: 0, b: 0, a: 1 };
  if (p.authoredColor) p.authoredColor = { ...p.authoredColor, c0: 1, c1: 0, c2: 0, c3: 1 };
  return [`changed fill of ${n.type} ${id(n)} "${n.name}"`];
});

const NEW_TEXT = 'FIGTIONAL TEST';

variant(
  'text-stripped',
  'Text changed; derivedTextData removed (does Figma recompute the layout?).',
  (msg) => {
    const n = firstText(msg);
    const before = n.textData.characters;
    n.textData.characters = NEW_TEXT;
    delete n.derivedTextData;
    return [`TEXT ${id(n)}: "${before}" -> "${NEW_TEXT}"`];
  },
);

variant(
  'text-stale',
  'Text changed; stale derivedTextData kept (does Figma trust or recompute it?).',
  (msg) => {
    const n = firstText(msg);
    const before = n.textData.characters;
    n.textData.characters = NEW_TEXT;
    return [`TEXT ${id(n)}: "${before}" -> "${NEW_TEXT}"`];
  },
);
