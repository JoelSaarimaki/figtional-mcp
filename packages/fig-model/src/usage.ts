import { type NodeChange, guidToString } from '@figtional/fig-format';
import type { FigDocument, SceneNode } from './document.js';
import { formatValue, resolveVariable, styleInfo } from './values.js';

export interface VariableUse {
  variable: NodeChange;
  /** Mode in effect where it is used (from the nearest explicit mode, else the default). */
  modeId?: string;
  /** Fields it's bound to, e.g. "fills", "STACK_PADDING_LEFT". */
  fields: Set<string>;
}

export interface Usage {
  variables: Map<string, VariableUse>;
  styles: Map<string, NodeChange>;
}

const STYLE_FIELDS = [
  'styleIdForFill',
  'styleIdForStrokeFill',
  'styleIdForText',
  'styleIdForEffect',
  'styleIdForGrid',
];

/** Explicit variable modes set on a node: collection id → mode id. */
function explicitModes(doc: FigDocument, n: NodeChange): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of n.variableModeBySetMap?.entries ?? []) {
    const set = doc.resolveVariableRef(
      e.variableSetID?.guid ? { guid: e.variableSetID.guid } : e.variableSetID,
    );
    const mode = e.variableModeID ?? e.modeID;
    if (set && mode) out.set(guidToString(set.guid), guidToString(mode));
  }
  return out;
}

function modeFor(doc: FigDocument, node: SceneNode, variable: NodeChange): string | undefined {
  const ref = variable.variableSetID;
  const set = ref ? doc.resolveVariableRef(ref.guid ? { guid: ref.guid } : ref) : undefined;
  if (!set) return undefined;
  const setId = guidToString(set.guid);
  for (let n: SceneNode | undefined = node; n; n = n.parent) {
    const m = explicitModes(doc, n.data).get(setId);
    if (m) return m;
  }
  return undefined;
}

/** Variables and styles used anywhere in `root`'s subtree (instance content included). */
export function collectUsage(doc: FigDocument, root: SceneNode): Usage {
  const usage: Usage = { variables: new Map(), styles: new Map() };
  const useVar = (node: SceneNode, alias: any, field: string) => {
    const v = doc.resolveVariableRef(alias);
    if (!v) return;
    const id = guidToString(v.guid);
    let u = usage.variables.get(id);
    if (!u) {
      const modeId = modeFor(doc, node, v);
      u = modeId ? { variable: v, modeId, fields: new Set() } : { variable: v, fields: new Set() };
      usage.variables.set(id, u);
    }
    u.fields.add(field);
  };
  root.walk((node) => {
    if (!node.visible && node !== root) return false;
    const d = node.data;
    for (const [list, field] of [
      [d.fillPaints, 'fills'],
      [d.strokePaints, 'strokes'],
    ] as const) {
      for (const p of list ?? []) {
        if (p.colorVar?.value?.alias) useVar(node, p.colorVar.value.alias, field);
      }
    }
    for (const e of d.variableConsumptionMap?.entries ?? []) {
      const alias = e.variableData?.value?.alias;
      if (alias) useVar(node, alias, e.variableField ?? 'unknown');
    }
    for (const f of STYLE_FIELDS) {
      const s = doc.resolveStyleRef(d[f]);
      if (s) usage.styles.set(guidToString(s.guid), s);
    }
    return true;
  });
  return usage;
}

/**
 * Flat name → value map in the style of Figma MCP's get_variable_defs: variables resolved in
 * the mode in effect, styles summarised (colors as hex, typography as Font(...)).
 */
export function variableDefs(doc: FigDocument, root: SceneNode): Record<string, string> {
  const usage = collectUsage(doc, root);
  const out: Record<string, string> = {};
  for (const s of usage.styles.values()) {
    const info = styleInfo(s);
    if (info.name) out[info.name] = info.value;
  }
  for (const u of usage.variables.values()) {
    const name = u.variable.name;
    if (name) out[name] = formatValue(resolveVariable(doc, u.variable, u.modeId));
  }
  return out;
}
