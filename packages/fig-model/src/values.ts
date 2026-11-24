import { type Color, type NodeChange, guidToString } from '@figtional/fig-format';
import type { FigDocument } from './document.js';

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** "#RRGGBB", or "#RRGGBBAA" when alpha < 1. */
export function colorToHex(c: Color, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 1 ? hex2(a) : ''}`;
}

export type VariableValue = string | number | boolean | Color | { alias: string } | null;

export interface VariableInfo {
  id: string;
  key?: string;
  name: string;
  resolvedType: string;
  collectionId?: string;
  collectionName?: string;
  description?: string;
  scopes?: string[];
  /** mode name → raw value (aliases kept as { alias: variable name }). */
  valuesByMode: Record<string, VariableValue>;
}

export interface CollectionInfo {
  id: string;
  key?: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId?: string;
  variableIds: string[];
}

export function collectionInfo(doc: FigDocument, set: NodeChange): CollectionInfo {
  const modes = (set.variableSetModes ?? []).map((m: any) => ({
    modeId: guidToString(m.id),
    name: m.name as string,
  }));
  const id = guidToString(set.guid);
  return {
    id,
    key: set.key,
    name: set.name ?? '',
    modes,
    defaultModeId: modes[0]?.modeId,
    // variableSetID is `{ guid }` for local collections and `{ assetRef }` for library ones.
    variableIds: doc.variables.filter((v) => collectionOf(doc, v) === set).map((v) => guidToString(v.guid)),
  };
}

function rawVariableData(doc: FigDocument, data: any): VariableValue {
  const v = data?.value;
  if (!v) return null;
  if (v.alias) {
    const target = doc.resolveVariableRef(v.alias);
    return { alias: target?.name ?? '(missing variable)' };
  }
  if (v.colorValue) return v.colorValue as Color;
  if (v.floatValue !== undefined) return v.floatValue as number;
  if (v.boolValue !== undefined) return v.boolValue as boolean;
  if (v.textValue !== undefined) return v.textValue as string;
  return null;
}

function collectionOf(doc: FigDocument, v: NodeChange): NodeChange | undefined {
  const ref = v.variableSetID;
  if (!ref) return undefined;
  return doc.resolveVariableRef(ref.guid ? { guid: ref.guid } : ref);
}

export function variableInfo(doc: FigDocument, v: NodeChange): VariableInfo {
  const set = collectionOf(doc, v);
  const modeNames = new Map<string, string>(
    (set?.variableSetModes ?? []).map((m: any) => [guidToString(m.id), m.name as string]),
  );
  const valuesByMode: Record<string, VariableValue> = {};
  for (const e of v.variableDataValues?.entries ?? []) {
    const modeId = guidToString(e.modeID);
    valuesByMode[modeNames.get(modeId) ?? modeId] = rawVariableData(doc, e.variableData);
  }
  const info: VariableInfo = {
    id: guidToString(v.guid),
    key: v.key,
    name: v.name ?? '',
    resolvedType: v.variableResolvedType ?? 'UNKNOWN',
    valuesByMode,
  };
  if (set) {
    info.collectionId = guidToString(set.guid);
    info.collectionName = set.name;
  }
  if (v.description) info.description = v.description;
  if (v.variableScopes) info.scopes = v.variableScopes;
  return info;
}

/**
 * The variable's value in a mode (default: the collection's first mode), following aliases.
 * Returns undefined when it cannot be resolved.
 */
export function resolveVariable(
  doc: FigDocument,
  v: NodeChange,
  modeId?: string,
  depth = 0,
): Exclude<VariableValue, { alias: string }> | undefined {
  if (depth > 16) return undefined;
  const set = collectionOf(doc, v);
  const wanted =
    modeId ?? (set?.variableSetModes?.[0] ? guidToString(set.variableSetModes[0].id) : undefined);
  const entries = v.variableDataValues?.entries ?? [];
  const entry = entries.find((e: any) => guidToString(e.modeID) === wanted) ?? entries[0];
  const val = entry?.variableData?.value;
  if (!val) return undefined;
  if (val.alias) {
    const target = doc.resolveVariableRef(val.alias);
    return target ? resolveVariable(doc, target, undefined, depth + 1) : undefined;
  }
  const raw = rawVariableData(doc, entry.variableData);
  return raw && typeof raw === 'object' && 'alias' in raw ? undefined : raw;
}

/** Human-readable value in the style of Figma MCP's get_variable_defs (colors as hex). */
export function formatValue(v: VariableValue | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    if ('alias' in v) return `var(${v.alias})`;
    return colorToHex(v);
  }
  return String(v);
}

export interface StyleInfo {
  id: string;
  key?: string;
  name: string;
  styleType: string;
  description?: string;
  /** Short description of the value, e.g. "#FF0000" or "Font(family: …)". */
  value: string;
}

const FONT_WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

/** CSS font weight from a font style name ("SemiBold Italic" → 600). */
export function fontWeight(style: string | undefined): number {
  for (const [re, w] of FONT_WEIGHTS) if (re.test(style ?? '')) return w;
  return 400;
}

function formatLineHeight(lh: any): string {
  if (!lh) return 'auto';
  if (lh.units === 'PERCENT') return String(lh.value);
  if (lh.units === 'RAW') return String(Math.round(lh.value * 100));
  return String(lh.value);
}

/** Typography summary as Figma MCP prints text styles. */
export function formatFont(n: NodeChange): string {
  const fam = n.fontName?.family ?? '';
  const style = n.fontName?.style ?? 'Regular';
  const ls = n.letterSpacing?.value ?? 0;
  return `Font(family: "${fam}", style: ${style}, size: ${n.fontSize ?? 0}, weight: ${fontWeight(style)}, lineHeight: ${formatLineHeight(n.lineHeight)}, letterSpacing: ${ls})`;
}

function firstVisiblePaint(paints: any[] | undefined): any {
  return (paints ?? []).find((p) => p.visible !== false);
}

/** Describes a paint list briefly ("#RRGGBB", "linear-gradient(…)", "image"). */
export function formatPaints(paints: any[] | undefined): string {
  const p = firstVisiblePaint(paints);
  if (!p) return '';
  switch (p.type) {
    case 'SOLID':
      return colorToHex(p.color, p.opacity ?? 1);
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      return `${p.type.toLowerCase().replace('gradient_', '')}-gradient(${(p.stops ?? [])
        .map((s: any) => `${colorToHex(s.color)} ${Math.round(s.position * 100)}%`)
        .join(', ')})`;
    case 'IMAGE':
      return 'image';
    default:
      return String(p.type ?? '').toLowerCase();
  }
}

export function formatEffects(effects: any[] | undefined): string {
  return (effects ?? [])
    .filter((e) => e.visible !== false)
    .map((e) => {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        return `${e.type === 'DROP_SHADOW' ? 'DropShadow' : 'InnerShadow'}(color: ${colorToHex(e.color ?? { r: 0, g: 0, b: 0, a: 1 })}, offset: (${e.offset?.x ?? 0}, ${e.offset?.y ?? 0}), radius: ${e.radius ?? 0}, spread: ${e.spread ?? 0})`;
      }
      return `${String(e.type).toLowerCase()}(radius: ${e.radius ?? 0})`;
    })
    .join(', ');
}

export function styleInfo(s: NodeChange): StyleInfo {
  let value = '';
  switch (s.styleType) {
    case 'FILL':
      value = formatPaints(s.fillPaints);
      break;
    case 'TEXT':
      value = formatFont(s);
      break;
    case 'EFFECT':
      value = formatEffects(s.effects);
      break;
    case 'GRID':
      value = `${(s.layoutGrids ?? []).length} grid(s)`;
      break;
  }
  const info: StyleInfo = { id: guidToString(s.guid), name: s.name ?? '', styleType: s.styleType, value };
  if (s.key) info.key = s.key;
  if (s.styleDescription) info.description = s.styleDescription;
  return info;
}
