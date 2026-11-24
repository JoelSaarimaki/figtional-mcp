import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { Workspace } from '@figtional/mcp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { main, parseMcpArgs, unsafeDefaultFolder } from './main.js';

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
    expect(workspace.sources).toEqual([{ dir, recursive: true, limit: { maxDirs: 2000, maxDepth: 8 } }]);
    expect(new Workspace(workspace).listFiles().map((f) => f.key)).toEqual(['sub--nested', 'top']);
  });

  it('the default scan is bounded and warns when it stops early', () => {
    let deep = dir;
    for (let i = 0; i < 10; i++) deep = join(deep, `level${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'too-deep.fig'), syntheticFig());
    const { workspace } = parseMcpArgs([], dir, { defaultToCwd: true });
    const ws = new Workspace(workspace);
    expect(ws.listFiles().map((f) => f.key)).not.toContain(expect.stringContaining('too-deep'));
    expect(ws.warnings().join('\n')).toMatch(/stopped scanning/);
    // An explicit folder is taken at its word.
    const explicit = new Workspace(parseMcpArgs([dir, '--recursive'], dir).workspace);
    expect(explicit.listFiles().some((f) => f.key.endsWith('too-deep'))).toBe(true);
  });

  it('refuses to crawl roots, the home folder and system folders by default', () => {
    const home = join(dir, 'Users', 'me');
    const env = { WINDIR: join(dir, 'Windows'), ProgramFiles: join(dir, 'Program Files') };
    expect(unsafeDefaultFolder(parse(dir).root, env, home)).toMatch(/root/);
    expect(unsafeDefaultFolder(home, env, home)).toMatch(/home folder/);
    expect(unsafeDefaultFolder(join(dir, 'Users'), env, home)).toMatch(/all user folders/);
    expect(unsafeDefaultFolder(join(dir, 'Windows', 'System32'), env, home)).toMatch(/system folder/);
    expect(unsafeDefaultFolder(join(dir, 'Program Files'), env, home)).toMatch(/system folder/);
    expect(unsafeDefaultFolder(join(home, 'Documents', 'designs'), env, home)).toBeUndefined();
    expect(() => parseMcpArgs([], parse(dir).root, { defaultToCwd: true })).toThrow(/not scanning/);
    // Explicit sources are allowed anywhere.
    expect(() => parseMcpArgs([dir], parse(dir).root, { defaultToCwd: true })).not.toThrow();
  });

  it('mcp never guesses its scope', () => {
    expect(() => parseMcpArgs([], dir)).toThrow(/no sources given/);
  });

  it('explicit sources win over the default', () => {
    const { workspace } = parseMcpArgs([join(dir, 'top.fig')], dir, { defaultToCwd: true });
    expect(workspace.sources).toEqual([{ file: join(dir, 'top.fig') }]);
  });
});

describe('CLI help', () => {
  const capture = async (argv: string[]) => {
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => ((out += s), true)) as typeof process.stderr.write;
    try {
      const code = await main(argv);
      return { code, out };
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
  };

  it('prints an overview and per-command help in every form', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const r = await capture(argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Usage: figtional <command>');
    }
    for (const cmd of ['mcp', 'serve', 'dump', 'inspect', 'validate']) {
      for (const argv of [
        [cmd, '--help'],
        [cmd, '-h'],
        ['help', cmd],
      ]) {
        const r = await capture(argv);
        expect(r.code, argv.join(' ')).toBe(0);
        expect(r.out).toContain(`Usage: figtional ${cmd}`);
      }
    }
    expect((await capture(['help', 'nope'])).code).toBe(2);
    expect((await capture(['nope'])).code).toBe(2);
  });
});
