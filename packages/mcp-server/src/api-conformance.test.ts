/**
 * Checks Figtional's Plugin API against Figma's official typings (@figma/plugin-typings): every
 * name Figtional offers must exist in Figma (or be one of Figma MCP's documented extensions, or an
 * internal helper), so agents never learn an API Figma doesn't have. Coverage is printed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { FigArchive } from '@figtional/fig-format';
import { EditSession, FigDocument } from '@figtional/fig-model';
import { expect, it } from 'vitest';
import { syntheticFig } from '../../../test/synthetic.js';
import { createFigmaApi } from './plugin-api.js';

/** Figma MCP's own extensions to the Plugin API (docs/figma-mcp-tools.md §5.3). */
const MCP_EXTENSIONS = new Set(['createAutoLayout', 'query', 'set', 'screenshot', 'placeholder']);
/** Figtional's internal helpers on the node prototype (not part of the API). */
const INTERNAL = new Set([
  '_d',
  '_s',
  'definitionOwnerId',
  'minMax',
  'modeCollection',
  'modeEntriesWithout',
  'pluginEntries',
  'requireFrame',
  'requireModes',
  'requireText',
  'requireVector',
  'setBorder',
  'setCorner',
  'setMinMax',
  'setRange',
  'setSizing',
  'writePluginData',
  'sizing',
]);
const NODE_TYPES = [
  'FrameNode',
  'TextNode',
  'RectangleNode',
  'EllipseNode',
  'ComponentNode',
  'ComponentSetNode',
  'InstanceNode',
  'VectorNode',
  'LineNode',
  'SectionNode',
  'GroupNode',
  'BooleanOperationNode',
  'PolygonNode',
  'StarNode',
];

it('offers only Plugin API names that exist in Figma', () => {
  const dts = createRequire(import.meta.url).resolve('@figma/plugin-typings/plugin-api.d.ts');
  const program = ts.createProgram([dts], { noEmit: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(dts)!;
  const members = (name: string) => {
    const decl = sf.statements.find(
      (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
    );
    expect(decl, `interface ${name} in the typings`).toBeDefined();
    return new Set(checker.getPropertiesOfType(checker.getTypeAtLocation(decl!)).map((p) => p.name));
  };
  const figmaNode = new Set(NODE_TYPES.flatMap((t) => [...members(t)]));
  const figmaApi = members('PluginAPI');

  const dir = mkdtempSync(join(tmpdir(), 'figtional-api-'));
  try {
    writeFileSync(join(dir, 'a.fig'), syntheticFig());
    const doc = FigDocument.fromArchive(FigArchive.open(join(dir, 'a.fig')));
    const figma = createFigmaApi({
      doc,
      session: new EditSession(doc),
      fileKey: 'a',
      fileName: 'a',
      images: [],
    });
    const node = figma.createFrame();
    const ours = new Set<string>(Object.keys(node));
    for (let p = Object.getPrototypeOf(node); p && p !== Object.prototype; p = Object.getPrototypeOf(p))
      for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor') ours.add(k);
    doc.archive?.close();

    const unknownNode = [...ours].filter(
      (k) => !figmaNode.has(k) && !MCP_EXTENSIONS.has(k) && !INTERNAL.has(k),
    );
    const unknownApi = Object.keys(figma).filter((k) => !figmaApi.has(k) && !MCP_EXTENSIONS.has(k));
    expect(unknownNode, 'node members that Figma does not have').toEqual([]);
    expect(unknownApi, 'figma.* members that Figma does not have').toEqual([]);

    const nodeCovered = [...figmaNode].filter((k) => ours.has(k)).length;
    const apiCovered = [...figmaApi].filter((k) => k in figma).length;
    console.log(
      `Plugin API coverage: figma.* ${apiCovered}/${figmaApi.size}, node members ${nodeCovered}/${figmaNode.size}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
