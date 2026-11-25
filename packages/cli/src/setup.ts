/**
 * `figtional setup`: connects Figtional to the AI apps on this computer without hand-editing JSON.
 * It asks which folders the agent may read (the only access Figtional ever gets), then adds a
 * "figtional" MCP server to the apps it finds: Claude Code (through its own `claude mcp add`
 * command), Claude Desktop, Cursor and VS Code (by merging their JSON config, with a backup).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { unsafeDefaultFolder } from './folders.js';

export const SERVER_KEY = 'figtional';

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode';
export const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'claude-desktop', 'cursor', 'vscode'];

export interface Client {
  id: ClientId;
  name: string;
  /** Found on this computer. */
  detected: boolean;
  /** JSON config file (all but Claude Code). */
  configPath?: string;
  /** Key in the JSON file that holds the servers. */
  serversKey?: 'mcpServers' | 'servers';
  /** Claude Code's executable. */
  executable?: string;
}

export interface ServerEntry {
  command: string;
  args: string[];
}

interface Env {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

const defaultEnv = (): Env => ({ env: process.env, home: homedir(), platform: process.platform });

/** Finds an executable on PATH (with Windows' extensions). */
export function findOnPath(
  name: string,
  { env, platform }: Pick<Env, 'env' | 'platform'>,
): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** Folder that holds per-user app settings (AppData\Roaming, Application Support, ~/.config). */
function appDataDir({ env, home, platform }: Env): string {
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/** Claude Desktop's settings folder, including the Microsoft Store install's virtualised one. */
function claudeDesktopDir(e: Env): string | undefined {
  const regular = join(appDataDir(e), 'Claude');
  if (existsSync(regular)) return regular;
  if (e.platform === 'win32' && e.env.LOCALAPPDATA) {
    const packages = join(e.env.LOCALAPPDATA, 'Packages');
    try {
      for (const name of readdirSync(packages)) {
        if (!/^Claude_/i.test(name)) continue;
        const dir = join(packages, name, 'LocalCache', 'Roaming', 'Claude');
        if (existsSync(dir)) return dir;
      }
    } catch {
      /* no Store apps */
    }
  }
  return undefined;
}

/** The AI apps Figtional can be added to, and whether each one is installed. */
export function detectClients(e: Env = defaultEnv()): Client[] {
  const claude = findOnPath('claude', e);
  const desktopDir = claudeDesktopDir(e);
  const cursorDir = join(e.home, '.cursor');
  const codeDir = join(appDataDir(e), 'Code', 'User');
  return [
    { id: 'claude-code', name: 'Claude Code', detected: !!claude, executable: claude },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      detected: !!desktopDir,
      configPath: join(desktopDir ?? join(appDataDir(e), 'Claude'), 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      detected: existsSync(cursorDir),
      configPath: join(cursorDir, 'mcp.json'),
      serversKey: 'mcpServers',
    },
    {
      id: 'vscode',
      name: 'VS Code',
      detected: existsSync(codeDir),
      configPath: join(codeDir, 'mcp.json'),
      serversKey: 'servers',
    },
  ];
}

/**
 * The command an app runs to start Figtional: this Node.js binary (an absolute path, because
 * desktop apps often don't see the terminal's PATH) and this copy of Figtional.
 */
export function serverEntry(
  folders: string[],
  opts: { recursive: boolean; writable: boolean },
  nodePath = process.execPath,
  scriptPath = currentScript(),
): ServerEntry {
  return {
    command: nodePath,
    args: [
      scriptPath,
      'mcp',
      ...(opts.recursive ? ['--recursive'] : []),
      ...(opts.writable ? ['--writable'] : []),
      ...folders,
    ],
  };
}

function currentScript(): string {
  const p = process.argv[1];
  if (!p) throw new Error('cannot tell where Figtional is installed');
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Adds (or replaces) the figtional server in a JSON config text and returns the new text.
 * Throws if the existing text is not plain JSON (e.g. has comments), so it is never mangled.
 */
export function mergeConfig(
  text: string | undefined,
  serversKey: 'mcpServers' | 'servers',
  entry: ServerEntry,
): string {
  const config: Record<string, unknown> = text?.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error('the file does not contain a JSON object');
  const servers = (config[serversKey] ?? {}) as Record<string, unknown>;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers))
    throw new Error(`"${serversKey}" is not a JSON object`);
  servers[SERVER_KEY] = serversKey === 'servers' ? { type: 'stdio', ...entry } : { ...entry };
  config[serversKey] = servers;
  return JSON.stringify(config, null, 2) + '\n';
}

/** The JSON a user can paste by hand when a config can't be written. */
export function configSnippet(serversKey: 'mcpServers' | 'servers', entry: ServerEntry): string {
  return mergeConfig(undefined, serversKey, entry);
}

/** Writes a JSON client config (keeping a .bak of the old file). Returns a message. */
export function writeClientConfig(client: Client, entry: ServerEntry): string {
  const path = client.configPath!;
  const old = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  let next: string;
  try {
    next = mergeConfig(old, client.serversKey!, entry);
  } catch (e) {
    throw new Error(
      `could not update ${path} (${(e as Error).message}). Add this to it by hand:\n${configSnippet(client.serversKey!, entry)}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  if (old !== undefined) copyFileSync(path, path + '.bak');
  writeFileSync(path, next);
  return `updated ${path}${old !== undefined ? ` (backup: ${path}.bak)` : ''}`;
}

/** Quotes one argument for cmd.exe (paths here never contain double quotes). */
const cmdQuote = (a: string) => (/[\s&()^|<>"%!,;=]/.test(a) ? `"${a}"` : a);

/** Runs Claude Code's CLI. On Windows a .cmd shim has to go through cmd.exe. */
function runClaude(exe: string, args: string[]) {
  // Run from inside a Claude Code session, the debugger settings it passes down would make the
  // child `claude` try to open the same inspector port.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^BUN_INSPECT/i.test(k)));
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...args].map(cmdQuote).join(' ');
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      encoding: 'utf8',
      env,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(exe, args, { encoding: 'utf8', env });
}

/** The `claude mcp add` command line, for people who want to run it themselves. */
export function claudeCodeCommand(entry: ServerEntry): string {
  const q = (a: string) => (/[\s"'$&()|;<>^%!]/.test(a) ? `"${a}"` : a);
  return ['claude', 'mcp', 'add', '--scope', 'user', SERVER_KEY, '--', entry.command, ...entry.args]
    .map(q)
    .join(' ');
}

/** Adds the server to Claude Code for every project of this user (replacing an older entry). */
export function addToClaudeCode(client: Client, entry: ServerEntry): string {
  const exe = client.executable!;
  runClaude(exe, ['mcp', 'remove', '--scope', 'user', SERVER_KEY]); // fine if it wasn't there
  const r = runClaude(exe, ['mcp', 'add', '--scope', 'user', SERVER_KEY, '--', entry.command, ...entry.args]);
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? (r.stderr || r.stdout || `exit code ${r.status}`).trim();
    throw new Error(
      `"claude mcp add" failed: ${why}\nRun this yourself instead:\n  ${claudeCodeCommand(entry)}`,
    );
  }
  return 'added for all your projects ("claude mcp list" shows it)';
}

/** Cleans up a folder typed or dragged into a terminal: quotes, ~, relative paths. */
export function normalizeFolderInput(input: string, cwd: string, home = homedir()): string {
  let p = input
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(home, p.slice(1));
  // Shells escape spaces when a folder is dragged in (macOS/Linux): "My\ Designs".
  if (process.platform !== 'win32') p = p.replace(/\\ /g, ' ');
  return resolve(cwd, p);
}

/** Checks a folder chosen for setup. Returns an error message, or undefined when fine. */
export function checkFolder(dir: string, recursive: boolean): string | undefined {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return `${dir} does not exist`;
  }
  if (!st.isDirectory()) return `${dir} is not a folder`;
  const unsafe = unsafeDefaultFolder(dir);
  if (unsafe && recursive) return `${dir} is ${unsafe}: choose the folder that holds your .fig files`;
  return undefined;
}

export const SETUP_HELP = `Usage: figtional setup [options] [folder]...

Connects Figtional to your AI apps. It asks which folders the AI may read, then adds a
"figtional" MCP server to the apps it finds on this computer:
  Claude Code     via "claude mcp add --scope user"
  Claude Desktop  claude_desktop_config.json
  Cursor          ~/.cursor/mcp.json
  VS Code         your user mcp.json
Existing JSON files are backed up (.bak) before they are changed. Restart the app afterwards.

Options:
  --client <ids>        Only these apps (comma-separated): ${CLIENT_IDS.join(', ')}
  --recursive           Include subfolders (the default)
  --no-recursive        Only the .fig files directly inside the folders
  --writable            Let the AI edit the files (use_figma); read-only by default
  --yes                 Don't ask: use the folders and options given on the command line
  --print               Only print the configuration; change nothing

The apps start Figtional with this copy of it and this Node.js, so if you move either, run
setup again.
`;

interface SetupChoices {
  folders: string[];
  recursive: boolean;
  writable: boolean;
  clients: Client[];
}

export async function setup(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      client: { type: 'string' },
      recursive: { type: 'boolean' },
      writable: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      print: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(SETUP_HELP);
    return 0;
  }
  const all = detectClients();
  let wanted: Client[] | undefined;
  if (values.client) {
    const ids = values.client
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = ids.filter((id) => !(CLIENT_IDS as readonly string[]).includes(id));
    if (unknown.length)
      throw new Error(`unknown --client: ${unknown.join(', ')} (use ${CLIENT_IDS.join(', ')})`);
    wanted = all.filter((c) => ids.includes(c.id));
  }
  const interactive = !values.yes && !values.print && process.stdin.isTTY === true;
  const out = (s = '') => process.stdout.write(s + '\n');

  let choices: SetupChoices;
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      choices = await ask(rl, all, wanted, positionals, values.recursive, values.writable);
    } finally {
      rl.close();
    }
  } else {
    if (!positionals.length) throw new Error('give the folders to share: figtional setup --yes <folder>...');
    const recursive = values.recursive ?? true;
    const folders = positionals.map((p) => normalizeFolderInput(p, process.cwd()));
    for (const f of folders) {
      const problem = checkFolder(f, recursive);
      if (problem) throw new Error(problem);
    }
    choices = {
      folders,
      recursive,
      writable: values.writable === true,
      clients: wanted ?? all.filter((c) => c.detected),
    };
  }

  const entry = serverEntry(choices.folders, choices);
  if (values.print) {
    out('Claude Code:');
    out(`  ${claudeCodeCommand(entry)}`);
    out('\nClaude Desktop / Cursor (mcpServers):');
    out(configSnippet('mcpServers', entry));
    out('VS Code (servers):');
    out(configSnippet('servers', entry));
    return 0;
  }
  if (!choices.clients.length) {
    out("No AI apps selected. Add this to your app's MCP settings yourself:");
    out(configSnippet('mcpServers', entry));
    return 0;
  }

  let failed = 0;
  out('');
  for (const client of choices.clients) {
    try {
      const msg =
        client.id === 'claude-code' ? addToClaudeCode(client, entry) : writeClientConfig(client, entry);
      out(`✓ ${client.name}: ${msg}`);
    } catch (e) {
      failed++;
      out(`✗ ${client.name}: ${(e as Error).message}`);
    }
  }
  out('');
  out(`Figtional can now read ${choices.writable ? 'and edit ' : ''}the .fig files in:`);
  for (const f of choices.folders) out(`  ${f}${choices.recursive ? ' (and its subfolders)' : ''}`);
  out('Restart the apps you changed (start a new Claude Code session) to load it.');
  out('To look at the files yourself: figtional serve ' + choices.folders.map((f) => `"${f}"`).join(' '));
  return failed ? 1 : 0;
}

type Rl = ReturnType<typeof createInterface>;

async function yesNo(rl: Rl, question: string, def: boolean): Promise<boolean> {
  for (;;) {
    const a = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (!a) return def;
    if (['y', 'yes'].includes(a)) return true;
    if (['n', 'no'].includes(a)) return false;
  }
}

async function ask(
  rl: Rl,
  all: Client[],
  wanted: Client[] | undefined,
  given: string[],
  recursiveFlag: boolean | undefined,
  writableFlag: boolean | undefined,
): Promise<SetupChoices> {
  const out = (s = '') => process.stdout.write(s + '\n');
  out('Figtional setup');
  out('');
  out('The AI will only be able to open .fig files in the folders you choose here.');
  out('Tip: you can drag a folder into this window instead of typing its path.');
  out('');
  const recursive = recursiveFlag ?? (await yesNo(rl, 'Include subfolders of the folders you choose?', true));
  const folders: string[] = [];
  for (const g of given) {
    const f = normalizeFolderInput(g, process.cwd());
    const problem = checkFolder(f, recursive);
    if (problem) out(`  ${problem}`);
    else folders.push(f);
  }
  for (;;) {
    const a = await rl.question(
      folders.length ? 'Another folder (Enter when done): ' : 'Folder with your .fig files: ',
    );
    if (!a.trim()) {
      if (folders.length) break;
      continue;
    }
    const f = normalizeFolderInput(a, process.cwd());
    const problem = checkFolder(f, recursive);
    if (problem) {
      out(`  ${problem}`);
      continue;
    }
    folders.push(f);
  }
  const writable =
    writableFlag ??
    (await yesNo(rl, 'Let the AI edit these files? (No = read-only, the safe choice for practising)', false));
  out('');
  const candidates = wanted ?? all;
  const clients: Client[] = [];
  for (const c of candidates) {
    if (!c.detected && !wanted) continue;
    if (await yesNo(rl, `Add Figtional to ${c.name}?`, true)) clients.push(c);
  }
  const missing = all.filter((c) => !c.detected).map((c) => c.name);
  if (!wanted && missing.length) out(`(Not found on this computer: ${missing.join(', ')})`);
  return { folders, recursive, writable, clients };
}
