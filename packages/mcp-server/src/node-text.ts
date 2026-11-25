/** Plugin API node members: Text content, typography and styled ranges. Mixed into the node class by createFigmaApi. */
import { MIXED, paintFromPlugin, paintToPlugin } from './plugin-values.js';
import { FigtionalUnsupported } from './unsupported.js';
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function textMembers(rt: PluginRuntime) {
  const {
    detachStyle,
    doc,
    editRaw,
    isFontLoaded,
    requireFonts,
    scene,
    session,
    setTextProperty,
    typeError,
  } = rt;
  return class TextMembers extends NodeMembers {
    // ------------------------------------------------ text
    requireText(prop: string) {
      if (this.type !== 'TEXT') throw typeError(prop, this.type);
    }
    get autoRename(): boolean {
      this.requireText('autoRename');
      return this._d.autoRename !== false;
    }
    set autoRename(v: boolean) {
      this.requireText('autoRename');
      editRaw(this.id, { autoRename: !!v });
    }
    get characters() {
      this.requireText('characters');
      return this._d.textData?.characters ?? '';
    }
    set characters(v: string) {
      this.requireText('characters');
      requireFonts(this._d);
      const text = String(v);
      const d = this._d;
      const textData = {
        characters: text,
        lines: text.split('\n').map(() => ({
          lineType: 'PLAIN',
          styleId: 0,
          indentationLevel: 0,
          sourceDirectionality: 'AUTO',
          listStartOffset: 0,
          isFirstLineOfList: false,
        })),
      };
      const s = this._s;
      if (s.isInstanceSublayer) {
        if (!setTextProperty(s, textData)) session.setOverride(s, { textData });
        return;
      }
      const fields: Record<string, unknown> = { textData };
      // Figma renames auto-named text layers to follow their content.
      if (
        d.autoRename !== false &&
        (d.name === (d.textData?.characters ?? '') || d.name === '' || d.autoRename === true)
      ) {
        fields.name = text.slice(0, 100);
      }
      editRaw(this.id, fields, { text: true });
      delete session.raw(this.id).derivedTextData;
    }
    insertCharacters(start: number, chars: string) {
      const cur = this.characters;
      this.characters = cur.slice(0, start) + chars + cur.slice(start);
    }
    deleteCharacters(start: number, end: number) {
      const cur = this.characters;
      this.characters = cur.slice(0, start) + cur.slice(end);
    }
    get fontName(): any {
      this.requireText('fontName');
      const ids: number[] = this._d.textData?.characterStyleIDs ?? [];
      if (
        (this._d.textData?.styleOverrideTable ?? []).some((o: any) => o.fontName) &&
        ids.some((i) => i !== 0)
      )
        return MIXED;
      const f = this._d.fontName ?? { family: 'Inter', style: 'Regular' };
      return { family: f.family, style: f.style };
    }
    set fontName(v: { family: string; style: string }) {
      this.requireText('fontName');
      if (!isFontLoaded(v))
        throw new Error(
          `Cannot use unloaded font "${v.family} ${v.style}". Please call figma.loadFontAsync({ family: "${v.family}", style: "${v.style}" }) and await the returned promise first.`,
        );
      requireFonts(this._d);
      editRaw(this.id, { fontName: { family: v.family, style: v.style, postscript: '' } }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get fontSize() {
      this.requireText('fontSize');
      return this._d.fontSize ?? 12;
    }
    set fontSize(v: number) {
      this.requireText('fontSize');
      requireFonts(this._d);
      editRaw(this.id, { fontSize: Number(v) }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get lineHeight() {
      this.requireText('lineHeight');
      const lh = this._d.lineHeight;
      if (!lh || (lh.units === 'PERCENT' && lh.value === 100)) return { unit: 'AUTO' };
      if (lh.units === 'RAW') return { unit: 'PERCENT', value: lh.value * 100 };
      if (lh.units === 'PIXELS') return { unit: 'PIXELS', value: lh.value };
      return { unit: 'PERCENT', value: lh.value };
    }
    set lineHeight(v: { unit: string; value?: number }) {
      this.requireText('lineHeight');
      requireFonts(this._d);
      if (typeof v !== 'object')
        throw new Error('lineHeight must be an object like { unit: "PIXELS", value: 24 }');
      const lh =
        v.unit === 'AUTO'
          ? { value: 100, units: 'PERCENT' }
          : v.unit === 'PERCENT'
            ? { value: (v.value ?? 100) / 100, units: 'RAW' }
            : { value: v.value ?? 0, units: 'PIXELS' };
      editRaw(this.id, { lineHeight: lh }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get letterSpacing() {
      this.requireText('letterSpacing');
      const ls = this._d.letterSpacing ?? { value: 0, units: 'PERCENT' };
      return { unit: ls.units === 'PIXELS' ? 'PIXELS' : 'PERCENT', value: ls.value };
    }
    set letterSpacing(v: { unit: string; value: number }) {
      this.requireText('letterSpacing');
      requireFonts(this._d);
      if (typeof v !== 'object')
        throw new Error('letterSpacing must be an object like { unit: "PERCENT", value: 0 }');
      editRaw(
        this.id,
        { letterSpacing: { value: Number(v.value), units: v.unit === 'PIXELS' ? 'PIXELS' : 'PERCENT' } },
        { text: true },
      );
      detachStyle(this.id, 'styleIdForText');
    }
    get textAlignHorizontal() {
      this.requireText('textAlignHorizontal');
      return this._d.textAlignHorizontal ?? 'LEFT';
    }
    set textAlignHorizontal(v: string) {
      this.requireText('textAlignHorizontal');
      requireFonts(this._d);
      editRaw(this.id, { textAlignHorizontal: v });
    }
    get textAlignVertical() {
      this.requireText('textAlignVertical');
      return this._d.textAlignVertical ?? 'TOP';
    }
    set textAlignVertical(v: string) {
      this.requireText('textAlignVertical');
      requireFonts(this._d);
      editRaw(this.id, { textAlignVertical: v });
    }
    get textAutoResize() {
      this.requireText('textAutoResize');
      return this._d.textAutoResize ?? 'NONE';
    }
    set textAutoResize(v: string) {
      this.requireText('textAutoResize');
      requireFonts(this._d);
      if (!['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'].includes(v))
        throw new Error(`Invalid textAutoResize "${v}"`);
      editRaw(this.id, { textAutoResize: v === 'TRUNCATE' ? 'NONE' : v }, { text: true });
    }
    get textCase() {
      this.requireText('textCase');
      return this._d.textCase ?? 'ORIGINAL';
    }
    set textCase(v: string) {
      this.requireText('textCase');
      requireFonts(this._d);
      editRaw(this.id, { textCase: v }, { text: true });
      detachStyle(this.id, 'styleIdForText');
    }
    get textDecoration() {
      this.requireText('textDecoration');
      return this._d.textDecoration ?? 'NONE';
    }
    set textDecoration(v: string) {
      this.requireText('textDecoration');
      requireFonts(this._d);
      editRaw(this.id, { textDecoration: v });
      detachStyle(this.id, 'styleIdForText');
    }
    get textTruncation(): string {
      this.requireText('textTruncation');
      return this._d.textTruncation ?? 'DISABLED';
    }
    set textTruncation(v: string) {
      this.requireText('textTruncation');
      if (!['DISABLED', 'ENDING'].includes(v)) throw new Error(`Invalid textTruncation "${v}"`);
      requireFonts(this._d);
      editRaw(this.id, { textTruncation: v }, { text: true });
    }
    get maxLines(): number | null {
      this.requireText('maxLines');
      return this._d.maxLines ?? null;
    }
    set maxLines(v: number | null) {
      this.requireText('maxLines');
      requireFonts(this._d);
      if (v === null) {
        if (scene(this.id).isInstanceSublayer)
          throw new FigtionalUnsupported('clearing maxLines inside an instance');
        delete session.raw(this.id).maxLines;
        session.markText(this.id);
        return;
      }
      if (!Number.isInteger(v) || v < 1) throw new Error('maxLines must be a positive integer or null');
      editRaw(this.id, { maxLines: v }, { text: true });
    }
    get hasMissingFont() {
      return false;
    }
    getStyledTextSegments(fields: string[]) {
      this.requireText('getStyledTextSegments');
      const d = this._d;
      const chars: string = d.textData?.characters ?? '';
      const ids: number[] = d.textData?.characterStyleIDs ?? [];
      const table = new Map<number, any>(
        (d.textData?.styleOverrideTable ?? []).map((o: any) => [o.styleID, o]),
      );
      const segs: any[] = [];
      let start = 0;
      const styleAt = (i: number) => ids[i] ?? 0;
      for (let i = 1; i <= chars.length; i++) {
        if (i === chars.length || styleAt(i) !== styleAt(i - 1)) {
          const o = { ...d, ...(table.get(styleAt(start)) ?? {}) };
          const seg: any = { characters: chars.slice(start, i), start, end: i };
          for (const f of fields ?? []) {
            if (f === 'fontName') seg.fontName = { family: o.fontName?.family, style: o.fontName?.style };
            else if (f === 'fontSize') seg.fontSize = o.fontSize;
            else if (f === 'fills') seg.fills = (o.fillPaints ?? []).map((p: any) => paintToPlugin(doc, p));
            else if (f === 'textDecoration') seg.textDecoration = o.textDecoration ?? 'NONE';
            else if (f === 'textCase') seg.textCase = o.textCase ?? 'ORIGINAL';
            else if (f === 'fontWeight') seg.fontWeight = undefined;
          }
          segs.push(seg);
          start = i;
        }
      }
      if (!segs.length)
        segs.push({
          characters: '',
          start: 0,
          end: 0,
          ...(fields?.includes('fontName') ? { fontName: { ...d.fontName } } : {}),
        });
      return segs;
    }
    setRange(start: number, end: number, fields: Record<string, unknown>) {
      this.requireText('setRange');
      requireFonts(this._d);
      const s = this._s;
      if (s.isInstanceSublayer) throw new FigtionalUnsupported('setRange* on text inside an instance');
      const raw = session.raw(this.id);
      const chars: string = raw.textData?.characters ?? '';
      if (start <= 0 && end >= chars.length) {
        Object.assign(raw, fields);
      } else {
        const td = raw.textData;
        const ids: number[] = td.characterStyleIDs?.length
          ? [...td.characterStyleIDs]
          : new Array(chars.length).fill(0);
        while (ids.length < chars.length) ids.push(0);
        const table: any[] = td.styleOverrideTable ? [...td.styleOverrideTable] : [];
        const remap = new Map<number, number>();
        let next = Math.max(0, ...table.map((o) => o.styleID)) + 1;
        for (let i = start; i < end; i++) {
          const old = ids[i]!;
          let nid = remap.get(old);
          if (nid === undefined) {
            nid = next++;
            const base = table.find((o) => o.styleID === old) ?? {};
            table.push({ ...structuredClone(base), ...fields, styleID: nid });
            remap.set(old, nid);
          }
          ids[i] = nid;
        }
        td.characterStyleIDs = ids;
        td.styleOverrideTable = table;
      }
      session.markText(this.id);
      delete raw.derivedTextData;
    }
    setRangeFontSize(start: number, end: number, v: number) {
      this.setRange(start, end, { fontSize: Number(v) });
    }
    setRangeFontName(start: number, end: number, v: { family: string; style: string }) {
      if (!isFontLoaded(v))
        throw new Error(
          `Cannot use unloaded font "${v.family} ${v.style}". Please call figma.loadFontAsync first.`,
        );
      this.setRange(start, end, { fontName: { family: v.family, style: v.style, postscript: '' } });
    }
    setRangeFills(start: number, end: number, v: any[]) {
      this.setRange(start, end, { fillPaints: v.map((p, i) => paintFromPlugin(doc, p, `[${i}]`)) });
    }
    setRangeTextDecoration(start: number, end: number, v: string) {
      this.setRange(start, end, { textDecoration: v });
    }
    setRangeTextCase(start: number, end: number, v: string) {
      this.setRange(start, end, { textCase: v });
    }
    getRangeFontName(start: number, end: number) {
      const segs = this.getStyledTextSegments(['fontName']).filter((s) => s.end > start && s.start < end);
      const names = new Set(segs.map((s) => `${s.fontName.family}|${s.fontName.style}`));
      return names.size === 1 ? segs[0].fontName : MIXED;
    }
    getRangeFontSize(start: number, end: number) {
      const segs = this.getStyledTextSegments(['fontSize']).filter((s) => s.end > start && s.start < end);
      const sizes = new Set(segs.map((s) => s.fontSize));
      return sizes.size === 1 ? segs[0].fontSize : MIXED;
    }
  };
}
