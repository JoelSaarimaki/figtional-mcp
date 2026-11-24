import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@figtional/mcp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { parseMcpArgs } from './main.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'figtional-cli-'));
  writeFileSync(join(dir, 'top.fig'), syntheticFig());
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'nested.fig'), syntheticFig());
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'ignored.fig'), syntheticFig());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI sources', () => {
  it('serve without arguments uses the current folder recursively, skipping node_modules', () => {
    const { workspace } = parseMcpArgs([], dir, { defaultToCwd: true });
    expect(workspace.sources).toEqual([{ dir, recursive: true }]);
    expect(new Workspace(workspace).listFiles().map((f) => f.key)).toEqual(['sub--nested', 'top']);
  });

  it('mcp never guesses its scope', () => {
    expect(() => parseMcpArgs([], dir)).toThrow(/no sources given/);
  });

  it('explicit sources win over the default', () => {
    const { workspace } = parseMcpArgs([join(dir, 'top.fig')], dir, { defaultToCwd: true });
    expect(workspace.sources).toEqual([{ file: join(dir, 'top.fig') }]);
  });
});
