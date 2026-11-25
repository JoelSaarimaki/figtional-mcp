/** Plugin API node members: Explicit variable modes and variable bindings. Mixed into the node class by createFigmaApi. */
import { type NodeChange, guidToString } from '@figtional/fig-format';
import { collectionInfo, effectiveMode } from '@figtional/fig-model';
import { FIELD_TO_VARIABLE, collectionById, variableById } from './plugin-values.js';
import { FigtionalUnsupported } from './unsupported.js';
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function variablesMembers(rt: PluginRuntime) {
  const {
    FRAMELIKE,
    applyBoundValue,
    doc,
    editRaw,
    requireFonts,
    scene,
    session,
    syncBoundValues,
    typeError,
  } = rt;
  return class VariablesMembers extends NodeMembers {
    // ------------------------------------------------ explicit variable modes
    requireModes(prop: string) {
      if (![...FRAMELIKE, 'SECTION'].includes(this.type)) throw typeError(prop, this.type);
    }
    modeCollection(collection: unknown): NodeChange {
      const id = typeof collection === 'string' ? collection : (collection as { id?: string } | null)?.id;
      const c = id ? collectionById(doc, id) : undefined;
      if (!c) throw new Error(`Variable collection not found: ${String(id)}`);
      return c;
    }
    get explicitVariableModes(): Record<string, string> {
      this.requireModes('explicitVariableModes');
      const out: Record<string, string> = {};
      for (const e of this._d.variableModeBySetMap?.entries ?? []) {
        const ref = e.variableSetID;
        const c = ref ? doc.resolveVariableRef(ref.guid ? { guid: ref.guid } : ref) : undefined;
        if (c && e.variableModeID)
          out[`VariableCollectionId:${guidToString(c.guid)}`] = guidToString(e.variableModeID);
      }
      return out;
    }
    get resolvedVariableModes(): Record<string, string> {
      const out: Record<string, string> = {};
      const s = scene(this.id);
      for (const c of doc.variableCollections) {
        const mode = effectiveMode(doc, s, c) ?? collectionInfo(doc, c).defaultModeId;
        if (mode) out[`VariableCollectionId:${guidToString(c.guid)}`] = mode;
      }
      return out;
    }
    setExplicitVariableModeForCollection(collection: unknown, modeId: string) {
      this.requireModes('setExplicitVariableModeForCollection');
      const c = this.modeCollection(collection);
      const mode = (c.variableSetModes ?? []).find((m: any) => guidToString(m.id) === String(modeId));
      if (!mode) throw new Error(`Mode ${String(modeId)} not found in collection "${c.name ?? ''}"`);
      // Library collections are referenced by key (as in Figma's files), local ones by guid.
      const variableSetID =
        c.sourceLibraryKey && c.key
          ? { assetRef: { key: c.key, ...(c.version ? { version: c.version } : {}) } }
          : { guid: { ...c.guid } };
      const entries = this.modeEntriesWithout(c);
      entries.push({ variableSetID, variableModeID: { ...mode.id } });
      editRaw(this.id, { variableModeBySetMap: { entries } });
      syncBoundValues(this.id);
    }
    clearExplicitVariableModeForCollection(collection: unknown) {
      this.requireModes('clearExplicitVariableModeForCollection');
      const entries = this.modeEntriesWithout(this.modeCollection(collection));
      if (entries.length) editRaw(this.id, { variableModeBySetMap: { entries } });
      else if (this._d.variableModeBySetMap) {
        if (scene(this.id).isInstanceSublayer)
          throw new FigtionalUnsupported('clearing explicit variable modes on a layer inside an instance');
        delete session.raw(this.id).variableModeBySetMap;
        session.markDirty(this.id);
      }
      syncBoundValues(this.id);
    }
    modeEntriesWithout(c: NodeChange): any[] {
      const id = guidToString(c.guid);
      return (this._d.variableModeBySetMap?.entries ?? [])
        .filter((e: any) => {
          const ref = e.variableSetID;
          const set = ref ? doc.resolveVariableRef(ref.guid ? { guid: ref.guid } : ref) : undefined;
          return !set || guidToString(set.guid) !== id;
        })
        .map((e: any) => structuredClone(e));
    }

    // ------------------------------------------------ variables
    get boundVariables() {
      const out: Record<string, unknown> = {};
      const d = this._d;
      const fieldToProp = Object.fromEntries(Object.entries(FIELD_TO_VARIABLE).map(([k, v]) => [v, k]));
      for (const e of d.variableConsumptionMap?.entries ?? []) {
        const v = e.variableData?.value?.alias
          ? doc.resolveVariableRef(e.variableData.value.alias)
          : undefined;
        const prop = fieldToProp[e.variableField];
        if (v && prop) out[prop] = { type: 'VARIABLE_ALIAS', id: `VariableID:${guidToString(v.guid)}` };
      }
      const fills = (d.fillPaints ?? []).map((p: any) => {
        const v = p.colorVar?.value?.alias ? doc.resolveVariableRef(p.colorVar.value.alias) : undefined;
        return v ? { type: 'VARIABLE_ALIAS', id: `VariableID:${guidToString(v.guid)}` } : undefined;
      });
      if (fills.some(Boolean)) out.fills = fills.filter(Boolean);
      return out;
    }
    setBoundVariable(field: string, variable: any) {
      if (field === 'fills' || field === 'strokes') {
        throw new Error(`Use figma.variables.setBoundVariableForPaint to bind ${field}`);
      }
      const vf = FIELD_TO_VARIABLE[field];
      if (!vf) throw new FigtionalUnsupported(`setBoundVariable('${field}')`);
      if (this.type === 'TEXT') requireFonts(this._d);
      const raw = session.raw(this.id);
      const entries: any[] = (raw.variableConsumptionMap?.entries ?? []).filter(
        (e: any) => e.variableField !== vf,
      );
      if (variable) {
        const v = variableById(doc, variable.id);
        if (!v) throw new Error(`Variable ${variable.id} not found`);
        const resolved =
          v.variableResolvedType === 'BOOLEAN'
            ? 'BOOLEAN'
            : v.variableResolvedType === 'STRING'
              ? 'STRING'
              : 'FLOAT';
        entries.push({
          variableData: {
            value: { alias: { guid: { ...v.guid } } },
            dataType: 'ALIAS',
            resolvedDataType: resolved,
          },
          variableField: vf,
        });
      }
      raw.variableConsumptionMap = { entries };
      session.markDirty(this.id);
      // Store the value in the mode in effect here, so the file and renders are consistent.
      const bound = variable ? variableById(doc, variable.id) : undefined;
      if (bound) applyBoundValue(this._s, vf, bound);
    }
  };
}
