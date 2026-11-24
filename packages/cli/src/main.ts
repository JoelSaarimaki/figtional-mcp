import { readFileSync, statSync } from 'node:fs';
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

const HELP = `figtional ${SERVER_VERSION}: a local, file-scoped stand-in for the Figma MCP server

Usage:
  figtional mcp [options] <file.fig | folder>...   Run the MCP server over stdio
  figtional dump <file.fig>                         Summarise a file (pages, node counts, format)
  figtional inspect <file.fig> <nodeId> [--json]    Show a node (XML outline, or decoded JSON)
  figtional validate <file.fig>                     Check that the file decodes and round-trips
  figtional serve <file.fig | folder>...            Web viewer (not implemented yet)

MCP options:
  --writable            Allow edits to every source (read-only by default)
  --recursive           Include subfolders of folder sources
  --out <dir>           Save edited files here instead of overwriting originals
  --config <file>       Load sources from a figtional.config.json
  --extra-tools[=a,b]   Enable Figtional-only tools (all, or a comma-separated list):
                        ${EXTRA_TOOLS.join(', ')}

A folder source gives access to every .fig file directly inside it (and below it with --recursive).
Nothing outside the given files and folders is accessible.
`;

interface ConfigFile {
  sources?: SourceConfig[];
  outDir?: string;
  writable?: boolean;
  extraTools?: boolean | string[];
}

export async function main(argv: string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mcp':
      return runMcp(rest);
    case 'dump':
      return dump(rest);
    case 'inspect':
      return inspect(rest);
    case 'validate':
      return validate(rest);
    case 'serve':
      process.stderr.write(
        'figtional serve: the web viewer is not implemented yet (PLAN.md milestone M6).\n',
      );
      return 2;
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

/** Builds workspace options from CLI args and an optional config file. */
export function parseMcpArgs(args: string[], cwd = process.cwd()) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      writable: { type: 'boolean' },
      recursive: { type: 'boolean' },
      out: { type: 'string' },
      config: { type: 'string' },
      'extra-tools': { type: 'string' },
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
    sources.push(isDir ? { dir: abs, recursive: values.recursive === true } : { file: abs });
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
    workspace: {
      sources,
      writable: values.writable === true || config.writable === true,
      ...(outDir ? { outDir } : {}),
      cwd,
    },
    extraTools,
  };
}

async function runMcp(args: string[]): Promise<number | undefined> {
  // Allow a bare `--extra-tools` flag (parseArgs needs a value for string options).
  const normalized = args.map((a) => (a === '--extra-tools' ? '--extra-tools=all' : a));
  if (normalized.includes('--help') || normalized.includes('-h')) {
    process.stdout.write(HELP);
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
