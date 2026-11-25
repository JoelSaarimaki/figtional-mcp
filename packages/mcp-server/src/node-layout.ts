/** Plugin API node members: Auto layout of frames and layout properties of their children. Mixed into the node class by createFigmaApi. */
import { stackProps } from '@figtional/fig-model';
import { FigtionalUnsupported } from './unsupported.js';
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function layoutMembers(rt: PluginRuntime) {
  const { FRAMELIKE, editRaw, requireFonts, scene, session, typeError } = rt;
  return class LayoutMembers extends NodeMembers {
    // ------------------------------------------------ auto layout (frame)
    requireFrame(prop: string) {
      if (!FRAMELIKE.includes(this.type)) throw typeError(prop, this.type);
    }
    get layoutMode() {
      this.requireFrame('layoutMode');
      const m = this._d.stackMode;
      return m === 'HORIZONTAL' || m === 'VERTICAL' || m === 'GRID' ? m : 'NONE';
    }
    set layoutMode(v: string) {
      this.requireFrame('layoutMode');
      if (!['NONE', 'HORIZONTAL', 'VERTICAL'].includes(v)) {
        throw v === 'GRID'
          ? new FigtionalUnsupported("layoutMode = 'GRID'")
          : new Error(`Expected 'NONE' | 'HORIZONTAL' | 'VERTICAL', received '${v}'`);
      }
      const d = this._d;
      const fields: Record<string, unknown> = { stackMode: v };
      if (v !== 'NONE' && d.stackMode !== 'HORIZONTAL' && d.stackMode !== 'VERTICAL') {
        // New auto-layout frames keep their current size: both axes fixed until changed.
        fields.stackPrimarySizing = 'FIXED';
      }
      editRaw(this.id, fields);
    }
    get primaryAxisSizingMode() {
      this.requireFrame('primaryAxisSizingMode');
      return this._d.stackPrimarySizing === 'FIXED' ? 'FIXED' : 'AUTO';
    }
    set primaryAxisSizingMode(v: string) {
      this.requireFrame('primaryAxisSizingMode');
      if (v !== 'FIXED' && v !== 'AUTO') throw new Error(`Expected 'FIXED' | 'AUTO', received '${v}'`);
      if (v === 'FIXED') editRaw(this.id, { stackPrimarySizing: 'FIXED' });
      else {
        delete session.raw(this.id).stackPrimarySizing;
        session.markDirty(this.id);
      }
    }
    get counterAxisSizingMode() {
      this.requireFrame('counterAxisSizingMode');
      const c = this._d.stackCounterSizing;
      return c === 'RESIZE_TO_FIT' || c === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' ? 'AUTO' : 'FIXED';
    }
    set counterAxisSizingMode(v: string) {
      this.requireFrame('counterAxisSizingMode');
      if (v !== 'FIXED' && v !== 'AUTO') throw new Error(`Expected 'FIXED' | 'AUTO', received '${v}'`);
      if (v === 'AUTO') editRaw(this.id, { stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' });
      else {
        delete session.raw(this.id).stackCounterSizing;
        session.markDirty(this.id);
      }
    }
    get itemSpacing() {
      this.requireFrame('itemSpacing');
      return this._d.stackSpacing ?? 0;
    }
    set itemSpacing(v: number) {
      this.requireFrame('itemSpacing');
      editRaw(this.id, { stackSpacing: Number(v) });
    }
    get counterAxisSpacing() {
      return this._d.stackCounterSpacing ?? null;
    }
    set counterAxisSpacing(v: number | null) {
      editRaw(this.id, { stackCounterSpacing: v === null ? NaN : Number(v) });
    }
    get paddingLeft() {
      return this._d.stackHorizontalPadding ?? 0;
    }
    set paddingLeft(v: number) {
      const d = this._d;
      editRaw(this.id, {
        stackHorizontalPadding: Number(v),
        stackPaddingRight: d.stackPaddingRight ?? d.stackHorizontalPadding ?? 0,
      });
    }
    get paddingRight() {
      return this._d.stackPaddingRight ?? this._d.stackHorizontalPadding ?? 0;
    }
    set paddingRight(v: number) {
      editRaw(this.id, { stackPaddingRight: Number(v) });
    }
    get paddingTop() {
      return this._d.stackVerticalPadding ?? 0;
    }
    set paddingTop(v: number) {
      const d = this._d;
      editRaw(this.id, {
        stackVerticalPadding: Number(v),
        stackPaddingBottom: d.stackPaddingBottom ?? d.stackVerticalPadding ?? 0,
      });
    }
    get paddingBottom() {
      return this._d.stackPaddingBottom ?? this._d.stackVerticalPadding ?? 0;
    }
    set paddingBottom(v: number) {
      editRaw(this.id, { stackPaddingBottom: Number(v) });
    }
    get horizontalPadding() {
      return this.paddingLeft;
    }
    set horizontalPadding(v: number) {
      this.paddingLeft = v;
      this.paddingRight = v;
    }
    get verticalPadding() {
      return this.paddingTop;
    }
    set verticalPadding(v: number) {
      this.paddingTop = v;
      this.paddingBottom = v;
    }
    get primaryAxisAlignItems() {
      const j = this._d.stackPrimaryAlignItems ?? 'MIN';
      return j === 'SPACE_EVENLY' || j === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : j;
    }
    set primaryAxisAlignItems(v: string) {
      if (!['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'].includes(v))
        throw new Error(`Expected 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN', received '${v}'`);
      editRaw(this.id, { stackPrimaryAlignItems: v === 'SPACE_BETWEEN' ? 'SPACE_EVENLY' : v });
    }
    get counterAxisAlignItems() {
      return this._d.stackCounterAlignItems ?? 'MIN';
    }
    set counterAxisAlignItems(v: string) {
      if (!['MIN', 'MAX', 'CENTER', 'BASELINE'].includes(v))
        throw new Error(`Expected 'MIN' | 'MAX' | 'CENTER' | 'BASELINE', received '${v}'`);
      editRaw(this.id, { stackCounterAlignItems: v });
    }
    get layoutWrap() {
      return this._d.stackWrap === 'WRAP' ? 'WRAP' : 'NO_WRAP';
    }
    set layoutWrap(v: string) {
      editRaw(this.id, { stackWrap: v === 'WRAP' ? 'WRAP' : 'NO_WRAP' });
    }
    get strokesIncludedInLayout() {
      return this._d.bordersTakeSpace === true;
    }
    set strokesIncludedInLayout(v: boolean) {
      editRaw(this.id, { bordersTakeSpace: !!v });
    }
    get itemReverseZIndex() {
      return this._d.stackReverseZIndex === true;
    }
    set itemReverseZIndex(v: boolean) {
      editRaw(this.id, { stackReverseZIndex: !!v });
    }

    // ------------------------------------------------ layout as a child
    get layoutGrow() {
      return this._d.stackChildPrimaryGrow ?? 0;
    }
    set layoutGrow(v: number) {
      editRaw(this.id, { stackChildPrimaryGrow: Number(v) });
    }
    get layoutAlign() {
      return this._d.stackChildAlignSelf === 'STRETCH' ? 'STRETCH' : 'INHERIT';
    }
    set layoutAlign(v: string) {
      editRaw(this.id, { stackChildAlignSelf: v === 'STRETCH' ? 'STRETCH' : 'AUTO' });
    }
    get layoutPositioning() {
      return this._d.stackPositioning === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO';
    }
    set layoutPositioning(v: string) {
      editRaw(this.id, { stackPositioning: v === 'ABSOLUTE' ? 'ABSOLUTE' : 'AUTO' });
    }
    sizing(horizontal: boolean): string {
      const s = this._s;
      const d = s.data;
      const parent = s.parent ? stackProps(s.parent.data) : undefined;
      if (parent) {
        const grow = (d.stackChildPrimaryGrow ?? 0) > 0;
        const stretch = d.stackChildAlignSelf === 'STRETCH';
        if (parent.horizontal === horizontal ? grow : stretch) return 'FILL';
      }
      const own = stackProps(d);
      if (own) return (own.horizontal === horizontal ? own.primaryHug : own.counterHug) ? 'HUG' : 'FIXED';
      if (d.type === 'TEXT') {
        if (d.textAutoResize === 'WIDTH_AND_HEIGHT') return 'HUG';
        if (!horizontal && d.textAutoResize === 'HEIGHT') return 'HUG';
      }
      return 'FIXED';
    }
    setSizing(horizontal: boolean, v: string) {
      const prop = horizontal ? 'layoutSizingHorizontal' : 'layoutSizingVertical';
      const s = this._s;
      const d = s.data;
      const parent = s.parent ? stackProps(s.parent.data) : undefined;
      const own = stackProps(d);
      if (!['FIXED', 'HUG', 'FILL'].includes(v))
        throw new Error(`Expected 'FIXED' | 'HUG' | 'FILL', received '${v}'`);
      if (v === 'HUG' && !own && !(d.type === 'TEXT')) {
        throw new Error(
          `Error: in set_${prop}: node must be an auto-layout frame or a child of an auto-layout frame`,
        );
      }
      if (v === 'FILL' && (!parent || d.stackPositioning === 'ABSOLUTE')) {
        throw new Error(`Error: in set_${prop}: FILL can only be set on children of auto-layout frames`);
      }
      const fields: Record<string, unknown> = {};
      // Clear fill on this axis first.
      if (parent) {
        if (parent.horizontal === horizontal) fields.stackChildPrimaryGrow = v === 'FILL' ? 1 : 0;
        else fields.stackChildAlignSelf = v === 'FILL' ? 'STRETCH' : 'AUTO';
      }
      if (own) {
        const primary = own.horizontal === horizontal;
        if (primary) fields.stackPrimarySizing = v === 'HUG' ? undefined : 'FIXED';
        else fields.stackCounterSizing = v === 'HUG' ? 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' : undefined;
      } else if (d.type === 'TEXT') {
        requireFonts(d);
        const cur = d.textAutoResize ?? 'NONE';
        if (horizontal)
          fields.textAutoResize =
            v === 'HUG' ? 'WIDTH_AND_HEIGHT' : cur === 'WIDTH_AND_HEIGHT' ? 'HEIGHT' : cur;
        else fields.textAutoResize = v === 'HUG' ? (cur === 'WIDTH_AND_HEIGHT' ? cur : 'HEIGHT') : 'NONE';
      }
      const raw = session.raw(this.id);
      for (const [k, val] of Object.entries(fields)) {
        if (val === undefined) delete raw[k];
        else raw[k] = val;
      }
      if (d.type === 'TEXT') session.markText(this.id);
      else session.markDirty(this.id);
    }
    get layoutSizingHorizontal() {
      return this.sizing(true);
    }
    set layoutSizingHorizontal(v: string) {
      this.setSizing(true, v);
    }
    get layoutSizingVertical() {
      return this.sizing(false);
    }
    set layoutSizingVertical(v: string) {
      this.setSizing(false, v);
    }
    // Figma stores both axes in one vector; an unset minimum is 0 and an unset maximum Infinity
    // (verified in all references), so a single set dimension still encodes.
    minMax(field: 'minSize' | 'maxSize', axis: 'x' | 'y') {
      const v = this._d[field]?.value?.[axis];
      const unset = field === 'minSize' ? 0 : Infinity;
      return v === undefined || v === null || v === unset ? null : v;
    }
    setMinMax(field: 'minSize' | 'maxSize', axis: 'x' | 'y', v: number | null) {
      const unset = field === 'minSize' ? 0 : Infinity;
      const cur = { x: this._d[field]?.value?.x ?? unset, y: this._d[field]?.value?.y ?? unset };
      cur[axis] = v === null || v === undefined ? unset : Number(v);
      if (cur.x === unset && cur.y === unset) {
        if (scene(this.id).isInstanceSublayer)
          throw new FigtionalUnsupported(`clearing ${field} inside an instance`);
        delete session.raw(this.id)[field];
        session.markDirty(this.id);
      } else editRaw(this.id, { [field]: { value: cur } });
    }
    get minWidth() {
      return this.minMax('minSize', 'x');
    }
    set minWidth(v: number | null) {
      this.setMinMax('minSize', 'x', v);
    }
    get maxWidth() {
      return this.minMax('maxSize', 'x');
    }
    set maxWidth(v: number | null) {
      this.setMinMax('maxSize', 'x', v);
    }
    get minHeight() {
      return this.minMax('minSize', 'y');
    }
    set minHeight(v: number | null) {
      this.setMinMax('minSize', 'y', v);
    }
    get maxHeight() {
      return this.minMax('maxSize', 'y');
    }
    set maxHeight(v: number | null) {
      this.setMinMax('maxSize', 'y', v);
    }
    get constraints() {
      return {
        horizontal: this._d.horizontalConstraint ?? 'MIN',
        vertical: this._d.verticalConstraint ?? 'MIN',
      };
    }
    set constraints(v: { horizontal: string; vertical: string }) {
      const map: Record<string, string> = {
        MIN: 'MIN',
        MAX: 'MAX',
        CENTER: 'CENTER',
        STRETCH: 'STRETCH',
        SCALE: 'SCALE',
      };
      editRaw(this.id, {
        horizontalConstraint: map[v.horizontal] ?? 'MIN',
        verticalConstraint: map[v.vertical] ?? 'MIN',
      });
    }
  };
}
