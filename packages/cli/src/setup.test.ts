import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkFolder,
  claudeCodeCommand,
  detectClients,
  findOnPath,
  mergeConfig,
  normalizeFolderInput,
  serverEntry,
  viewerCommand,
  writeClientConfig,
} from './setup.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'figtional setup ä-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = serverEntry(
  ['/designs/A B'],
  { recursive: true, writable: false },
  '/usr/bin/node',
  '/opt/figtional/lib/figtional.mjs',
);

describe('serverEntry', () => {
  it('runs this node with this script, the flags and the folders', () => {
    expect(entry).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/figtional/lib/figtional.mjs', 'mcp', '--recursive', '/designs/A B'],
    });
    const w = serverEntry(['x'], { recursive: false, writable: true }, 'n', 's');
    expect(w.args).toEqual(['s', 'mcp', '--writable', 'x']);
  });
});

describe('mergeConfig', () => {
  it('adds the server and keeps everything else', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    const after = JSON.parse(mergeConfig(before, 'mcpServers', entry));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'x' });
    expect(after.mcpServers.figtional).toEqual(entry);
  });
  it('replaces an older figtional entry', () => {
    const before = JSON.stringify({ mcpServers: { figtional: { command: 'old', args: [] } } });
    expect(JSON.parse(mergeConfig(before, 'mcpServers', entry)).mcpServers.figtional).toEqual(entry);
  });
  it('writes VS Code entries under "servers" with type stdio', () => {
    expect(JSON.parse(mergeConfig('', 'servers', entry)).servers.figtional).toEqual({
      type: 'stdio',
      ...entry,
    });
  });
  it('refuses files that are not plain JSON objects', () => {
    expect(() => mergeConfig('{ // comment\n}', 'servers', entry)).toThrow();
    expect(() => mergeConfig('[]', 'servers', entry)).toThrow(/JSON object/);
    expect(() => mergeConfig('{"servers": 3}', 'servers', entry)).toThrow(/not a JSON object/);
  });
});

describe('writeClientConfig', () => {
  it('creates the file, or updates it with a backup', () => {
    const d = tmp();
    const path = join(d, 'sub', 'mcp.json');
    const client = {
      id: 'cursor' as const,
      name: 'Cursor',
      detected: true,
      configPath: path,
      serversKey: 'mcpServers' as const,
    };
    expect(writeClientConfig(client, entry)).toContain(path);
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.figtional).toEqual(entry);
    writeFileSync(path, JSON.stringify({ mcpServers: { keep: { command: 'k' } } }));
    expect(writeClientConfig(client, entry)).toContain('.bak');
    expect(JSON.parse(readFileSync(path + '.bak', 'utf8')).mcpServers.keep).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers)).toEqual(['keep', 'figtional']);
  });
  it('leaves a file it cannot parse alone and explains what to add', () => {
    const d = tmp();
    const path = join(d, 'mcp.json');
    writeFileSync(path, '{ // a comment\n "servers": {} }');
    const client = {
      id: 'vscode' as const,
      name: 'VS Code',
      detected: true,
      configPath: path,
      serversKey: 'servers' as const,
    };
    expect(() => writeClientConfig(client, entry)).toThrow(/by hand/);
    expect(readFileSync(path, 'utf8')).toContain('a comment');
  });
});

describe('detectClients', () => {
  it('finds apps by their settings folders and claude on PATH', () => {
    const home = tmp();
    const appData = join(home, 'appdata');
    mkdirSync(join(appData, 'Claude'), { recursive: true });
    mkdirSync(join(home, '.cursor'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude.cmd'), '');
    const clients = detectClients({ env: { APPDATA: appData, PATH: bin }, home, platform: 'win32' });
    const byId = Object.fromEntries(clients.map((c) => [c.id, c]));
    expect(byId['claude-code']!.detected).toBe(true);
    expect(byId['claude-code']!.executable).toBe(join(bin, 'claude.cmd'));
    expect(byId['claude-desktop']!.configPath).toBe(join(appData, 'Claude', 'claude_desktop_config.json'));
    expect(byId['claude-desktop']!.detected).toBe(true);
    expect(byId.cursor!.detected).toBe(true);
    expect(byId.vscode!.detected).toBe(false);
    expect(byId.vscode!.configPath).toBe(join(appData, 'Code', 'User', 'mcp.json'));
  });
  it('finds the Microsoft Store install of Claude Desktop', () => {
    const home = tmp();
    const local = join(home, 'local');
    const store = join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    mkdirSync(store, { recursive: true });
    const clients = detectClients({
      env: { APPDATA: join(home, 'roaming'), LOCALAPPDATA: local },
      home,
      platform: 'win32',
    });
    expect(clients.find((c) => c.id === 'claude-desktop')!.configPath).toBe(
      join(store, 'claude_desktop_config.json'),
    );
  });
  it('uses ~/Library/Application Support on macOS', () => {
    const home = tmp();
    const clients = detectClients({ env: {}, home, platform: 'darwin' });
    expect(clients.find((c) => c.id === 'vscode')!.configPath).toBe(
      join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    );
    expect(findOnPath('claude', { env: {}, platform: 'darwin' })).toBeUndefined();
  });
});

describe('folder input', () => {
  it('strips quotes from dragged folders and expands ~', () => {
    const home = tmp();
    expect(normalizeFolderInput(`"${home}"`, '/')).toBe(home);
    expect(normalizeFolderInput(`'${home}' `, '/')).toBe(home);
    expect(normalizeFolderInput('~', '/', home)).toBe(home);
    expect(normalizeFolderInput('designs', home)).toBe(join(home, 'designs'));
  });
  it('rejects missing folders, files and drive roots', () => {
    const d = tmp();
    expect(checkFolder(d, true)).toBeUndefined();
    expect(checkFolder(join(d, 'nope'), true)).toMatch(/does not exist/);
    writeFileSync(join(d, 'f.fig'), '');
    expect(checkFolder(join(d, 'f.fig'), true)).toMatch(/not a folder/);
    expect(checkFolder(process.platform === 'win32' ? 'C:\\' : '/', true)).toMatch(/root/);
  });
});

describe('claudeCodeCommand', () => {
  it('quotes paths with spaces', () => {
    expect(claudeCodeCommand(entry)).toBe(
      'claude mcp add --scope user figtional -- /usr/bin/node /opt/figtional/lib/figtional.mjs mcp --recursive "/designs/A B"',
    );
  });
});

describe('viewerCommand', () => {
  it('uses the launcher next to a downloaded copy', () => {
    const script = join('/apps', 'figtional-0.1.2', 'lib', 'figtional.mjs');
    const launcher = join('/apps', 'figtional-0.1.2', 'figtional.cmd');
    expect(viewerCommand(['/d/A B'], '/node', script, 'win32', (p) => p === launcher)).toBe(
      `"${launcher}" serve --open "/d/A B"`,
    );
    const sh = join('/apps', 'figtional-0.1.2', 'figtional');
    expect(viewerCommand(['/d'], '/node', script, 'darwin', (p) => p === sh)).toBe(
      `"${sh}" serve --open "/d"`,
    );
  });
  it('uses node and the script in a clone of the repository', () => {
    expect(viewerCommand(['/d'], '/node', '/repo/packages/cli/dist/bin.js', 'linux', () => true)).toBe(
      '"/node" "/repo/packages/cli/dist/bin.js" serve --open "/d"',
    );
  });
});
