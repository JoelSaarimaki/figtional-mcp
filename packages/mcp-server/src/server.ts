import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { guidToString } from '@figtional/fig-format';
import {
  type FigDocument,
  type SceneNode,
  collectionInfo,
  normalizeNodeId,
  styleInfo,
  variableDefs,
  variableInfo,
  formatValue,
  resolveVariable,
} from '@figtional/fig-model';
import { z } from 'zod';
import { embeddedLibraries, searchDesignSystem } from './design-system.js';
import { metadataXml } from './metadata.js';
import { AssetServer } from './assets.js';
import { codeTarget, designContextText } from './design-context.js';
import { runUseFigma } from './use-figma.js';
import { renderPng } from '@figtional/fig-render';
import { type FileEntry, FileNotAvailableError, type Workspace, parseFigmaUrl } from './workspace.js';

export const SERVER_NAME = 'figtional';
export const SERVER_VERSION = '0.1.0';

/** Longest side of get_screenshot images, in px. */
export const SCREENSHOT_MAX_SIZE = 2048;

/** Figtional-only tools; off unless enabled (PLAN.md §5.2). */
export const EXTRA_TOOLS = [
  'figtional_list_files',
  'figtional_list_pages',
  'figtional_find_nodes',
  'figtional_get_node_json',
] as const;
export type ExtraTool = (typeof EXTRA_TOOLS)[number];

export interface ServerOptions {
  /** true = all extras, or a list of extra tool names. */
  extraTools?: boolean | string[];
  /** Asset server for get_design_context (default: one on localhost:3845, or a free port). */
  assets?: AssetServer;
}

/** An error the agent sees as a tool error (isError: true). */
export class ToolError extends Error {}

/** A feature Figtional doesn't have; worded so it isn't mistaken for a Figma limitation. */
export function notSupported(what: string, detail = ''): ToolError {
  return new ToolError(
    `NotSupportedInFigtional: ${what}. This is a limitation of Figtional (the local Figma MCP stand-in), not of Figma MCP.${detail ? ' ' + detail : ''}`,
  );
}

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));

// Parameters shared by Figma MCP's tools. Unknown extras are ignored.
const fileKeyParam = z
  .string()
  .describe(
    'The key of the file to read. Extract it from a Figma URL: figma.com/design/:fileKey/:fileName?node-id=… (for branch URLs, use the branch key). Full URLs are accepted too.',
  );
const nodeIdParam = z
  .string()
  .describe('The id of the node, e.g. "123:456" or "123-456" (as in the node-id URL parameter).');
const clientParams = {
  clientLanguages: z
    .string()
    .optional()
    .describe(
      'Comma-separated languages used in the client project, e.g. "typescript,javascript". Used for logging and output framing.',
    ),
  clientFrameworks: z
    .string()
    .optional()
    .describe(
      'Comma-separated frameworks used in the client project, e.g. "react". Used for logging and output framing.',
    ),
  skillNames: z
    .string()
    .optional()
    .describe('Comma-separated names of skills in use. Logging only; does not affect execution.'),
};

export function createServer(workspace: Workspace, options: ServerOptions = {}): McpServer {
  const extras = new Set<string>(
    options.extraTools === true ? EXTRA_TOOLS : Array.isArray(options.extraTools) ? options.extraTools : [],
  );
  const assets = options.assets ?? new AssetServer();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Figtional MCP: a local stand-in for the Figma MCP server. It serves only the .fig files configured for this session. Use whoami to see which files are available and their file keys.',
    },
  );

  const run = async (fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (e) {
      const msg =
        e instanceof ToolError || e instanceof FileNotAvailableError
          ? e.message
          : `Error: ${(e as Error).message}`;
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
  };

  /** Resolves fileKey (+ optional nodeId, also taken from a URL). */
  const open = (fileKey: string, nodeId?: string) => {
    const url = parseFigmaUrl(fileKey);
    const entry = workspace.resolve(url?.fileKey ?? fileKey);
    const doc = workspace.document(entry);
    const id = nodeId ?? url?.nodeId;
    return { entry, doc, nodeId: id };
  };

  const getNode = (doc: FigDocument, nodeId: string | undefined, entry: FileEntry): SceneNode => {
    if (nodeId === undefined || nodeId.trim() === '') throw new ToolError('invalid nodeId');
    const norm = normalizeNodeId(nodeId);
    if (!norm) throw new ToolError(`invalid nodeId "${nodeId}". Use the form "123:456".`);
    const node = doc.getNodeById(norm);
    if (!node) throw new ToolError(`Node ${norm} not found in file "${entry.key}".`);
    return node;
  };

  // ---------------------------------------------------------------- whoami
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Returns information about the current user and their plans. In Figtional it also lists the .fig files available in this session.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(() => {
        const files = workspace.listFiles();
        return json({
          handle: 'figtional-local',
          email: 'local@figtional.invalid',
          plans: [
            {
              key: 'figtional::local',
              name: 'Figtional (local files)',
              tier: 'local',
              specs_enabled: false,
              code_layers_enabled: false,
            },
          ],
          figtional: {
            note: 'Figtional MCP serves local .fig exports. Only the files below are accessible.',
            scope: workspace.describeScope(),
            files: files.map((f) => ({
              fileKey: f.key,
              name: f.name,
              writable: f.writable,
              url: `https://www.figma.com/design/${f.key}/${encodeURIComponent(f.name.replace(/\s+/g, '-'))}`,
            })),
            extraToolsEnabled: [...extras],
          },
        });
      }),
  );

  // ---------------------------------------------------------- get_metadata
  server.registerTool(
    'get_metadata',
    {
      title: 'Get metadata',
      description:
        'Get metadata for a node or page in XML format: node ids, layer types, names, positions and sizes. Useful for getting an overview of the structure before calling get_design_context on specific nodes. Without a nodeId, returns the pages of the file.',
      inputSchema: { fileKey: fileKeyParam, nodeId: nodeIdParam.optional(), ...clientParams },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey, nodeId }) =>
      run(() => {
        const { doc, nodeId: id, entry } = open(fileKey, nodeId);
        if (!id) return json(doc.pages.map((p) => ({ guid: p.id, name: p.name })));
        const node = getNode(doc, id, entry);
        return text(metadataXml(node).xml);
      }),
  );

  // ----------------------------------------------------- get_variable_defs
  server.registerTool(
    'get_variable_defs',
    {
      title: 'Get variable definitions',
      description:
        'Get the variables and styles used in a node (colors, spacing, typography, etc.), e.g. {"icon/default/secondary": "#949494"}.',
      inputSchema: { fileKey: fileKeyParam, nodeId: nodeIdParam.optional(), ...clientParams },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey, nodeId }) =>
      run(() => {
        const { doc, entry, nodeId: id } = open(fileKey, nodeId);
        return json(variableDefs(doc, getNode(doc, id, entry)));
      }),
  );

  // ------------------------------------------------- search_design_system
  server.registerTool(
    'search_design_system',
    {
      title: 'Search design system',
      description:
        'Search the design system available to a file for components, variables and styles. Each query targets one entity type with one intent (no OR semantics). In Figtional, this searches the file itself and the library assets embedded in its export.',
      inputSchema: {
        fileKey: fileKeyParam,
        queries: z
          .array(z.object({ entity: z.enum(['component', 'variable', 'style']), query: z.string() }))
          .min(1)
          .describe('Queries, e.g. [{"entity":"component","query":"button"}].'),
        includeLibraryKeys: z
          .array(z.string())
          .optional()
          .describe('Restrict to these library keys (from get_libraries).'),
        ...clientParams,
      },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey, queries }) =>
      run(() => {
        const { doc, entry } = open(fileKey);
        return json(searchDesignSystem(doc, entry.name, queries));
      }),
  );

  // --------------------------------------------------------- get_libraries
  server.registerTool(
    'get_libraries',
    {
      title: 'Get libraries',
      description:
        'List the libraries added to a file and libraries available to add. In Figtional, these are the libraries whose assets are embedded in the .fig export.',
      inputSchema: { fileKey: fileKeyParam, offset: z.number().int().min(0).optional(), ...clientParams },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey }) =>
      run(() => {
        const { doc } = open(fileKey);
        return json({
          libraries_added_to_file: embeddedLibraries(doc),
          libraries_available_to_add: [],
          libraries_available_to_add_next_offset: null,
        });
      }),
  );

  // -------------------------------------------------- get_code_connect_map
  server.registerTool(
    'get_code_connect_map',
    {
      title: 'Get Code Connect map',
      description:
        'Get the mapping between Figma nodes and code components (Code Connect). .fig exports contain no Code Connect data, so this is always empty in Figtional.',
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam.optional(),
        codeConnectLabel: z.string().optional(),
        ...clientParams,
      },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey }) =>
      run(() => {
        open(fileKey); // still validates access
        return json({});
      }),
  );

  // ----------------------------------------------- create_design_system_rules
  server.registerTool(
    'create_design_system_rules',
    {
      title: 'Create design system rules',
      description:
        "Provides a prompt for generating design system rules for this repository (e.g. to save in CLAUDE.md). With a fileKey, Figtional adds a summary of that file's variables, styles and components.",
      inputSchema: { fileKey: fileKeyParam.optional(), ...clientParams },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey, clientLanguages, clientFrameworks }) =>
      run(() => {
        const parts = [designSystemRulesPrompt(clientLanguages, clientFrameworks)];
        if (fileKey) {
          const { doc, entry } = open(fileKey);
          parts.push(designSystemSummary(doc, entry.name));
        }
        return text(parts.join('\n\n'));
      }),
  );

  // --------------------------------------------------------- get_screenshot
  server.registerTool(
    'get_screenshot',
    {
      title: 'Get screenshot',
      description:
        'Generate a screenshot (PNG) of a node or page. Useful as the visual source of truth when implementing a design.',
      inputSchema: { fileKey: fileKeyParam, nodeId: nodeIdParam.optional(), ...clientParams },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey, nodeId }) =>
      run(() => {
        const { doc, entry, nodeId: id } = open(fileKey, nodeId);
        const node = getNode(doc, id, entry);
        if (node.figType === 'DOCUMENT') throw new ToolError('invalid nodeId');
        // Longest side capped so the image stays usable for MCP clients (inferred; Figma's cap is unknown).
        const r = renderPng(doc, node, { maxSize: SCREENSHOT_MAX_SIZE });
        return { content: [{ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }] };
      }),
  );

  // ----------------------------------------------------- get_design_context
  server.registerTool(
    'get_design_context',
    {
      title: 'Get design context',
      description:
        'Generate UI code for a node (React + Tailwind by default; HTML/CSS when clientFrameworks/clientLanguages ask for it), with asset URLs and the variables and styles it uses. Preferred tool for implementing a design. For large nodes, call get_metadata first and then get_design_context on the parts you need.',
      inputSchema: { fileKey: fileKeyParam, nodeId: nodeIdParam.optional(), ...clientParams },
      annotations: { readOnlyHint: true },
    },
    ({ fileKey, nodeId, clientLanguages, clientFrameworks }) =>
      run(async () => {
        const { doc, entry, nodeId: id } = open(fileKey, nodeId);
        const node = getNode(doc, id, entry);
        if (node.figType === 'CANVAS' || node.figType === 'DOCUMENT') {
          throw new ToolError(
            'You currently have nothing selected. get_design_context needs a layer (frame, component, group…), not a page. Use get_metadata on the page to find the layer ids.',
          );
        }
        return text(
          await designContextText(
            doc,
            entry.key,
            node,
            assets,
            codeTarget(clientLanguages, clientFrameworks),
          ),
        );
      }),
  );

  // -------------------------------------------------------------- use_figma
  server.registerTool(
    'use_figma',
    {
      title: 'Use Figma',
      description:
        'Run JavaScript against the Figma Plugin API (the `figma` global) in a file, to read or edit it. The code runs inside an async function: use top-level await and `return` a JSON-serialisable value (console output is not returned). Load fonts with figma.loadFontAsync before changing text. Figtional supports a subset of the Plugin API and saves the file after each successful call; a failing call changes nothing.',
      inputSchema: {
        fileKey: fileKeyParam,
        code: z.string().describe('JavaScript to run. Runs in an async function; return a value to see it.'),
        description: z.string().optional().describe('Short description of what the code does (for logs).'),
        skillNames: clientParams.skillNames,
      },
    },
    ({ fileKey, code }) =>
      run(async () => {
        const entry = workspace.resolve(parseFigmaUrl(fileKey)?.fileKey ?? fileKey);
        const r = await runUseFigma(workspace, entry, code);
        const content: CallToolResult['content'] = [{ type: 'text', text: r.text }];
        for (const img of r.images) {
          content.push(
            { type: 'text', text: img.caption },
            { type: 'image', data: img.data, mimeType: 'image/png' },
          );
        }
        return r.ok ? { content } : { isError: true, content };
      }),
  );

  // ----------------------------------------------------------- extra tools
  if (extras.has('figtional_list_files')) {
    server.registerTool(
      'figtional_list_files',
      {
        title: 'List files (Figtional)',
        description: 'Figtional-only: list the .fig files available in this session, with paging.',
        inputSchema: {
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      ({ offset = 0, limit = 100 }) =>
        run(() => {
          const files = workspace.listFiles();
          return json({
            total: files.length,
            files: files
              .slice(offset, offset + limit)
              .map((f) => ({ fileKey: f.key, name: f.name, writable: f.writable })),
            nextOffset: offset + limit < files.length ? offset + limit : null,
          });
        }),
    );
  }
  if (extras.has('figtional_list_pages')) {
    server.registerTool(
      'figtional_list_pages',
      {
        title: 'List pages (Figtional)',
        description: 'Figtional-only: list pages with their top-level frames.',
        inputSchema: { fileKey: fileKeyParam },
        annotations: { readOnlyHint: true },
      },
      ({ fileKey }) =>
        run(() => {
          const { doc } = open(fileKey);
          return json(
            doc.pages.map((p) => ({
              id: p.id,
              name: p.name,
              isDivider: p.data.isPageDivider === true,
              topLevel: p.children.map((c) => ({ id: c.id, name: c.name, type: c.type })),
            })),
          );
        }),
    );
  }
  if (extras.has('figtional_find_nodes')) {
    server.registerTool(
      'figtional_find_nodes',
      {
        title: 'Find nodes (Figtional)',
        description:
          'Figtional-only: find nodes by name, type or text content (case-insensitive substring match).',
        inputSchema: {
          fileKey: fileKeyParam,
          name: z.string().optional(),
          type: z.string().optional().describe('Plugin API type, e.g. FRAME, TEXT, COMPONENT, INSTANCE.'),
          text: z.string().optional(),
          pageId: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      ({ fileKey, name, type, text: textQuery, pageId, limit = 100 }) =>
        run(() => {
          const { doc, entry } = open(fileKey);
          const roots = pageId ? [getNode(doc, pageId, entry)] : doc.pages;
          const out: any[] = [];
          for (const root of roots) {
            root.walk((n) => {
              if (out.length >= limit) return false;
              if (n === root) return true;
              if (name && !n.name.toLowerCase().includes(name.toLowerCase())) return true;
              if (type && n.type !== type.toUpperCase()) return true;
              if (
                textQuery &&
                !(n.data.textData?.characters ?? '').toLowerCase().includes(textQuery.toLowerCase())
              )
                return true;
              out.push({ id: n.id, name: n.name, type: n.type, page: n.page?.name });
              return true;
            });
          }
          return json(out);
        }),
    );
  }
  if (extras.has('figtional_get_node_json')) {
    server.registerTool(
      'figtional_get_node_json',
      {
        title: 'Get node JSON (Figtional)',
        description:
          'Figtional-only, for debugging: the decoded .fig data of a node (binary fields summarised).',
        inputSchema: { fileKey: fileKeyParam, nodeId: nodeIdParam.optional() },
        annotations: { readOnlyHint: true },
      },
      ({ fileKey, nodeId }) =>
        run(() => {
          const { doc, entry, nodeId: id } = open(fileKey, nodeId);
          const node = getNode(doc, id, entry);
          return text(
            JSON.stringify(
              node.data,
              (_k, v) =>
                v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === 'bigint' ? v.toString() : v,
              2,
            ),
          );
        }),
    );
  }

  return server;
}

function designSystemRulesPrompt(languages?: string, frameworks?: string): string {
  return [
    '# Create design system rules',
    '',
    `Analyse this codebase${frameworks ? ` (frameworks: ${frameworks})` : ''}${languages ? ` (languages: ${languages})` : ''} and write rules that help an AI agent turn Figma designs into code that fits the project. Save them where the agent reads project rules (for example CLAUDE.md or .cursor/rules).`,
    '',
    'Cover:',
    '1. Design tokens: where colors, spacing, typography and radii are defined, and how to map Figma variables and styles to them. Never hardcode values that exist as tokens.',
    '2. Components: where reusable UI components live, naming conventions, and which component to use for common Figma components.',
    '3. Styling: the styling approach (CSS modules, Tailwind, styled-components, …) and how to translate Figma auto layout (direction, gap, padding, alignment, sizing).',
    '4. Assets: where images and icons go, and how to export and reference them.',
    '5. Project structure and patterns the generated code must follow.',
    '6. Figma MCP workflow: get_metadata for structure, get_design_context for code, get_screenshot to verify visually, get_variable_defs for tokens.',
  ].join('\n');
}

function designSystemSummary(doc: FigDocument, fileName: string): string {
  const lines = [`## Design system in "${fileName}" (from the .fig file)`];
  const sets = doc.variableCollections.map((s) => collectionInfo(doc, s));
  if (sets.length) {
    lines.push('', '### Variable collections');
    for (const c of sets) {
      lines.push(
        `- ${c.name} (modes: ${c.modes.map((m) => m.name).join(', ')}; ${c.variableIds.length} variables)`,
      );
      for (const vid of c.variableIds.slice(0, 15)) {
        const v = doc.nodes.get(vid);
        if (!v) continue;
        const info = variableInfo(doc, v);
        lines.push(`  - ${info.name}: ${formatValue(resolveVariable(doc, v))}`);
      }
      if (c.variableIds.length > 15) lines.push(`  - … ${c.variableIds.length - 15} more`);
    }
  }
  const styles = doc.styles.map(styleInfo);
  if (styles.length) {
    lines.push('', '### Styles');
    for (const s of styles.slice(0, 40)) lines.push(`- ${s.styleType} ${s.name}: ${s.value}`);
    if (styles.length > 40) lines.push(`- … ${styles.length - 40} more`);
  }
  const comps = doc.components.filter((c) => !c.sourceLibraryKey);
  if (comps.length) {
    lines.push('', '### Local components');
    for (const c of comps.slice(0, 40)) lines.push(`- ${c.name} (${guidToString(c.guid)})`);
    if (comps.length > 40) lines.push(`- … ${comps.length - 40} more`);
  }
  return lines.join('\n');
}
