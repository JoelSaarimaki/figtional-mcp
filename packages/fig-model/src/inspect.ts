/**
 * Plain, JSON-friendly descriptions of nodes, in Plugin API terms. Used by the viewer's inspect
 * panel and by design-context generation.
 */
import { type NodeChange, guidToString, isNullGuid } from '@figtional/fig-format';
import type { FigDocument, SceneNode } from './document.js';
import { rotationDegrees } from './matrix.js';
import { stackProps } from './layout.js';
import { colorToHex, fontWeight, formatValue, resolveVariable, styleInfo } from './values.js';

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface PaintInfo {
  type: string;
  value: string;
  opacity?: number;
  visible: boolean;
  blendMode?: string;
  variable?: string;
  imageHash?: string;
  scaleMode?: string;
}

export function paintInfo(doc: FigDocument, p: any): PaintInfo {
  const out: PaintInfo = { type: p.type, value: '', visible: p.visible !== false };
  if (p.opacity !== undefined && p.opacity !== 1) out.opacity = r2(p.opacity);
  if (p.blendMode && p.blendMode !== 'NORMAL') out.blendMode = p.blendMode;
  if (p.type === 'SOLID') out.value = colorToHex(p.color);
  else if (p.type?.startsWith('GRADIENT')) {
    out.value = (p.stops ?? [])
      .map((s: any) => `${colorToHex(s.color)} ${Math.round(s.position * 100)}%`)
      .join(', ');
  } else if (p.type === 'IMAGE' && p.image?.hash) {
    out.imageHash = Buffer.from(p.image.hash).toString('hex');
    out.scaleMode = { STRETCH: 'CROP' }[p.imageScaleMode as string] ?? p.imageScaleMode ?? 'FILL';
    out.value = 'image';
  }
  const alias = p.colorVar?.value?.alias;
  if (alias) {
    const v = doc.resolveVariableRef(alias);
    if (v) out.variable = v.name;
  }
  return out;
}

export interface NodeInspection {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked?: boolean;
  page?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  absoluteX: number;
  absoluteY: number;
  rotation?: number;
  opacity?: number;
  blendMode?: string;
  cornerRadius?: number | [number, number, number, number];
  clipsContent?: boolean;
  fills: PaintInfo[];
  strokes: PaintInfo[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects: string[];
  layout?: Record<string, unknown>;
  layoutChild?: Record<string, unknown>;
  text?: Record<string, unknown>;
  component?: Record<string, unknown>;
  styles: Record<string, string>;
  boundVariables: Record<string, string>;
  prototype?: { trigger: string; action: string; destination?: string; transition?: string }[];
  childCount: number;
}

const STYLE_FIELDS: Record<string, string> = {
  styleIdForFill: 'fill',
  styleIdForStrokeFill: 'stroke',
  styleIdForText: 'text',
  styleIdForEffect: 'effect',
  styleIdForGrid: 'grid',
};

const SIZING = (hug: boolean) => (hug ? 'HUG' : 'FIXED');

export function inspectNode(doc: FigDocument, n: SceneNode): NodeInspection {
  const d = n.data;
  const t = n.relativeTransform;
  const abs = n.absoluteBoundingBox;
  const out: NodeInspection = {
    id: n.id,
    name: n.name,
    type: n.type,
    visible: n.visible,
    x: r2(t.m02),
    y: r2(t.m12),
    width: r2(n.width),
    height: r2(n.height),
    absoluteX: r2(abs.x),
    absoluteY: r2(abs.y),
    fills: (d.fillPaints ?? []).map((p: any) => paintInfo(doc, p)),
    strokes: (d.strokePaints ?? []).map((p: any) => paintInfo(doc, p)),
    effects: (d.effects ?? [])
      .filter((e: any) => e.visible !== false)
      .map((e: any) =>
        e.type.endsWith('SHADOW')
          ? `${e.type} ${colorToHex(e.color)} x${r2(e.offset?.x ?? 0)} y${r2(e.offset?.y ?? 0)} blur ${r2(e.radius ?? 0)} spread ${r2(e.spread ?? 0)}`
          : `${e.type} ${r2(e.radius ?? 0)}`,
      ),
    styles: {},
    boundVariables: {},
    childCount: n.children.length,
  };
  if (d.locked) out.locked = true;
  if (n.page) out.page = n.page.name;
  const rot = rotationDegrees(t);
  if (rot) out.rotation = r2(rot);
  if (d.opacity !== undefined && d.opacity !== 1) out.opacity = r2(d.opacity);
  if (d.blendMode && d.blendMode !== 'PASS_THROUGH' && d.blendMode !== 'NORMAL') out.blendMode = d.blendMode;
  if (d.rectangleCornerRadiiIndependent) {
    out.cornerRadius = [
      d.rectangleTopLeftCornerRadius ?? 0,
      d.rectangleTopRightCornerRadius ?? 0,
      d.rectangleBottomRightCornerRadius ?? 0,
      d.rectangleBottomLeftCornerRadius ?? 0,
    ];
  } else if (d.cornerRadius) out.cornerRadius = r2(d.cornerRadius);
  if (['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(n.type))
    out.clipsContent = d.frameMaskDisabled !== true;
  if ((d.strokePaints ?? []).length) {
    out.strokeWeight = r2(d.strokeWeight ?? 1);
    out.strokeAlign = d.strokeAlign ?? 'CENTER';
  }

  const sp = stackProps(d);
  if (sp) {
    out.layout = {
      layoutMode: sp.horizontal ? 'HORIZONTAL' : 'VERTICAL',
      primaryAxisSizingMode: sp.primaryHug ? 'AUTO' : 'FIXED',
      counterAxisSizingMode: sp.counterHug ? 'AUTO' : 'FIXED',
      itemSpacing: sp.autoSpacing ? 'AUTO' : sp.spacing,
      padding: [
        d.stackVerticalPadding ?? 0,
        d.stackPaddingRight ?? d.stackHorizontalPadding ?? 0,
        d.stackPaddingBottom ?? d.stackVerticalPadding ?? 0,
        d.stackHorizontalPadding ?? 0,
      ],
      primaryAxisAlignItems: sp.autoSpacing ? 'SPACE_BETWEEN' : sp.justify,
      counterAxisAlignItems: sp.align,
      layoutWrap: sp.wrap ? 'WRAP' : 'NO_WRAP',
      strokesIncludedInLayout: d.bordersTakeSpace === true,
    };
  }
  const parentStack = n.parent ? stackProps(n.parent.data) : undefined;
  if (parentStack) {
    const H = parentStack.horizontal;
    const grow = (d.stackChildPrimaryGrow ?? 0) > 0;
    const stretch = d.stackChildAlignSelf === 'STRETCH';
    const own = stackProps(d);
    const hugH = own
      ? own.horizontal
        ? own.primaryHug
        : own.counterHug
      : d.textAutoResize === 'WIDTH_AND_HEIGHT';
    const hugV = own
      ? own.horizontal
        ? own.counterHug
        : own.primaryHug
      : d.textAutoResize === 'HEIGHT' || d.textAutoResize === 'WIDTH_AND_HEIGHT';
    out.layoutChild = {
      layoutPositioning: d.stackPositioning === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO',
      layoutSizingHorizontal: (H ? grow : stretch) ? 'FILL' : SIZING(hugH),
      layoutSizingVertical: (H ? stretch : grow) ? 'FILL' : SIZING(hugV),
    };
    if (d.minSize?.value) out.layoutChild.min = d.minSize.value;
    if (d.maxSize?.value) out.layoutChild.max = d.maxSize.value;
  }

  if (d.type === 'TEXT') {
    out.text = {
      characters: d.textData?.characters ?? '',
      fontFamily: d.fontName?.family,
      fontStyle: d.fontName?.style,
      fontWeight: fontWeight(d.fontName?.style),
      fontSize: d.fontSize,
      lineHeight: d.lineHeight
        ? `${r2(d.lineHeight.value)}${d.lineHeight.units === 'PERCENT' ? '%' : d.lineHeight.units === 'PIXELS' ? 'px' : ''}`
        : 'auto',
      letterSpacing: d.letterSpacing
        ? `${r2(d.letterSpacing.value)}${d.letterSpacing.units === 'PERCENT' ? '%' : 'px'}`
        : '0',
      textAlignHorizontal: d.textAlignHorizontal ?? 'LEFT',
      textAlignVertical: d.textAlignVertical ?? 'TOP',
      textAutoResize: d.textAutoResize ?? 'NONE',
      textCase: d.textCase,
      textDecoration: d.textDecoration,
      mixedStyles: (d.textData?.styleOverrideTable ?? []).length > 0,
    };
  }

  if (n.type === 'INSTANCE') {
    const main = n.mainComponent;
    const set = main?.parent?.type === 'COMPONENT_SET' ? main.parent : undefined;
    out.component = {
      mainComponent: main ? { id: main.id, name: main.name } : null,
      componentSet: set ? { id: set.id, name: set.name } : undefined,
      missing: !main,
      fromLibrary: !!main?.data.sourceLibraryKey,
      properties: instanceProperties(doc, n),
    };
  } else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
    out.component = {
      key: d.componentKey ?? d.key,
      description: d.description ?? '',
      properties: (d.componentPropDefs ?? []).map((p: any) => ({ name: p.name, type: p.type })),
    };
  }

  for (const [field, label] of Object.entries(STYLE_FIELDS)) {
    const s = doc.resolveStyleRef(d[field]);
    if (s) out.styles[label] = styleInfo(s).name;
  }
  for (const e of d.variableConsumptionMap?.entries ?? []) {
    const v = e.variableData?.value?.alias ? doc.resolveVariableRef(e.variableData.value.alias) : undefined;
    if (v) out.boundVariables[e.variableField] = `${v.name} = ${formatValue(resolveVariable(doc, v))}`;
  }
  for (const [i, p] of (d.fillPaints ?? []).entries()) {
    const v = p.colorVar?.value?.alias ? doc.resolveVariableRef(p.colorVar.value.alias) : undefined;
    if (v) out.boundVariables[`fills[${i}]`] = `${v.name} = ${formatValue(resolveVariable(doc, v))}`;
  }

  const proto = prototypeInteractions(d);
  if (proto.length) {
    out.prototype = proto.map((it) => ({
      trigger: it.trigger,
      action: it.action,
      destination: it.destinationId
        ? (doc.getNodeById(it.destinationId)?.name ?? it.destinationId)
        : undefined,
      transition: it.transition,
    }));
  }
  return out;
}

function instanceProperties(doc: FigDocument, n: SceneNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const main = n.mainComponent;
  const names = new Map<string, string>();
  for (const src of [main?.data, main?.parent?.data]) {
    for (const def of src?.componentPropDefs ?? []) {
      if (def.id && def.name) names.set(guidToString(def.id), def.name);
    }
  }
  for (const a of n.data.componentPropAssignments ?? []) {
    const name = names.get(guidToString(a.defID)) ?? guidToString(a.defID);
    const v = a.value ?? {};
    out[name] =
      v.textValue?.characters ?? v.boolValue ?? (v.guidValue ? guidToString(v.guidValue) : undefined);
  }
  // Variant properties come from the component's name ("Prop=Value, Prop2=Value").
  if (main?.parent?.type === 'COMPONENT_SET') {
    for (const part of main.name.split(',')) {
      const [k, val] = part.split('=').map((s) => s.trim());
      if (k && val !== undefined) out[k] = val;
    }
  }
  return out;
}

export interface Interaction {
  trigger: string;
  action: string;
  destinationId?: string;
  transition?: string;
  overlayPosition?: string;
  preserveScroll?: boolean;
}

/** Prototype interactions of a node: modern `prototypeInteractions` first, legacy flat fields as fallback. */
export function prototypeInteractions(d: NodeChange): Interaction[] {
  const out: Interaction[] = [];
  const list = d.prototypeInteractions?.length
    ? d.prototypeInteractions
    : d.transitionNodeID || d.connectionType
      ? [
          {
            event: { interactionType: d.interactionType },
            actions: [
              {
                transitionNodeID: d.transitionNodeID,
                connectionType: d.connectionType,
                navigationType: d.navigationType,
                transitionType: d.transitionType,
                transitionDuration: d.transitionDuration,
                transitionPreserveScroll: d.transitionPreserveScroll,
              },
            ],
          },
        ]
      : [];
  for (const it of list) {
    if (it.isDeleted) continue;
    const trigger = it.event?.interactionType ?? 'NONE';
    if (trigger === 'NONE') continue;
    for (const a of it.actions ?? []) {
      const conn = a.connectionType ?? 'NONE';
      if (conn === 'NONE') continue;
      const dest =
        a.transitionNodeID && !isNullGuid(a.transitionNodeID) ? guidToString(a.transitionNodeID) : undefined;
      const action =
        conn === 'CLOSE'
          ? 'CLOSE'
          : conn === 'BACK'
            ? 'BACK'
            : conn === 'URL'
              ? 'URL'
              : a.navigationType === 'OVERLAY'
                ? 'OPEN_OVERLAY'
                : a.navigationType === 'SWAP'
                  ? 'SWAP_OVERLAY'
                  : a.navigationType === 'SCROLL_TO'
                    ? 'SCROLL_TO'
                    : 'NAVIGATE';
      const i: Interaction = { trigger, action };
      if (dest) i.destinationId = dest;
      if (a.transitionType)
        i.transition = `${a.transitionType}${a.transitionDuration ? ` ${Math.round(a.transitionDuration * 1000)}ms` : ''}`;
      if (a.transitionPreserveScroll) i.preserveScroll = true;
      out.push(i);
    }
  }
  return out;
}

export interface FlowInfo {
  name: string;
  startNodeId: string;
  description?: string;
}

/** Prototype flows of a page: named starting points (modern) or the page's start node (legacy). */
export function prototypeFlows(page: SceneNode): FlowInfo[] {
  const flows: (FlowInfo & { pos: string })[] = [];
  for (const c of page.children) {
    const sp = c.data.prototypeStartingPoint;
    if (sp?.name !== undefined)
      flows.push({
        name: sp.name || c.name,
        startNodeId: c.id,
        description: sp.description || undefined,
        pos: sp.position ?? '',
      });
  }
  flows.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
  const legacy = page.data.prototypeStartNodeID;
  if (!flows.length && legacy && !isNullGuid(legacy)) {
    return [{ name: 'Flow 1', startNodeId: guidToString(legacy) }];
  }
  return flows.map(({ pos: _pos, ...f }) => f);
}

/** The page's prototype device (legacy pages store it; default: the start frame's size). */
export function prototypeDevice(
  page: SceneNode,
): { width: number; height: number; preset?: string } | undefined {
  const dev = page.data.prototypeDevice;
  if (dev?.size) return { width: dev.size.x, height: dev.size.y, preset: dev.presetIdentifier };
  return undefined;
}
