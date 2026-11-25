import { readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { FigArchive, encodeCanvas, guidToString } from '@figtional/fig-format';
import { FigDocument, normalizeNodeId } from '@figtional/fig-model';
import {
  EXTRA_TOOLS,
  type SourceConfig,
  Workspace,
  createServer,
  metadataXml,
  SERVER_VERSION,
} from '@figtional/mcp-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createViewerServer } from '@figtional/viewer';
import { unsafeDefaultFolder } from './folders.js';
import { SETUP_HELP, setup } from './setup.js';

export { unsafeDefaultFolder };

const HELP = `figtional ${SERVER_VERSION}: a local, file-scoped stand-in for the Figma MCP server

Usage: figtional <command> [options]

Commands:
  setup     Connect Figtional to Claude Code, Claude Desktop, Cursor or VS Code
  mcp       Run the MCP server (stdio) for the given .fig files or folders
  serve     Read-only web viewer on http://127.0.0.1:3846
  dump      Summarise a .fig file (pages, node counts, format)
  inspect   Show one node of a .fig file
  validate  Check that a .fig file decodes and round-trips
  help      Show help for a command: figtional help <command>

Examples:
  figtional setup                                  guided setup for your AI apps
  figtional serve                                  view every .fig below this folder
  figtional mcp ./designs/App.fig                  let an agent read one file
  figtional mcp --writable --out ./edited ./designs  let it edit copies of a folder's files
  figtional inspect App.fig 1:4 --json

Run "figtional <command> --help" for the options of a command.
Global options: -h, --help   -v, --version
Docs: https://github.com/JoelSaarimaki/figtional-mcp
`;

const SCOPE_NOTE = `A file source gives access to that file. A folder source gives access to every .fig file
directly inside it (and below it with --recursive). Nothing else is accessible.`;

const COMMAND_HELP: Record<string, string> = {
  setup: SETUP_HELP,
  mcp: `Usage: figtional mcp [options] <file.fig | folder>...

Runs the Figtional MCP server over stdio, exposing Figma MCP's tools (whoami, get_metadata,
get_design_context, get_screenshot, get_variable_defs, search_design_system, get_libraries,
use_figma, …) for the given sources only. Logs go to stderr.

Options:
  --writable            Allow edits (use_figma) to every source; read-only by default
                        (or set FIGTIONAL_WRITABLE=true)
  --recursive           Include subfolders of folder sources (or FIGTIONAL_RECURSIVE=true)
  --out <dir>           Save edited files to <dir> instead of overwriting the originals
  --config <file>       Load sources from a figtional.config.json
  --extra-tools[=a,b]   Enable Figtional-only tools (all, or a comma-separated list):
                        ${EXTRA_TOOLS.join(', ')}

${SCOPE_NOTE}

Example .mcp.json entry:
  { "command": "node", "args": ["<repo>/packages/cli/dist/bin.js", "mcp", "./designs"] }
`,
  serve: `Usage: figtional serve [options] [file.fig | folder]...

Starts the read-only web viewer (page selector, layers, inspect panel, prototype mode) on
http://127.0.0.1:3846. It only listens on this computer and reloads when a file changes.
Without sources it serves every .fig below the current folder, except from drive roots, your home
folder and system folders, and stops after 2000 folders or 8 levels.

Options:
  --port <n>            Port (default 3846)
  --open                Open the viewer in your web browser
  --config <file>       Load sources from a figtional.config.json

Folders are searched including their subfolders (hidden folders and node_modules are skipped).
`,
  dump: `Usage: figtional dump <file.fig>

Prints the file name, export date, format version, node counts by type, styles, variables and
the list of pages.
`,
  inspect: `Usage: figtional inspect <file.fig> <nodeId> [--json]

Shows one node: an XML outline of its subtree (like get_metadata), or with --json the decoded
.fig data of the node. Node ids look like 1:4 (or 1-4, as in Figma URLs); layers inside
instances look like I1:2;3:4.
`,
  validate: `Usage: figtional validate <file.fig>

Checks that the file decodes, that it re-encodes byte-for-byte, and reports the format version,
schema hash and instances whose component is missing. Exit code 1 when a check fails.
`,
};

const wantsHelp = (args: string[]) => args.includes('--help') || args.includes('-h');

interface ConfigFile {
  sources?: SourceConfig[];
  outDir?: string;
  writable?: boolean;
  extraTools?: boolean | string[];
}

export async function main(argv: string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  if (command && COMMAND_HELP[command] && wantsHelp(rest)) {
    process.stdout.write(COMMAND_HELP[command]);
    return 0;
  }
  if (command === 'help' && rest[0]) {
    const text = COMMAND_HELP[rest[0]];
    if (!text) {
      process.stderr.write(`Unknown command "${rest[0]}".\n\n${HELP}`);
      return 2;
    }
    process.stdout.write(text);
    return 0;
  }
  switch (command) {
    case 'setup':
      return setup(rest);
    case 'mcp':
      return runMcp(rest);
    case 'dump':
      return dump(rest);
    case 'inspect':
      return inspect(rest);
    case 'validate':
      return validate(rest);
    case 'serve':
      return serve(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case '-v':
    case '--version':
      process.stdout.write(`${SERVER_VERSION}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

/** Budget for the implicit "current folder" scope of a bare `figtional serve`. */
export const DEFAULT_SCAN_LIMIT = { maxDirs: 2000, maxDepth: 8 };

/** Builds workspace options from CLI args and an optional config file. */
export function parseMcpArgs(
  args: string[],
  cwd = process.cwd(),
  opts: { defaultToCwd?: boolean; recursiveFolders?: boolean } = {},
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      writable: { type: 'boolean' },
      recursive: { type: 'boolean' },
      out: { type: 'string' },
      config: { type: 'string' },
      'extra-tools': { type: 'string' },
      port: { type: 'string' },
      watch: { type: 'boolean' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    // --extra-tools without a value
    strict: true,
  });
  let config: ConfigFile = {};
  let base = cwd;
  if (values.config) {
    const path = resolve(cwd, values.config);
    config = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
    base = resolve(path, '..');
  }
  const sources: SourceConfig[] = (config.sources ?? []).map((s) =>
    'file' in s ? { ...s, file: resolve(base, s.file) } : { ...s, dir: resolve(base, s.dir) },
  );
  for (const p of positionals) {
    const abs = resolve(cwd, p);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new Error(`source not found: ${abs}`);
    }
    sources.push(
      isDir
        ? { dir: abs, recursive: values.recursive === true || opts.recursiveFolders === true }
        : { file: abs },
    );
  }
  // The viewer defaults to the current folder (recursively); the MCP server never guesses its scope.
  if (!sources.length && opts.defaultToCwd) {
    const reason = unsafeDefaultFolder(cwd);
    if (reason) {
      throw new Error(
        `not scanning ${cwd} for .fig files: it is ${reason}. Run figtional serve in your designs folder, or pass files or folders explicitly (figtional serve <file.fig | folder>...).`,
      );
    }
    sources.push({ dir: cwd, recursive: true, limit: DEFAULT_SCAN_LIMIT });
  }
  if (!sources.length) throw new Error('no sources given. Pass .fig files or folders, or --config.');
  const extraArg = values['extra-tools'];
  const extraTools: boolean | string[] =
    extraArg === undefined
      ? (config.extraTools ?? false)
      : extraArg === '' || extraArg === 'all' || extraArg === 'true'
        ? true
        : extraArg
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  if (Array.isArray(extraTools)) {
    const unknown = extraTools.filter((t) => !(EXTRA_TOOLS as readonly string[]).includes(t));
    if (unknown.length) throw new Error(`unknown extra tools: ${unknown.join(', ')}`);
  }
  const outDir = values.out
    ? resolve(cwd, values.out)
    : config.outDir
      ? resolve(base, config.outDir)
      : undefined;
  return {
    port: values.port ? Number(values.port) : undefined,
    open: values.open === true,
    workspace: {
      sources,
      writable: values.writable === true || config.writable === true,
      ...(outDir ? { outDir } : {}),
      cwd,
    },
    extraTools,
  };
}

async function serve(args: string[]): Promise<number | undefined> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(COMMAND_HELP.serve!);
    return 0;
  }
  const {
    workspace: wsOpts,
    port,
    open,
  } = parseMcpArgs(args, process.cwd(), {
    defaultToCwd: true,
    recursiveFolders: true,
  });
  const workspace = new Workspace({ ...wsOpts, writable: false });
  const files = workspace.listFiles();
  for (const s of workspace.describeScope()) {
    const what = s.kind === 'folder' ? `folder ${s.path}${s.recursive ? ' (with subfolders)' : ''}` : s.path;
    process.stdout.write(`Serving ${what}\n`);
  }
  for (const w of workspace.warnings()) process.stdout.write(`Warning: ${w}\n`);
  if (!files.length) {
    process.stdout.write(
      'No .fig files found. Pass files or folders: figtional serve <file.fig | folder>...\n',
    );
  }
  const server = createViewerServer(workspace, port ? { port } : {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 3846, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : (port ?? 3846);
  process.stdout.write(
    `Figtional viewer: http://127.0.0.1:${actualPort}/  (${files.length} file(s); read-only; Ctrl+C to stop)\n`,
  );
  if (open) openBrowser(`http://127.0.0.1:${actualPort}/`);
  return undefined;
}

/** Opens a URL in the default browser (best effort: the URL is printed anyway). */
function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['explorer.exe', [url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref();
  } catch {
    /* no browser */
  }
}

async function runMcp(args: string[]): Promise<number | undefined> {
  // Allow a bare `--extra-tools` flag (parseArgs needs a value for string options).
  const normalized = args.map((a) => (a === '--extra-tools' ? '--extra-tools=all' : a));
  // Settings from the environment (used by the Claude Desktop extension's options).
  const envFlag = (name: string) => /^(1|true|yes)$/i.test(process.env[name] ?? '');
  if (envFlag('FIGTIONAL_WRITABLE') && !normalized.includes('--writable')) normalized.unshift('--writable');
  if (envFlag('FIGTIONAL_RECURSIVE') && !normalized.includes('--recursive'))
    normalized.unshift('--recursive');
  if (normalized.includes('--help') || normalized.includes('-h')) {
    process.stdout.write(COMMAND_HELP.mcp!);
    return 0;
  }
  const { workspace: wsOpts, extraTools } = parseMcpArgs(normalized);
  const workspace = new Workspace(wsOpts);
  const files = workspace.listFiles();
  // stdout belongs to the MCP protocol: log to stderr only.
  process.stderr.write(`figtional ${SERVER_VERSION}: serving ${files.length} file(s)\n`);
  for (const f of files) process.stderr.write(`  ${f.key}  ${f.name}${f.writable ? '  (writable)' : ''}\n`);
  for (const w of workspace.warnings()) process.stderr.write(`  warning: ${w}\n`);
  const server = createServer(workspace, { extraTools });
  await server.connect(new StdioServerTransport());
  return undefined;
}

function openDoc(path: string | undefined): FigDocument {
  if (!path) throw new Error('missing <file.fig>');
  return FigDocument.fromArchive(FigArchive.open(resolve(path)));
}

function dump(args: string[]): number {
  const doc = openDoc(args[0]);
  const meta = doc.archive!.meta();
  const counts: Record<string, number> = {};
  for (const n of doc.nodes.values()) counts[n.type ?? '?'] = (counts[n.type ?? '?'] ?? 0) + 1;
  const out: string[] = [];
  out.push(`File:      ${meta.file_name ?? '(unnamed)'}`);
  out.push(`Exported:  ${meta.exported_at ?? '?'}`);
  out.push(
    `Format:    ${doc.canvas.magic} v${doc.canvas.version}, message ${doc.canvas.messageCompression}, ${doc.canvas.schema.definitions.length} schema definitions`,
  );
  out.push(
    `Nodes:     ${doc.nodes.size} (${Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`)
      .join(', ')})`,
  );
  out.push(`Blobs:     ${doc.blobs.length}   Images: ${doc.archive!.imageHashes().length}`);
  out.push(
    `Styles:    ${doc.styles.length}   Variables: ${doc.variables.length} in ${doc.variableCollections.length} collections`,
  );
  out.push('Pages:');
  for (const p of doc.allPages) {
    const tag = p.data.internalOnly ? ' (internal)' : p.data.isPageDivider ? ' (divider)' : '';
    out.push(`  ${p.id.padEnd(8)} ${p.name}${tag}  [${p.children.length} top-level]`);
  }
  process.stdout.write(out.join('\n') + '\n');
  doc.archive!.close();
  return 0;
}

function inspect(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const doc = openDoc(positionals[0]);
  const id = positionals[1] ? normalizeNodeId(positionals[1]) : undefined;
  if (!id) throw new Error('missing or invalid <nodeId> (e.g. 1:2)');
  const node = doc.getNodeById(id);
  if (!node) throw new Error(`node ${id} not found`);
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        node.data,
        (_k, v) =>
          v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === 'bigint' ? v.toString() : v,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(metadataXml(node).xml + '\n');
  }
  doc.archive!.close();
  return 0;
}

function validate(args: string[]): number {
  if (!args[0]) throw new Error('missing <file.fig>');
  const path = resolve(args[0]);
  const fig = FigArchive.open(path);
  const problems: string[] = [];
  const canvas = fig.decodeCanvas();
  const schemaHash = createHash('sha256').update(canvas.schemaChunk).digest('hex').slice(0, 16);
  const re = canvas.compiled.encodeMessage(canvas.message);
  const identical = Buffer.compare(Buffer.from(re), Buffer.from(canvas.messageBytes)) === 0;
  if (!identical) problems.push('message does not re-encode byte-for-byte');
  try {
    encodeCanvas(canvas);
  } catch (e) {
    problems.push(`canvas encode failed: ${(e as Error).message}`);
  }
  const doc = new FigDocument(canvas, fig);
  let missing = 0;
  for (const n of doc.nodes.values()) {
    if (
      n.type === 'INSTANCE' &&
      !doc.nodes.get(guidToString(n.symbolData?.symbolID ?? { sessionID: -1, localID: -1 }))
    )
      missing++;
  }
  const known = [101, 106];
  process.stdout.write(
    [
      `Format version: ${canvas.version}${known.includes(canvas.version) ? '' : ' (not seen before: please report)'}`,
      `Schema:         ${canvas.schema.definitions.length} definitions, sha256 ${schemaHash}`,
      `Round-trip:     ${identical ? 'byte-identical' : 'DIFFERS'}`,
      `Instances with missing components: ${missing}`,
      problems.length ? `Problems:\n  ${problems.join('\n  ')}` : 'OK',
    ].join('\n') + '\n',
  );
  fig.close();
  return problems.length ? 1 : 0;
}
