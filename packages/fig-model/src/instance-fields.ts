/**
 * Root fields an instance takes from its main component (when created or swapped, and when the
 * component changes). Figma stores them on the instance as a copy; an instance's own different
 * value is recorded as an override at guidPath [component id] (verified, docs/fig-format.md §8.1).
 */
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
