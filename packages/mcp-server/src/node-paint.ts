/** Plugin API node members: Fills, strokes, effects and corner radii. Mixed into the node class by createFigmaApi. */
import {
  MIXED,
  deepFreeze,
  effectFromPlugin,
  effectToPlugin,
  paintFromPlugin,
  paintToPlugin,
} from './plugin-values.js';
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function paintMembers(rt: PluginRuntime) {
  const { FRAMELIKE, detachStyle, doc, editRaw, requireFonts, session, typeError } = rt;
  return class PaintMembers extends NodeMembers {
    // ------------------------------------------------ fills, strokes, effects
    get fills() {
      return deepFreeze((this._d.fillPaints ?? []).map((p: any) => paintToPlugin(doc, p)));
    }
    set fills(v: any[]) {
      if (!Array.isArray(v)) throw new Error('fills must be an array of paints');
      if (this.type === 'TEXT') requireFonts(this._d);
      editRaw(this.id, { fillPaints: v.map((p, i) => paintFromPlugin(doc, p, `[${i}]`)) });
      detachStyle(this.id, 'styleIdForFill');
    }
    get strokes() {
      return deepFreeze((this._d.strokePaints ?? []).map((p: any) => paintToPlugin(doc, p)));
    }
    set strokes(v: any[]) {
      if (!Array.isArray(v)) throw new Error('strokes must be an array of paints');
      editRaw(this.id, { strokePaints: v.map((p, i) => paintFromPlugin(doc, p, `[${i}]`)) });
      detachStyle(this.id, 'styleIdForStrokeFill');
      if (this._d.strokeWeight === undefined) editRaw(this.id, { strokeWeight: 1 });
      session.invalidateGeometry(session.raw(this.id));
    }
    get strokeWeight(): any {
      return this._d.borderStrokeWeightsIndependent ? MIXED : (this._d.strokeWeight ?? 1);
    }
    set strokeWeight(v: number) {
      editRaw(this.id, { strokeWeight: Number(v), borderStrokeWeightsIndependent: false });
      session.invalidateGeometry(session.raw(this.id));
    }
    get strokeAlign() {
      return this._d.strokeAlign ?? 'CENTER';
    }
    set strokeAlign(v: string) {
      editRaw(this.id, { strokeAlign: v });
      session.invalidateGeometry(session.raw(this.id));
    }
    get dashPattern() {
      return deepFreeze([...(this._d.dashPattern ?? [])]);
    }
    set dashPattern(v: number[]) {
      editRaw(this.id, { dashPattern: [...v] });
    }
    get strokeTopWeight() {
      return this._d.borderTopWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeTopWeight(v: number) {
      this.setBorder('borderTopWeight', v);
    }
    get strokeRightWeight() {
      return this._d.borderRightWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeRightWeight(v: number) {
      this.setBorder('borderRightWeight', v);
    }
    get strokeBottomWeight() {
      return this._d.borderBottomWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeBottomWeight(v: number) {
      this.setBorder('borderBottomWeight', v);
    }
    get strokeLeftWeight() {
      return this._d.borderLeftWeight ?? this._d.strokeWeight ?? 1;
    }
    set strokeLeftWeight(v: number) {
      this.setBorder('borderLeftWeight', v);
    }
    setBorder(field: string, v: number) {
      const d = this._d;
      const w = d.strokeWeight ?? 1;
      editRaw(this.id, {
        borderStrokeWeightsIndependent: true,
        borderTopWeight: d.borderTopWeight ?? w,
        borderRightWeight: d.borderRightWeight ?? w,
        borderBottomWeight: d.borderBottomWeight ?? w,
        borderLeftWeight: d.borderLeftWeight ?? w,
        [field]: Number(v),
      });
      session.invalidateGeometry(session.raw(this.id));
    }
    get effects() {
      return deepFreeze((this._d.effects ?? []).map(effectToPlugin));
    }
    set effects(v: any[]) {
      editRaw(this.id, { effects: v.map((e, i) => effectFromPlugin(e, `[${i}]`)) });
      detachStyle(this.id, 'styleIdForEffect');
    }
    get cornerRadius(): any {
      return this._d.rectangleCornerRadiiIndependent ? MIXED : (this._d.cornerRadius ?? 0);
    }
    set cornerRadius(v: number) {
      editRaw(this.id, {
        cornerRadius: Number(v),
        rectangleCornerRadiiIndependent: false,
        rectangleTopLeftCornerRadius: Number(v),
        rectangleTopRightCornerRadius: Number(v),
        rectangleBottomLeftCornerRadius: Number(v),
        rectangleBottomRightCornerRadius: Number(v),
      });
      session.invalidateGeometry(session.raw(this.id));
    }
    setCorner(field: string, v: number) {
      const r = this._d.cornerRadius ?? 0;
      const d = this._d;
      editRaw(this.id, {
        rectangleCornerRadiiIndependent: true,
        rectangleTopLeftCornerRadius: d.rectangleTopLeftCornerRadius ?? r,
        rectangleTopRightCornerRadius: d.rectangleTopRightCornerRadius ?? r,
        rectangleBottomLeftCornerRadius: d.rectangleBottomLeftCornerRadius ?? r,
        rectangleBottomRightCornerRadius: d.rectangleBottomRightCornerRadius ?? r,
        [field]: Number(v),
      });
      session.invalidateGeometry(session.raw(this.id));
    }
    get topLeftRadius() {
      return this._d.rectangleTopLeftCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set topLeftRadius(v: number) {
      this.setCorner('rectangleTopLeftCornerRadius', v);
    }
    get topRightRadius() {
      return this._d.rectangleTopRightCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set topRightRadius(v: number) {
      this.setCorner('rectangleTopRightCornerRadius', v);
    }
    get bottomLeftRadius() {
      return this._d.rectangleBottomLeftCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set bottomLeftRadius(v: number) {
      this.setCorner('rectangleBottomLeftCornerRadius', v);
    }
    get bottomRightRadius() {
      return this._d.rectangleBottomRightCornerRadius ?? this._d.cornerRadius ?? 0;
    }
    set bottomRightRadius(v: number) {
      this.setCorner('rectangleBottomRightCornerRadius', v);
    }
    get clipsContent() {
      if (!FRAMELIKE.includes(this.type)) throw typeError('clipsContent', this.type);
      return this._d.frameMaskDisabled !== true;
    }
    set clipsContent(v: boolean) {
      if (!FRAMELIKE.includes(this.type)) throw typeError('clipsContent', this.type);
      editRaw(this.id, { frameMaskDisabled: !v });
    }
  };
}
