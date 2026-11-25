/** Plugin API node members: Components, instances, component properties and variants. Mixed into the node class by createFigmaApi. */
import { type NodeChange, guidToString } from '@figtional/fig-format';
import {
  type PropType,
  copyInstanceFields,
  parseVariantName,
  propertyDefinitionMap,
} from '@figtional/fig-model';
import { IDENTITY_T, OVERRIDE_FIELD_NAMES, componentKeyOf, deepFreeze } from './plugin-values.js';
import { FigtionalUnsupported } from './unsupported.js';
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function componentsMembers(rt: PluginRuntime) {
  const { components, doc, pageId, requireFonts, scene, session, typeError, wrap, wrappers } = rt;
  return class ComponentsMembers extends NodeMembers {
    // ------------------------------------------------ component keys
    get key(): string {
      if (this.type !== 'COMPONENT' && this.type !== 'COMPONENT_SET') throw typeError('key', this.type);
      return componentKeyOf(this._d);
    }
    // ------------------------------------------------ components & instances
    get mainComponent() {
      if (this.type !== 'INSTANCE') throw typeError('mainComponent', this.type);
      return wrap(this._s.mainComponent);
    }
    set mainComponent(c: any) {
      if (this.type !== 'INSTANCE') throw typeError('mainComponent', this.type);
      this.swapComponent(c);
    }
    get overrides(): { id: string; overriddenFields: string[] }[] {
      if (this.type !== 'INSTANCE') throw typeError('overrides', this.type);
      const d = this._d;
      const symbol = d.symbolData?.symbolID ? guidToString(d.symbolData.symbolID) : '';
      const byId = new Map<string, Set<string>>();
      const add = (id: string, f: string) => (byId.get(id) ?? byId.set(id, new Set()).get(id)!).add(f);
      for (const o of d.symbolData?.symbolOverrides ?? []) {
        const guids: any[] = o.guidPath?.guids ?? [];
        const ids = guids.map((g) => guidToString(g));
        const id = ids.length === 1 && ids[0] === symbol ? this.id : `I${this.id};${ids.join(';')}`;
        for (const f of Object.keys(o)) {
          const name = OVERRIDE_FIELD_NAMES[f];
          if (name) add(id, name);
          else if (f === 'size') {
            add(id, 'width');
            add(id, 'height');
          }
        }
      }
      if ((d.componentPropAssignments ?? []).length) add(this.id, 'componentProperties');
      return [...byId].map(([id, fields]) => ({ id, overriddenFields: [...fields] }));
    }
    resetOverrides() {
      if (this.type !== 'INSTANCE') throw typeError('resetOverrides', this.type);
      if (this._s.isInstanceSublayer) throw new FigtionalUnsupported('resetOverrides on a nested instance');
      const raw = session.raw(this.id);
      raw.symbolData = { ...raw.symbolData, symbolOverrides: [] };
      raw.componentPropAssignments = [];
      delete raw.derivedSymbolData;
      const main = this._s.mainComponent;
      if (main) copyInstanceFields(raw, session.raw(main.id));
      session.markDirty(this.id);
    }
    async getMainComponentAsync() {
      return this.mainComponent;
    }
    get componentProperties() {
      if (this.type !== 'INSTANCE') throw typeError('componentProperties', this.type);
      return deepFreeze(components.instanceProperties(this._s));
    }
    get variantProperties() {
      if (this.type === 'INSTANCE') {
        const main = this._s.mainComponent;
        return main?.parent?.type === 'COMPONENT_SET'
          ? Object.fromEntries(parseVariantName(main.name))
          : null;
      }
      if (this.type === 'COMPONENT') {
        return this._s.parent?.type === 'COMPONENT_SET'
          ? Object.fromEntries(parseVariantName(this.name))
          : null;
      }
      throw typeError('variantProperties', this.type);
    }
    get variantGroupProperties() {
      if (this.type !== 'COMPONENT_SET') throw typeError('variantGroupProperties', this.type);
      const defs = propertyDefinitionMap(doc, this._d) as Record<string, any>;
      return Object.fromEntries(
        Object.entries(defs)
          .filter(([, d]) => d.type === 'VARIANT')
          .map(([k, d]) => [k, { values: d.variantOptions }]),
      );
    }
    get defaultVariant() {
      if (this.type !== 'COMPONENT_SET') throw typeError('defaultVariant', this.type);
      return wrap(this._s.children.find((c) => c.type === 'COMPONENT'));
    }
    get componentPropertyReferences() {
      return components.references(this._d);
    }
    set componentPropertyReferences(refs: Record<string, string> | null) {
      if (this._s.isInstanceSublayer) throw new Error('Cannot bind properties on a layer inside an instance');
      const current = components.references(this._d);
      const next = refs ?? {};
      for (const field of ['characters', 'visible', 'mainComponent'] as const) {
        if (next[field] !== current[field]) {
          if (field === 'characters') requireFonts(this._d);
          components.bindProperty(this.id, field, next[field] ?? null);
        }
      }
      for (const k of Object.keys(next)) {
        if (!['characters', 'visible', 'mainComponent'].includes(k)) {
          throw new FigtionalUnsupported(`componentPropertyReferences.${k}`);
        }
      }
    }
    createInstance() {
      if (this.type !== 'COMPONENT') throw typeError('createInstance', this.type);
      const sym = this._s;
      const page = scene(pageId());
      const fields: Record<string, unknown> = {
        // Instances of variants are named after their component set, as in Figma.
        name: sym.parent?.type === 'COMPONENT_SET' ? sym.parent.name : sym.name,
        visible: true,
        opacity: 1,
        transform: { ...IDENTITY_T },
        symbolData: { symbolID: { ...sym.data.guid }, symbolOverrides: [], uniformScaleFactor: 1 },
        strokeJoin: 'MITER',
      };
      copyInstanceFields(fields as NodeChange, sym.data);
      const n = session.create('INSTANCE', page.id, undefined, fields);
      return wrap(scene(guidToString(n.guid)));
    }
    detachInstance() {
      if (this.type !== 'INSTANCE') throw typeError('detachInstance', this.type);
      const frame = components.detach(this._s);
      wrappers.delete(this.id);
      return wrap(scene(guidToString(frame.guid)));
    }
    swapComponent(component: any) {
      if (this.type !== 'INSTANCE') throw typeError('swapComponent', this.type);
      if (component?.type !== 'COMPONENT') throw new Error('Expected a component node');
      const raw = session.raw(this.id);
      raw.symbolData = {
        ...raw.symbolData,
        symbolID: { ...session.raw(component.id).guid },
        symbolOverrides: [],
      };
      delete raw.derivedSymbolData;
      // The instance now looks like the new component at its root too (keeping its position).
      copyInstanceFields(raw, session.raw(component.id));
      session.markDirty(this.id);
    }
    setProperties(props: Record<string, unknown>) {
      if (this.type !== 'INSTANCE') throw typeError('setProperties', this.type);
      const s = this._s;
      // Text properties change text: the fonts of bound text layers must be loaded, as in Figma.
      s.walk((n) => {
        if (
          n !== s &&
          n.figType === 'TEXT' &&
          (n.data.componentPropRefs ?? []).some((r: any) => r.componentPropNodeField === 'TEXT_DATA')
        ) {
          requireFonts(n.data);
        }
        return true;
      });
      components.setInstanceProperties(s, props ?? {}, (fields: Record<string, unknown>) => {
        if (s.isInstanceSublayer) session.setOverride(s, fields);
        else {
          Object.assign(session.raw(this.id), fields);
          session.markDirty(this.id);
        }
      });
    }
    definitionOwnerId(prop: string): string {
      if (this.type === 'COMPONENT_SET') return this.id;
      if (this.type === 'COMPONENT') {
        if (this._s.parent?.type === 'COMPONENT_SET') {
          throw new Error(
            'Can only get/set component property definitions of a component set or non-variant component',
          );
        }
        return this.id;
      }
      throw typeError(prop, this.type);
    }
    get componentPropertyDefinitions() {
      return deepFreeze(
        propertyDefinitionMap(doc, session.raw(this.definitionOwnerId('componentPropertyDefinitions'))),
      );
    }
    addComponentProperty(
      name: string,
      type: string,
      defaultValue: unknown,
      options?: { preferredValues?: { type: string; key: string }[] },
    ) {
      const owner = this.definitionOwnerId('addComponentProperty');
      return components.addProperty(
        owner,
        String(name),
        type as PropType,
        defaultValue,
        options?.preferredValues,
      );
    }
    editComponentProperty(key: string, values: { name?: string; defaultValue?: unknown }) {
      return components.editProperty(this.definitionOwnerId('editComponentProperty'), key, values ?? {});
    }
    deleteComponentProperty(key: string) {
      components.deleteProperty(this.definitionOwnerId('deleteComponentProperty'), key);
    }
  };
}
