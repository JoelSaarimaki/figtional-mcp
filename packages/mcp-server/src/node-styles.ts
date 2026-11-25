/** Plugin API node members: Style ids (fill, stroke, effect, grid, text) and their async setters. Mixed into the node class by createFigmaApi. */
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function stylesMembers(rt: PluginRuntime) {
  const { FRAMELIKE, dynamicPage, editRaw, requireFonts, styles, typeError } = rt;
  return class StylesMembers extends NodeMembers {
    // ------------------------------------------------ styles
    get fillStyleId() {
      return styles.idFor(this._d, 'styleIdForFill');
    }
    set fillStyleId(_v: string) {
      throw dynamicPage('fillStyleId', 'setFillStyleIdAsync');
    }
    async setFillStyleIdAsync(id: string) {
      styles.applyToNode(this.id, 'styleIdForFill', String(id ?? ''), editRaw);
    }
    get strokeStyleId() {
      return styles.idFor(this._d, 'styleIdForStrokeFill');
    }
    set strokeStyleId(_v: string) {
      throw dynamicPage('strokeStyleId', 'setStrokeStyleIdAsync');
    }
    async setStrokeStyleIdAsync(id: string) {
      styles.applyToNode(this.id, 'styleIdForStrokeFill', String(id ?? ''), editRaw);
      if (id && this._d.strokeWeight === undefined) editRaw(this.id, { strokeWeight: 1 });
    }
    get effectStyleId() {
      return styles.idFor(this._d, 'styleIdForEffect');
    }
    set effectStyleId(_v: string) {
      throw dynamicPage('effectStyleId', 'setEffectStyleIdAsync');
    }
    async setEffectStyleIdAsync(id: string) {
      styles.applyToNode(this.id, 'styleIdForEffect', String(id ?? ''), editRaw);
    }
    get gridStyleId() {
      return styles.idFor(this._d, 'styleIdForGrid');
    }
    set gridStyleId(_v: string) {
      throw dynamicPage('gridStyleId', 'setGridStyleIdAsync');
    }
    async setGridStyleIdAsync(id: string) {
      if (!FRAMELIKE.includes(this.type)) throw typeError('setGridStyleIdAsync', this.type);
      styles.applyToNode(this.id, 'styleIdForGrid', String(id ?? ''), editRaw);
    }
    get textStyleId() {
      this.requireText('textStyleId');
      return styles.idFor(this._d, 'styleIdForText');
    }
    set textStyleId(_v: string) {
      throw dynamicPage('textStyleId', 'setTextStyleIdAsync');
    }
    async setTextStyleIdAsync(id: string) {
      this.requireText('setTextStyleIdAsync');
      requireFonts(this._d);
      styles.applyToNode(this.id, 'styleIdForText', String(id ?? ''), editRaw);
    }
  };
}
