/**
 * Helpers for tests that use the local, git-ignored References/ folder.
 * Tests using these must skip cleanly when a file is missing (CI, fresh clones).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const REFERENCES_DIR = fileURLToPath(new URL('../References/', import.meta.url));

export const REF = {
  playground: join(REFERENCES_DIR, 'Playground', 'Playground.fig'),
  ttrpg: join(REFERENCES_DIR, 'TTRPG stuff', 'TTRPG stuff.fig'),
  futurice: join(REFERENCES_DIR, 'Futurice_com UI', 'Futurice.com UI.fig'),
  responsive: join(REFERENCES_DIR, 'Responsive example', 'Responsive example.fig'),
  prototyping: join(REFERENCES_DIR, 'Prototyping in Figma', 'Prototyping in Figma.fig'),
} as const;

export type RefName = keyof typeof REF;

export const hasRef = (name: RefName): boolean => existsSync(REF[name]);

/** Reference files small enough to use in ordinary test runs. */
export const SMALL_REFS: RefName[] = ['playground', 'responsive', 'prototyping', 'ttrpg'];

/** Set FIGTIONAL_BIG_TESTS=1 to include the ~270 MB Futurice.com UI file. */
export const BIG_TESTS = process.env.FIGTIONAL_BIG_TESTS === '1';
