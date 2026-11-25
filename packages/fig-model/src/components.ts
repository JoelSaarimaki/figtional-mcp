/**
 * Components: component sets (variants), component properties, property bindings, instance
 * property values and detaching. Formats verified against the reference files
 * (docs/fig-format.md §4.8):
 *
 * - Set: FRAME with `isStateGroup`, all property definitions in `componentPropDefs`, and
 *   `stateGroupPropertyValueOrders` [{ property, values[] }].
 * - Variant: SYMBOL named "Prop=Value, Prop2=Value" with `variantPropSpecs` [{ propDefId, value }]
 *   and stub definitions { id, parentPropDefId } for the set's non-variant properties.
 * - Binding: `componentPropRefs` [{ defID, componentPropNodeField }] plus the same in
 *   `parameterConsumptionMap` (PROP_REF entries).
 * - Instance values: `componentPropAssignments` [{ defID, value, varValue }].
 */
import { type GUID, type NodeChange, guidToString, isNullGuid } from '@figtional/fig-format';
import type { FigDocument, SceneNode } from './document.js';
import type { EditSession } from './edit.js';
import { keyBetween } from './fractional-index.js';

export type PropType = 'TEXT' | 'BOOLEAN' | 'INSTANCE_SWAP' | 'VARIANT';

/** Fields an instance takes from its main component when created or swapped. */
export const INSTANCE_FIELDS = [
  'size',
  'fillPaints',
  'strokePaints',
  'strokeWeight',
  'strokeAlign',
  'cornerRadius',
  'rectangleCornerRadiiIndependent',
  'rectangleTopLeftCornerRadius',
  'rectangleTopRightCornerRadius',
  'rectangleBottomLeftCornerRadius',
  'rectangleBottomRightCornerRadius',
  'frameMaskDisabled',
  'stackMode',
  'stackSpacing',
  'stackHorizontalPadding',
  'stackVerticalPadding',
  'stackPaddingRight',
  'stackPaddingBottom',
  'stackPrimarySizing',
  'stackCounterSizing',
  'stackPrimaryAlignItems',
  'stackCounterAlignItems',
  'stackWrap',
  'bordersTakeSpace',
  'effects',
];

/** Copies the component's own fields onto an instance (missing ones are removed). */
export function copyInstanceFields(target: NodeChange, from: NodeChange): void {
  for (const f of INSTANCE_FIELDS) {
    if (from[f] !== undefined) target[f] = structuredClone(from[f]);
    else delete target[f];
  }
}

/** Plugin API property type ↔ .fig ComponentPropType. */
const TO_FIG: Record<PropType, string> = {
  TEXT: 'TEXT',
  BOOLEAN: 'BOOL',
  INSTANCE_SWAP: 'INSTANCE_SWAP',
  VARIANT: 'VARIANT',
};
const FROM_FIG: Record<string, PropType> = {
  TEXT: 'TEXT',
  BOOL: 'BOOLEAN',
  INSTANCE_SWAP: 'INSTANCE_SWAP',
  VARIANT: 'VARIANT',
};

/** Plugin API key of a property: variant properties use their name, others "Name#id". */
export const propKey = (def: { name: string; id: GUID; type: string }) =>
  def.type === 'VARIANT' ? def.name : `${def.name}#${guidToString(def.id)}`;

export function textDataOf(characters: string) {
  return {
    characters,
    lines: characters.split('\n').map(() => ({
      lineType: 'PLAIN',
      styleId: 0,
      indentationLevel: 0,
      sourceDirectionality: 'AUTO',
      listStartOffset: 0,
      isFirstLineOfList: false,
    })),
  };
}

/** `value` + `varValue` of a definition default or an instance assignment. */
export function propValue(type: string, v: unknown): { value: any; varValue: any } {
  switch (type) {
    case 'TEXT': {
      const td = textDataOf(String(v ?? ''));
      return {
        value: { textValue: td },
        varValue: { value: { textDataValue: td }, dataType: 'TEXT_DATA', resolvedDataType: 'TEXT_DATA' },
      };
    }
    case 'BOOL':
      return {
        value: { boolValue: !!v },
        varValue: { value: { boolValue: !!v }, dataType: 'BOOLEAN', resolvedDataType: 'BOOLEAN' },
      };
    case 'INSTANCE_SWAP': {
      const g = v as GUID;
      return {
        value: { guidValue: { ...g } },
        varValue: {
          value: { symbolIdValue: { guid: { ...g } } },
          dataType: 'SYMBOL_ID',
          resolvedDataType: 'SYMBOL_ID',
        },
      };
    }
    default:
      return {
        value: { textValue: { characters: '' } },
        varValue: { value: { textValue: '' }, dataType: 'STRING', resolvedDataType: 'STRING' },
      };
  }
}

/** Plain value of a ComponentPropValue for the Plugin API. */
export function plainValue(type: string, value: any): unknown {
  if (!value) return undefined;
  if (type === 'TEXT') return value.textValue?.characters ?? '';
  if (type === 'BOOL') return value.boolValue === true;
  if (type === 'INSTANCE_SWAP')
    return value.guidValue && !isNullGuid(value.guidValue) ? guidToString(value.guidValue) : null;
  return value.textValue?.characters ?? '';
}

export const isComponentSet = (n: NodeChange | undefined) => n?.type === 'FRAME' && n.isStateGroup === true;

/** Parses a variant name "A=1, B=2" into [[A, 1], [B, 2]]; other names become Property 1=name. */
export function parseVariantName(name: string): [string, string][] {
  const parts = name.split(',').map((p) => p.trim());
  if (parts.length && parts.every((p) => /^[^=]+=.*$/.test(p))) {
    return parts.map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
  }
  return [['Property 1', name.trim()]];
}

export const variantName = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${v}`).join(', ');

/** The node that owns property definitions for `component` (its set, or itself). */
export function definitionOwner(doc: FigDocument, component: NodeChange): NodeChange {
  const parent = component.parentIndex ? doc.nodes.get(guidToString(component.parentIndex.guid)) : undefined;
  return isComponentSet(parent) ? parent! : component;
}

/** Live property definitions of a component or set (stubs and deleted ones excluded). */
export function propertyDefinitions(owner: NodeChange): any[] {
  return (owner.componentPropDefs ?? []).filter(
    (d: any) => d.name !== undefined && d.type !== undefined && !d.isDeleted,
  );
}

/**
 * Instance values (`componentPropAssignments`) of a variant are keyed by that variant's own
 * definition stub `{ id, parentPropDefId }`, never by the set's definition: verified on every such
 * instance in the references (4,394 of them), and Figma ignores set-level keys on import. This
 * re-keys values given by set definition, or by the stub of the variant the instance used before a
 * variant switch, to the stubs of `variant`. Values of plain components are returned unchanged.
 */
export function keyAssignmentsToVariant(
  assignments: any[],
  previous: NodeChange,
  variant: NodeChange,
): any[] {
  const stubOf = new Map<string, any>(); // set definition id → stub id of `variant`
  for (const d of variant.componentPropDefs ?? [])
    if (d.parentPropDefId) stubOf.set(guidToString(d.parentPropDefId), d.id);
  if (!stubOf.size) return assignments;
  const parentOf = new Map<string, string>(); // stub id (old or new variant) → set definition id
  for (const c of [previous, variant])
    for (const d of c.componentPropDefs ?? [])
      if (d.parentPropDefId) parentOf.set(guidToString(d.id), guidToString(d.parentPropDefId));
  const out = new Map<string, any>();
  for (const a of assignments) {
    const id = guidToString(a.defID);
    const stub = stubOf.get(parentOf.get(id) ?? id);
    const entry = stub ? { ...a, defID: { ...stub } } : a;
    out.set(guidToString(entry.defID), entry); // later values win
  }
  return [...out.values()];
}

function nextSort(defs: any[]): string {
  const last = defs
    .map((d) => d.sortPosition as string | undefined)
    .filter(Boolean)
    .sort()
    .pop();
  return keyBetween(last, undefined) ?? `${last ?? ''}P`;
}

export class ComponentOps {
  constructor(
    readonly doc: FigDocument,
    readonly session: EditSession,
  ) {}

  private variants(set: NodeChange): NodeChange[] {
    return this.doc.rawChildren(guidToString(set.guid)).filter((c) => c.type === 'SYMBOL');
  }

  /** figma.combineAsVariants: wraps components in a new component set inside `parentId`. */
  combineAsVariants(componentIds: string[], parentId: string, index?: number): NodeChange {
    if (!componentIds.length) throw new Error('combineAsVariants requires at least one component');
    const comps = componentIds.map((id) => this.session.raw(id));
    for (const c of comps) {
      if (c.type !== 'SYMBOL') throw new Error('combineAsVariants: all nodes must be components');
      const parent = c.parentIndex ? this.doc.nodes.get(guidToString(c.parentIndex.guid)) : undefined;
      if (isComponentSet(parent)) throw new Error('combineAsVariants: a component is already a variant');
    }
    // Bounding box of the components in the new parent's space (they keep their positions).
    const xs = comps.map((c) => c.transform?.m02 ?? 0);
    const ys = comps.map((c) => c.transform?.m12 ?? 0);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const x1 = Math.max(...comps.map((c, i) => xs[i]! + (c.size?.x ?? 0)));
    const y1 = Math.max(...comps.map((c, i) => ys[i]! + (c.size?.y ?? 0)));
    const names = comps.map((c) => parseVariantName(c.name ?? ''));
    const propNames: string[] = [];
    for (const pairs of names) for (const [k] of pairs) if (!propNames.includes(k)) propNames.push(k);
    const defs = propNames.map((name, i) => {
      const { value, varValue } = propValue('VARIANT', '');
      return {
        id: this.session.newGuid(),
        name,
        initialValue: value,
        sortPosition: `!_${i}`,
        type: 'VARIANT',
        preferredValues: {},
        varValue,
      };
    });
    const set = this.session.create('FRAME', parentId, index, {
      name: comps.length === 1 ? (comps[0]!.name ?? 'Component') : 'Component 1',
      visible: true,
      opacity: 1,
      size: { x: Math.max(1, x1 - x0), y: Math.max(1, y1 - y0) },
      transform: { m00: 1, m01: 0, m02: x0, m10: 0, m11: 1, m12: y0 },
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      frameMaskDisabled: false,
      isStateGroup: true,
      componentPropDefs: defs,
      stateGroupPropertyValueOrders: propNames.map((p) => ({
        property: p,
        values: [...new Set(names.map((pairs) => pairs.find(([k]) => k === p)?.[1] ?? ''))],
      })),
    });
    const setId = guidToString(set.guid);
    const pendingRefs: [NodeChange, Map<string, any>][] = [];
    comps.forEach((c, i) => {
      const id = guidToString(c.guid);
      this.session.move(id, setId);
      const pairs = new Map(names[i]);
      const full: [string, string][] = propNames.map((p) => [p, pairs.get(p) ?? '']);
      c.name = variantName(full);
      c.variantPropSpecs = defs.map((d) => ({ propDefId: { ...d.id }, value: pairs.get(d.name) ?? '' }));
      if (c.transform) {
        c.transform.m02 -= x0;
        c.transform.m12 -= y0;
      }
      // Non-variant properties move to the set (same name and type are merged, as in Figma).
      const own = propertyDefinitions(c).filter((d) => d.type !== 'VARIANT');
      const map = new Map<string, any>();
      for (const d of own) {
        let setDef = set.componentPropDefs.find((x: any) => x.name === d.name && x.type === d.type);
        if (!setDef) {
          setDef = { ...structuredClone(d), id: this.session.newGuid() };
          set.componentPropDefs = [...set.componentPropDefs, setDef];
        }
        map.set(guidToString(d.id), setDef);
      }
      c.componentPropDefs = [];
      pendingRefs.push([c, map]);
      this.session.markDirty(id);
    });
    // Every variant gets a stub per set-level property; layers point at their variant's stub.
    const setProps = (set.componentPropDefs as any[]).filter((d) => d.type !== 'VARIANT');
    for (const [c, map] of pendingRefs) {
      const stubs = setProps.map((d) => ({ id: this.session.newGuid(), parentPropDefId: { ...d.id } }));
      c.componentPropDefs = stubs;
      const remap = new Map<string, GUID>();
      for (const [oldId, setDef] of map) {
        const stub = stubs.find((s) => guidToString(s.parentPropDefId) === guidToString(setDef.id))!;
        remap.set(oldId, stub.id);
      }
      this.remapRefs(c, remap);
    }
    this.doc.reindex();
    return set;
  }

  /** Points bindings inside `root` from old definition ids to new ones. */
  private remapRefs(root: NodeChange, map: Map<string, GUID>): void {
    const visit = (n: NodeChange) => {
      for (const r of n.componentPropRefs ?? []) {
        const to = r.defID && map.get(guidToString(r.defID));
        if (to) r.defID = { ...to };
      }
      for (const e of n.parameterConsumptionMap?.entries ?? []) {
        const ref = e.variableData?.value?.propRefValue;
        const to = ref?.defId && map.get(guidToString(ref.defId));
        if (to) ref.defId = { ...to };
      }
      for (const c of this.doc.rawChildren(guidToString(n.guid))) visit(c);
    };
    visit(root);
  }

  /** component.addComponentProperty: returns the Plugin API key ("Name#id" or the variant name). */
  addProperty(
    ownerId: string,
    name: string,
    type: PropType,
    defaultValue: unknown,
    preferred?: { type: string; key: string }[],
  ): string {
    const owner = this.session.raw(ownerId);
    this.requireDefinitionOwner(owner);
    const figType = TO_FIG[type];
    if (!figType) throw new Error(`Invalid component property type "${type}"`);
    const defs = propertyDefinitions(owner);
    if (defs.some((d) => d.name === name && (type !== 'VARIANT' || d.type === 'VARIANT'))) {
      if (type === 'VARIANT') throw new Error(`Property "${name}" already exists`);
    }
    if (type === 'VARIANT' && !isComponentSet(owner))
      throw new Error('Variant properties can only be added to a component set');
    let initial: unknown = defaultValue;
    if (type === 'INSTANCE_SWAP') {
      const target = this.session.raw(String(defaultValue));
      if (target.type !== 'SYMBOL')
        throw new Error('The default value of an INSTANCE_SWAP property must be a component id');
      initial = target.guid;
    }
    const { value, varValue } = propValue(figType, initial);
    const def: any = {
      id: this.session.newGuid(),
      name,
      initialValue: value,
      sortPosition: nextSort(owner.componentPropDefs ?? []),
      type: figType,
      preferredValues:
        type === 'INSTANCE_SWAP'
          ? { instanceSwapValues: (preferred ?? []).map((p) => ({ type: p.type, key: p.key })) }
          : {},
      varValue,
    };
    owner.componentPropDefs = [...(owner.componentPropDefs ?? []), def];
    if (isComponentSet(owner)) {
      for (const v of this.variants(owner)) {
        if (type === 'VARIANT') {
          v.variantPropSpecs = [
            ...(v.variantPropSpecs ?? []),
            { propDefId: { ...def.id }, value: String(defaultValue ?? '') },
          ];
          v.name = variantName([...parseVariantName(v.name ?? ''), [name, String(defaultValue ?? '')]]);
        } else {
          v.componentPropDefs = [
            ...(v.componentPropDefs ?? []),
            { id: this.session.newGuid(), parentPropDefId: { ...def.id } },
          ];
        }
        this.session.markDirty(guidToString(v.guid));
      }
      if (type === 'VARIANT') {
        owner.stateGroupPropertyValueOrders = [
          ...(owner.stateGroupPropertyValueOrders ?? []),
          { property: name, values: [String(defaultValue ?? '')] },
        ];
      }
    }
    this.session.markDirty(ownerId);
    return propKey(def);
  }

  editProperty(ownerId: string, key: string, changes: { name?: string; defaultValue?: unknown }): string {
    const owner = this.session.raw(ownerId);
    this.requireDefinitionOwner(owner);
    const def = this.findDef(owner, key);
    if (changes.name !== undefined) {
      const old = def.name;
      def.name = String(changes.name);
      if (def.type === 'VARIANT') {
        for (const v of this.variants(owner)) {
          v.name = variantName(
            parseVariantName(v.name ?? '').map(([k, val]) => [k === old ? def.name : k, val]),
          );
        }
        for (const o of owner.stateGroupPropertyValueOrders ?? [])
          if (o.property === old) o.property = def.name;
      }
    }
    if (changes.defaultValue !== undefined && def.type !== 'VARIANT') {
      const v =
        def.type === 'INSTANCE_SWAP'
          ? this.session.raw(String(changes.defaultValue)).guid
          : changes.defaultValue;
      const { value, varValue } = propValue(def.type, v);
      def.initialValue = value;
      def.varValue = varValue;
    }
    this.session.markDirty(ownerId);
    return propKey(def);
  }

  deleteProperty(ownerId: string, key: string): void {
    const owner = this.session.raw(ownerId);
    this.requireDefinitionOwner(owner);
    const def = this.findDef(owner, key);
    if (def.type === 'VARIANT')
      throw new Error('Deleting variant properties is not supported; rename the variants instead');
    const id = guidToString(def.id);
    owner.componentPropDefs = (owner.componentPropDefs ?? []).filter((d: any) => d !== def);
    const stubIds = new Set<string>([id]);
    for (const v of isComponentSet(owner) ? this.variants(owner) : []) {
      const stubs = (v.componentPropDefs ?? []).filter(
        (d: any) => d.parentPropDefId && guidToString(d.parentPropDefId) === id,
      );
      for (const s of stubs) stubIds.add(guidToString(s.id));
      v.componentPropDefs = (v.componentPropDefs ?? []).filter((d: any) => !stubs.includes(d));
    }
    // Unbind layers that used it.
    const roots = isComponentSet(owner) ? this.variants(owner) : [owner];
    const visit = (n: NodeChange) => {
      if (n.componentPropRefs)
        n.componentPropRefs = n.componentPropRefs.filter((r: any) => !stubIds.has(guidToString(r.defID)));
      if (n.parameterConsumptionMap?.entries) {
        n.parameterConsumptionMap.entries = n.parameterConsumptionMap.entries.filter(
          (e: any) =>
            !(
              e.variableData?.value?.propRefValue?.defId &&
              stubIds.has(guidToString(e.variableData.value.propRefValue.defId))
            ),
        );
      }
      for (const c of this.doc.rawChildren(guidToString(n.guid))) visit(c);
    };
    roots.forEach(visit);
    this.session.markDirty(ownerId);
  }

  /** Binds a layer inside a component to a property: field = 'characters' | 'visible' | 'mainComponent'. */
  bindProperty(nodeId: string, field: 'characters' | 'visible' | 'mainComponent', key: string | null): void {
    const node = this.session.raw(nodeId);
    const component = this.containingComponent(node);
    if (!component)
      throw new Error('componentPropertyReferences can only be set on layers inside a component');
    const owner = definitionOwner(this.doc, component);
    const nodeField = { characters: 'TEXT_DATA', visible: 'VISIBLE', mainComponent: 'OVERRIDDEN_SYMBOL_ID' }[
      field
    ];
    const resolved = { characters: 'TEXT_DATA', visible: 'BOOLEAN', mainComponent: 'SYMBOL_ID' }[field];
    if (field === 'characters' && node.type !== 'TEXT')
      throw new Error('characters can only be bound on text layers');
    if (field === 'mainComponent' && node.type !== 'INSTANCE')
      throw new Error('mainComponent can only be bound on instances');
    node.componentPropRefs = (node.componentPropRefs ?? []).filter(
      (r: any) => r.componentPropNodeField !== nodeField,
    );
    if (node.parameterConsumptionMap?.entries) {
      node.parameterConsumptionMap.entries = node.parameterConsumptionMap.entries.filter(
        (e: any) => e.variableField !== nodeField,
      );
    }
    if (key !== null) {
      const def = this.findDef(owner, key);
      const expected = { characters: 'TEXT', visible: 'BOOL', mainComponent: 'INSTANCE_SWAP' }[field];
      if (def.type !== expected)
        throw new Error(`Property "${def.name}" is ${FROM_FIG[def.type]}, not ${FROM_FIG[expected]}`);
      // Inside a variant, layers point at the variant's stub of the set-level definition.
      let refId: GUID = def.id;
      if (owner !== component) {
        const stub = (component.componentPropDefs ?? []).find(
          (d: any) => d.parentPropDefId && guidToString(d.parentPropDefId) === guidToString(def.id),
        );
        if (stub) refId = stub.id;
      }
      node.componentPropRefs = [
        ...(node.componentPropRefs ?? []),
        { defID: { ...refId }, componentPropNodeField: nodeField },
      ];
      const entries = node.parameterConsumptionMap?.entries ?? [];
      entries.push({
        variableData: {
          value: { propRefValue: { defId: { ...refId } } },
          dataType: 'PROP_REF',
          resolvedDataType: resolved,
        },
        variableField: nodeField,
      });
      node.parameterConsumptionMap = { entries };
    }
    if (!node.componentPropRefs.length) delete node.componentPropRefs;
    if (node.parameterConsumptionMap && !node.parameterConsumptionMap.entries.length)
      delete node.parameterConsumptionMap;
    this.session.markDirty(nodeId);
  }

  /** The keys a layer is bound to (componentPropertyReferences). */
  references(node: NodeChange): Record<string, string> {
    const out: Record<string, string> = {};
    const component = this.containingComponent(node);
    if (!component) return out;
    const owner = definitionOwner(this.doc, component);
    const defs = propertyDefinitions(owner);
    const stubs = new Map<string, string>(
      (component.componentPropDefs ?? [])
        .filter((d: any) => d.parentPropDefId)
        .map((d: any) => [guidToString(d.id), guidToString(d.parentPropDefId)]),
    );
    const field = {
      TEXT_DATA: 'characters',
      VISIBLE: 'visible',
      OVERRIDDEN_SYMBOL_ID: 'mainComponent',
    } as Record<string, string>;
    for (const r of node.componentPropRefs ?? []) {
      if (r.isDeleted || !field[r.componentPropNodeField]) continue;
      const id = guidToString(r.defID);
      const def = defs.find((d) => guidToString(d.id) === (stubs.get(id) ?? id));
      if (def) out[field[r.componentPropNodeField]!] = propKey(def);
    }
    return out;
  }

  /** instance.componentProperties: { key: { type, value } } including variant properties. */
  instanceProperties(
    inst: SceneNode,
  ): Record<string, { type: PropType; value: unknown; preferredValues?: unknown }> {
    const out: Record<string, { type: PropType; value: unknown }> = {};
    const main = inst.mainComponent;
    if (!main) return out;
    const owner = definitionOwner(this.doc, main.data);
    const assigned = new Map<string, any>(
      (inst.data.componentPropAssignments ?? []).map((a: any) => [guidToString(a.defID), a.value]),
    );
    const stubToDef = new Map<string, string>(
      (main.data.componentPropDefs ?? [])
        .filter((d: any) => d.parentPropDefId)
        .map((d: any) => [guidToString(d.id), guidToString(d.parentPropDefId)]),
    );
    for (const [stub, def] of stubToDef)
      if (assigned.has(stub) && !assigned.has(def)) assigned.set(def, assigned.get(stub));
    const variantValues = new Map(parseVariantName(main.name));
    for (const def of propertyDefinitions(owner)) {
      const type = FROM_FIG[def.type];
      if (!type) continue;
      const value =
        def.type === 'VARIANT'
          ? (variantValues.get(def.name) ?? '')
          : plainValue(def.type, assigned.get(guidToString(def.id)) ?? def.initialValue);
      out[propKey(def)] = { type, value };
    }
    return out;
  }

  /** instance.setProperties. Variant values swap to the matching variant. */
  setInstanceProperties(
    inst: SceneNode,
    props: Record<string, unknown>,
    setOverride: (fields: Record<string, unknown>) => void,
  ): void {
    const main = inst.mainComponent;
    if (!main) throw new Error('This instance has no main component in the file');
    const owner = definitionOwner(this.doc, main.data);
    const defs = propertyDefinitions(owner);
    const variantChanges = new Map<string, string>();
    const assignments: any[] = [...(inst.data.componentPropAssignments ?? [])];
    for (const [key, raw] of Object.entries(props)) {
      const def =
        defs.find((d) => propKey(d) === key) ?? defs.find((d) => d.type === 'VARIANT' && d.name === key);
      if (!def) throw new Error(`Property "${key}" not found`);
      if (def.type === 'VARIANT') {
        variantChanges.set(def.name, String(raw));
        continue;
      }
      let v: unknown = raw;
      if (def.type === 'INSTANCE_SWAP') {
        const target = this.doc.getNodeById(String(raw));
        if (target?.figType !== 'SYMBOL')
          throw new Error(`INSTANCE_SWAP value must be a component id (got ${String(raw)})`);
        v = target.data.guid;
      }
      if (def.type === 'BOOL' && typeof raw !== 'boolean')
        throw new Error(`Property "${key}" expects a boolean`);
      const { value, varValue } = propValue(def.type, v);
      const id = guidToString(def.id);
      const i = assignments.findIndex((a) => guidToString(a.defID) === id);
      const entry = { defID: { ...def.id }, value, varValue };
      if (i >= 0) assignments[i] = entry;
      else assignments.push(entry);
    }
    const fields: Record<string, unknown> = { componentPropAssignments: assignments };
    let finalMain: NodeChange = main.data;
    if (variantChanges.size) {
      if (!isComponentSet(owner)) throw new Error('This instance is not of a variant');
      const want = new Map(parseVariantName(main.name));
      for (const [k, v] of variantChanges) want.set(k, v);
      const target = this.variants(owner).find((c) => {
        const have = new Map(parseVariantName(c.name ?? ''));
        return [...want].every(([k, v]) => have.get(k) === v);
      });
      if (!target)
        throw new Error(`Unable to find a variant with those property values: ${variantName([...want])}`);
      finalMain = target;
      if (inst.isInstanceSublayer) fields.overriddenSymbolID = { ...target.guid };
      else {
        const raw = this.session.raw(inst.id);
        raw.symbolData = { ...(raw.symbolData ?? {}), symbolID: { ...target.guid } };
        delete raw.derivedSymbolData;
        // The instance now looks like the new variant (keeping its position).
        copyInstanceFields(raw, target);
      }
    }
    fields.componentPropAssignments = keyAssignmentsToVariant(assignments, main.data, finalMain);
    setOverride(fields);
  }

  /** instance.detachInstance: replaces the instance with a frame holding a copy of its content. */
  detach(inst: SceneNode): NodeChange {
    if (inst.isInstanceSublayer)
      throw new Error('Cannot detach a nested instance on its own; detach the outer instance first');
    const raw = this.session.raw(inst.id);
    const parentId = guidToString(raw.parentIndex!.guid);
    const siblings = this.doc.rawChildren(parentId);
    const index = siblings.indexOf(raw);
    const strip = (d: NodeChange) => {
      const c = structuredClone(d);
      for (const f of [
        'guid',
        'parentIndex',
        'overrideKey',
        'componentPropRefs',
        'parameterConsumptionMap',
        'derivedSymbolData',
        'componentPropAssignments',
        'symbolData',
        'derivedSymbolDataLayoutVersion',
        'variantPropSpecs',
        'componentPropDefs',
        'isSymbolPublishable',
        'sharedSymbolVersion',
        'componentKey',
        'sourceLibraryKey',
        'publishID',
        'key',
      ]) {
        delete c[f];
      }
      return c;
    };
    const copy = (s: SceneNode, parent: string, at: number | undefined, isRoot: boolean): NodeChange => {
      const fields = strip(s.data);
      let type = s.data.type!;
      if (isRoot) type = 'FRAME';
      else if (s.figType === 'INSTANCE') {
        // Nested instances stay instances, carrying the overrides that reached them.
        fields.symbolData = {
          symbolID: { ...s.data.symbolData.symbolID },
          symbolOverrides: [
            ...structuredClone(s.data.symbolData?.symbolOverrides ?? []),
            ...this.overridesInto(s),
          ],
          uniformScaleFactor: 1,
        };
        if (s.data.overriddenSymbolID) fields.symbolData.symbolID = { ...s.data.overriddenSymbolID };
        delete fields.overriddenSymbolID;
        if (s.data.componentPropAssignments)
          fields.componentPropAssignments = structuredClone(s.data.componentPropAssignments);
      }
      delete fields.type;
      const n = this.session.create(type, parent, at, fields);
      // Copied text must be laid out again (its stored layout may be the component's).
      if (type === 'TEXT') this.session.markText(guidToString(n.guid));
      if (type !== 'INSTANCE') {
        const id = guidToString(n.guid);
        for (const c of s.children) copy(c, id, undefined, false);
      }
      return n;
    };
    const frame = copy(inst, parentId, index, true);
    this.session.remove(inst.id);
    this.doc.reindex();
    return frame;
  }

  /** Overrides from enclosing instances that target the inside of nested instance `s`. */
  private overridesInto(s: SceneNode): any[] {
    const ctx = s.instanceContext;
    if (!ctx) return [];
    const prefix =
      [
        ...ctx.path.map(guidToString),
        guidToString(
          s.data.overrideKey && !isNullGuid(s.data.overrideKey) ? s.data.overrideKey : s.data.guid,
        ),
      ].join('/') + '/';
    const out: any[] = [];
    for (const [k, list] of ctx.overrides) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).split('/');
      for (const o of list) {
        out.push({
          ...structuredClone(o),
          guidPath: {
            guids: rest.map((g) => {
              const [a, b] = g.split(':').map(Number);
              return { sessionID: a!, localID: b! };
            }),
          },
        });
      }
    }
    return out;
  }

  private containingComponent(node: NodeChange): NodeChange | undefined {
    for (
      let n: NodeChange | undefined = node;
      n;
      n = n.parentIndex ? this.doc.nodes.get(guidToString(n.parentIndex.guid)) : undefined
    ) {
      if (n.type === 'SYMBOL') return n;
      if (!n.parentIndex) break;
    }
    return undefined;
  }

  private requireDefinitionOwner(owner: NodeChange): void {
    if (owner.type === 'SYMBOL') {
      const parent = owner.parentIndex ? this.doc.nodes.get(guidToString(owner.parentIndex.guid)) : undefined;
      if (isComponentSet(parent)) {
        throw new Error(
          'Can only get/set component property definitions of a component set or non-variant component',
        );
      }
      return;
    }
    if (!isComponentSet(owner))
      throw new Error(
        'Can only get/set component property definitions of a component set or non-variant component',
      );
  }

  private findDef(owner: NodeChange, key: string): any {
    const def = propertyDefinitions(owner).find((d) => propKey(d) === key);
    if (!def) throw new Error(`Property "${key}" not found`);
    return def;
  }
}

/** componentPropertyDefinitions for a component or set. */
export function propertyDefinitionMap(doc: FigDocument, owner: NodeChange): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const variants = isComponentSet(owner)
    ? doc.rawChildren(guidToString(owner.guid)).filter((c) => c.type === 'SYMBOL')
    : [];
  for (const def of propertyDefinitions(owner)) {
    const type = FROM_FIG[def.type];
    if (!type) continue;
    const entry: any = { type, defaultValue: plainValue(def.type, def.initialValue) };
    if (def.type === 'VARIANT') {
      const order = (owner.stateGroupPropertyValueOrders ?? []).find(
        (o: any) => o.property === def.name,
      )?.values;
      const seen = variants
        .map((v) => new Map(parseVariantName(v.name ?? '')).get(def.name))
        .filter((v): v is string => v !== undefined);
      entry.variantOptions = order?.length ? order : [...new Set(seen)];
      entry.defaultValue = entry.variantOptions[0] ?? '';
    }
    if (def.type === 'INSTANCE_SWAP')
      entry.preferredValues = (def.preferredValues?.instanceSwapValues ?? []).map((p: any) => ({
        type: p.type,
        key: p.key,
      }));
    out[propKey(def)] = entry;
  }
  return out;
}
