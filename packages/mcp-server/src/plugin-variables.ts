/** The Plugin API's `figma.variables` and its Variable / VariableCollection objects. */
import { type GUID, type NodeChange, guidToString } from '@figtional/fig-format';
import {
  type EditSession,
  type FigDocument,
  collectionInfo,
  normalizeNodeId,
  resolveVariable,
} from '@figtional/fig-model';
import type { PluginRuntime } from './plugin-runtime.js';
import { checkKeys, clamp01, collectionById, variableById } from './plugin-values.js';
import { FigtionalUnsupported } from './unsupported.js';

export function createVariablesApi(rt: PluginRuntime) {
  const doc: FigDocument = rt.doc;
  const session: EditSession = rt.session;
  const variableApi = (v: NodeChange) => {
    const id = guidToString(v.guid);
    const api = {
      get id() {
        return `VariableID:${id}`;
      },
      get key() {
        return v.key ?? id;
      },
      get name() {
        return v.name ?? '';
      },
      set name(n: string) {
        session.raw(id).name = String(n);
        session.markDirty(id);
      },
      get resolvedType() {
        return v.variableResolvedType;
      },
      get variableCollectionId() {
        const c = doc.resolveVariableRef(
          v.variableSetID?.guid ? { guid: v.variableSetID.guid } : v.variableSetID,
        );
        return c ? `VariableCollectionId:${guidToString(c.guid)}` : '';
      },
      get description() {
        return v.description ?? '';
      },
      set description(d: string) {
        session.raw(id).description = String(d);
        session.markDirty(id);
      },
      get remote() {
        return !!v.sourceLibraryKey;
      },
      get scopes() {
        return v.variableScopes ?? ['ALL_SCOPES'];
      },
      set scopes(s: string[]) {
        session.raw(id).variableScopes = [...s];
        session.markDirty(id);
      },
      get valuesByMode() {
        const out: Record<string, unknown> = {};
        for (const e of v.variableDataValues?.entries ?? []) {
          const val = e.variableData?.value ?? {};
          const mode = `${guidToString(e.modeID)}`;
          if (val.alias) {
            const t = doc.resolveVariableRef(val.alias);
            out[mode] = { type: 'VARIABLE_ALIAS', id: t ? `VariableID:${guidToString(t.guid)}` : '' };
          } else if (val.colorValue) out[mode] = { ...val.colorValue };
          else out[mode] = val.floatValue ?? val.boolValue ?? val.textValue ?? null;
        }
        return out;
      },
      setValueForMode(modeId: string, value: any) {
        const raw = session.raw(id);
        const type = raw.variableResolvedType;
        let data: any;
        if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
          const t = variableById(doc, value.id);
          if (!t) throw new Error(`Variable ${value.id} not found`);
          data = { value: { alias: { guid: { ...t.guid } } }, dataType: 'ALIAS', resolvedDataType: type };
        } else if (type === 'COLOR') {
          if (!value || typeof value !== 'object') throw new Error('Expected a color value { r, g, b, a? }');
          checkKeys(value, ['r', 'g', 'b', 'a'], 'value');
          data = {
            value: {
              colorValue: {
                r: clamp01(value.r, 'value.r'),
                g: clamp01(value.g, 'value.g'),
                b: clamp01(value.b, 'value.b'),
                a: value.a ?? 1,
              },
            },
            dataType: 'COLOR',
            resolvedDataType: 'COLOR',
          };
        } else if (type === 'FLOAT')
          data = { value: { floatValue: Number(value) }, dataType: 'FLOAT', resolvedDataType: 'FLOAT' };
        else if (type === 'BOOLEAN')
          data = { value: { boolValue: !!value }, dataType: 'BOOLEAN', resolvedDataType: 'BOOLEAN' };
        else data = { value: { textValue: String(value) }, dataType: 'STRING', resolvedDataType: 'STRING' };
        const mode = normalizeNodeId(String(modeId).replace(/^.*?(\d+:\d+)$/, '$1'));
        if (!mode) throw new Error(`Invalid mode id ${modeId}`);
        const entries: any[] = raw.variableDataValues?.entries ?? [];
        const existing = entries.find((e) => guidToString(e.modeID) === mode);
        if (existing) existing.variableData = data;
        else entries.push({ modeID: parseGuidStr(mode), variableData: data });
        raw.variableDataValues = { entries };
        session.markDirty(id);
      },
      setVariableCodeSyntax(platform: string, value: string) {
        const raw = session.raw(id);
        const entries: any[] = (raw.codeSyntax?.entries ?? []).filter((e: any) => e.platform !== platform);
        entries.push({ platform, value: String(value) });
        raw.codeSyntax = { entries };
        session.markDirty(id);
      },
      remove() {
        session.remove(id);
      },
    };
    return Object.preventExtensions(api);
  };

  const collectionApi = (c: NodeChange) => {
    const id = guidToString(c.guid);
    return Object.preventExtensions({
      get id() {
        return `VariableCollectionId:${id}`;
      },
      get key() {
        return c.key ?? id;
      },
      get name() {
        return c.name ?? '';
      },
      set name(n: string) {
        session.raw(id).name = String(n);
        session.markDirty(id);
      },
      get remote() {
        return !!c.sourceLibraryKey;
      },
      get modes() {
        return collectionInfo(doc, c).modes.map((m) => ({ modeId: m.modeId, name: m.name }));
      },
      get defaultModeId() {
        return collectionInfo(doc, c).defaultModeId;
      },
      get variableIds() {
        return collectionInfo(doc, c).variableIds.map((v) => `VariableID:${v}`);
      },
      addMode(name: string) {
        const raw = session.raw(id);
        const modes: any[] = raw.variableSetModes ?? [];
        const guid = session.newGuid();
        modes.push({
          id: guid,
          name: String(name),
          sortPosition: session.positionAtList(modes.map((m) => m.sortPosition)),
        });
        raw.variableSetModes = modes;
        session.markDirty(id);
        return guidToString(guid);
      },
      renameMode(modeId: string, name: string) {
        const m = (session.raw(id).variableSetModes ?? []).find((x: any) => guidToString(x.id) === modeId);
        if (!m) throw new Error(`Mode ${modeId} not found`);
        m.name = String(name);
        session.markDirty(id);
      },
      removeMode(modeId: string) {
        const raw = session.raw(id);
        raw.variableSetModes = (raw.variableSetModes ?? []).filter((x: any) => guidToString(x.id) !== modeId);
        session.markDirty(id);
      },
      remove() {
        for (const v of collectionInfo(doc, c).variableIds) session.remove(v);
        session.remove(id);
      },
    });
  };

  const parseGuidStr = (s: string): GUID => {
    const [a, b] = s.split(':').map(Number);
    return { sessionID: a!, localID: b! };
  };

  const variables = {
    async getLocalVariablesAsync(type?: string) {
      return doc.variables
        .filter((v) => !v.sourceLibraryKey && (!type || v.variableResolvedType === type))
        .map(variableApi);
    },
    async getLocalVariableCollectionsAsync() {
      return doc.variableCollections.filter((c) => !c.sourceLibraryKey).map(collectionApi);
    },
    async getVariableByIdAsync(id: string) {
      const v = variableById(doc, id);
      return v ? variableApi(v) : null;
    },
    getVariableById(id: string) {
      const v = variableById(doc, id);
      return v ? variableApi(v) : null;
    },
    async getVariableCollectionByIdAsync(id: string) {
      const c = collectionById(doc, id);
      return c ? collectionApi(c) : null;
    },
    async importVariableByKeyAsync(key: string) {
      const v = doc.getByKey(key);
      if (v?.type !== 'VARIABLE') {
        throw new FigtionalUnsupported(
          `importVariableByKeyAsync('${key}')`,
          'Only library variables embedded in this .fig file can be imported.',
        );
      }
      return variableApi(v);
    },
    createVariableCollection(name: string) {
      const page = session.internalPage();
      const modeId = session.newGuid();
      const c = session.create('VARIABLE_SET', guidToString(page.guid), undefined, {
        name: String(name),
        isPublishable: true,
        variableSetModes: [{ id: modeId, name: 'Mode 1', sortPosition: '!' }],
        isCollectionExtendable: true,
      });
      return collectionApi(c);
    },
    createVariable(name: string, collection: any, type: string) {
      const cId = typeof collection === 'string' ? collection : collection?.id;
      const c = collectionById(doc, cId);
      if (!c) throw new Error(`Variable collection ${cId} not found`);
      if (!['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'].includes(type))
        throw new Error(`Invalid variable type "${type}"`);
      const page = session.internalPage();
      const defaults: Record<string, any> = {
        COLOR: {
          value: { colorValue: { r: 0, g: 0, b: 0, a: 1 } },
          dataType: 'COLOR',
          resolvedDataType: 'COLOR',
        },
        FLOAT: { value: { floatValue: 0 }, dataType: 'FLOAT', resolvedDataType: 'FLOAT' },
        STRING: { value: { textValue: '' }, dataType: 'STRING', resolvedDataType: 'STRING' },
        BOOLEAN: { value: { boolValue: false }, dataType: 'BOOLEAN', resolvedDataType: 'BOOLEAN' },
      };
      const v = session.create('VARIABLE', guidToString(page.guid), undefined, {
        name: String(name),
        isPublishable: true,
        variableSetID: { guid: { ...c.guid } },
        variableResolvedType: type,
        variableDataValues: {
          entries: (c.variableSetModes ?? []).map((m: any) => ({
            modeID: { ...m.id },
            variableData: structuredClone(defaults[type]),
          })),
        },
      });
      return variableApi(v);
    },
    createVariableAlias(v: any) {
      return { type: 'VARIABLE_ALIAS', id: v.id };
    },
    setBoundVariableForPaint(paint: any, field: string, variable: any) {
      if (field !== 'color') throw new Error(`Cannot bind field "${field}" of a paint`);
      const copy = { ...paint };
      if (variable) {
        const v = variableById(doc, variable.id);
        if (!v) throw new Error(`Variable ${variable.id} not found`);
        const val = resolveVariable(doc, v);
        if (val && typeof val === 'object' && 'r' in val) copy.color = { r: val.r, g: val.g, b: val.b };
        copy.boundVariables = {
          ...(paint.boundVariables ?? {}),
          color: { type: 'VARIABLE_ALIAS', id: variable.id },
        };
      } else {
        const { color: _c, ...rest } = paint.boundVariables ?? {};
        copy.boundVariables = rest;
      }
      return copy;
    },
    setBoundVariableForEffect() {
      throw new FigtionalUnsupported('setBoundVariableForEffect');
    },
    setBoundVariableForLayoutGrid() {
      throw new FigtionalUnsupported('setBoundVariableForLayoutGrid');
    },
  };

  // ------------------------------------------------------------------ figma global
  return { variables };
}
