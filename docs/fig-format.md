# .fig file format: working notes

A living reference for Figma's `.fig` export format, as observed in the files in `references/` and confirmed by importing Figtional-written files into Figma. **Add to this document whenever you learn something new** (field semantics, defaults Figma expects, things that broke an import).

Conventions:
- Each claim is *verified* (seen in the reference files, or confirmed by a Figma import logged in [compat-log.md](compat-log.md)) or *assumed*. Open questions are collected in §14.
- Each topic first describes what Figma stores, then **"Figtional writes"**: how Figtional writes that data and what confirmed it. Import checks are cited with the build they were run on, as in compat-log (e.g. "0.1.4 + `a2b1a60`").
- Section numbers are cited from code comments and other docs. Update those citations when renumbering.

Status (0.2.0): 5 reference exports, `fig-kiwi` versions **101** and **106**, schemas with 674–675 definitions. All five decode and **re-encode byte for byte** with `packages/fig-format`, including the 270 MB Futurice.com UI file (re-checked for 0.2.0; the four small files are covered by `packages/fig-format/src/fig-file.test.ts`).

**Contents:** 1 Container · 2 canvas.fig and the message · 3 Blobs · 4 Nodes and the tree · 5 Paints, effects and images · 6 Auto layout · 7 Text · 8 Components and instances · 9 Variables · 10 Styles · 11 Prototypes · 12 Writing rules · 13 Rendering · 14 Open questions · 15 Reference files · 16 Inspecting files

---

## 1. Container (ZIP), verified

`.fig` is a ZIP archive (`PK\x03\x04`):

| Entry | Content |
|---|---|
| `canvas.fig` | The document, in the fig-kiwi binary format (§2) |
| `meta.json` | Export metadata (§1.1) |
| `thumbnail.png` | File thumbnail (size in `meta.json.client_meta.thumbnail_size`) |
| `images/` | Directory entry |
| `images/<40-hex sha1>` | Image files, no extension. The name is the SHA-1 of the file, which `Paint.image.hash` refers to (20 raw bytes → hex). |

- **Order** seen in the files: `canvas.fig`, `thumbnail.png`, `meta.json`, `images/`, `images/*`. Keep it when writing.
- **Compression:** `canvas.fig`, `thumbnail.png` and `images/*` are STORED (method 0); `meta.json` is DEFLATE (method 8). Flags `0x0808` (data descriptor + UTF-8 names). No ZIP64.
- **Figtional writes** unchanged entries as raw copies (no recompression) and puts sizes in the local header instead of data descriptors. Figma imports this (verified, every import check since 0.1.0).

### 1.1 meta.json, verified
```json
{
  "client_meta": {
    "background_color": { "r": 0.1176, "g": 0.1176, "b": 0.1176, "a": 1 },
    "thumbnail_size": { "width": 400, "height": 170 },
    "render_coordinates": { "x": -1138, "y": 617, "width": 3130, "height": 1326.77 }
  },
  "file_name": "Playground",
  "developer_related_links": [],
  "exported_at": "2026-11-24T15:28:44.923Z"
}
```
`file_name` is the Figma file name (used for the default file key). `render_coordinates` is the canvas area shown in the thumbnail.

## 2. canvas.fig and the message, verified

```
offset 0   : "fig-kiwi"            8 bytes ASCII magic
offset 8   : uint32 LE version     (101 or 106 seen)
offset 12  : chunk*                each = uint32 LE byteLength + bytes
```
- **Chunk 0: the kiwi binary schema**, raw-deflate compressed. Decode with `kiwi-schema.decodeBinarySchema`, then `compileSchema`. Every file carries its own schema; never hardcode one.
- **Chunk 1: the message**, zstd compressed (magic `28 b5 2f fd`). Older files may use deflate, so pick the decompressor by the magic bytes. The root type is `Message`; decode it with `compiled.decodeMessage(bytes)`.
- The schema has a very large number of types (Slides, FigJam, Sites/CMS, Make code layers, animation, AI chat…). Ignore what you don't need, but **pass everything through unchanged**.
- kiwi decodes enum values to names (an unknown value would decode to `undefined`, but the embedded schema always knows them). kiwi's encoder skips deprecated fields (none exist in the current schemas).

**Field order makes output byte-identical (verified).** kiwi messages are `(field id, value)*` pairs and any order is valid, but Figma's order is neither schema order nor id order (e.g. `Message.originFileKey`, id 47, comes before `nodeChanges`, id 4). kiwi's generated encoder writes schema order, so re-encoding gave the same length but different bytes. kiwi's decoder keeps wire order in the object's key order, so `OrderedEncoder` (`packages/fig-format/src/kiwi.ts`) writes each object's fields **in its own key order**. Unmodified messages come out byte-identical and new fields are appended. Don't rebuild node objects in a different key order.

**Figtional writes** the original chunk 0 bytes unchanged and the message zstd-compressed (`node:zlib`, Node 22.15+). Figma imports this (verified, M4 import check, 0.1.0).

The message:
```ts
{
  type: "NODE_CHANGES",
  sessionID: number, ackID: number,
  originFileKey?: string,
  nodeChangeOrder?: ...,
  nodeChanges: NodeChange[],      // flat list of all nodes
  blobs: { bytes: Uint8Array }[]  // geometry, vector networks, glyphs; referenced by index (§3)
}
```
Sizes: Playground 33 nodes / 151 blobs; TTRPG stuff 4,378 / 1,043; Futurice.com UI 17,228 / 3,566.

## 3. Blobs, verified

`message.blobs[i].bytes` is referenced by `commandsBlob`, `vectorNetworkBlob`, etc. Codecs: `packages/fig-format/src/blobs.ts`. Every geometry, vector network and glyph blob in the four small references decodes without leftover bytes.

- **Path commands** (`fillGeometry`, `strokeGeometry`, glyphs): `[u8 cmd][f32 LE args…]*` with `0` = close, `1` = moveTo(x,y), `2` = lineTo(x,y), `3` = quadTo(cx,cy,x,y), `4` = cubicTo(c1x,c1y,c2x,c2y,x,y). Glyph blobs start with a `0` (close) before the first moveTo; skip it.
- **Vector network** (`vectorData.vectorNetworkBlob`): header `[u32 vertexCount][u32 segmentCount][u32 regionCount]`; vertex `[u32 styleID][f32 x][f32 y]` (12 bytes); segment `[u32 styleID][u32 start][f32 tangentStart.x][f32 tangentStart.y][u32 end][f32 tangentEnd.x][f32 tangentEnd.y]` (28 bytes); region `[u32 (styleID << 1) | windingBit][u32 loopCount]`, then per loop `[u32 count][u32 segmentIndex…]`.
  - **Tangents are relative to their own vertex:** a segment's control points are `start + tangentStart` and `end + tangentEnd`; straight segments have zero tangents (verified: a circle rebuilt from path data matches Responsive example `2:34`, `vector-path.test.ts`).
  - Coordinates are in `vectorData.normalizedSize` space and scaled to `size` when drawn (verified: Responsive example `2:49` has normalizedSize 6×6 and size 5.5×5.5).
  - A region's loops list segment indices. Stroke-only vectors have no regions. Winding bit 1 = NONZERO, 0 = ODD (*assumed*; NONZERO regions match NONZERO fill geometry in TTRPG).
- **Glyph outlines** are in em units with y pointing up (verified by rendering, §13).

**Figtional writes** vectors (`createNodeFromSvg`, `createVector`, `vectorPaths`, `setVectorNetworkAsync`) with only `vectorData`: the network blob plus `normalizedSize` = `size`, the node placed at its paths' bounds, and no `fillGeometry`/`strokeGeometry`. Figma recomputes the geometry; the SVG icon imported correctly (verified, new-tools import check, 0.1.4 + `a2b1a60`, released as 0.2.0). Figtional's renderer draws such vectors from the network.

## 4. Nodes and the tree, verified

### 4.1 Identity and tree
- `guid: { sessionID, localID }` → node id `"sessionID:localID"` (Figma URL form: `node-id=sessionID-localID`).
- `phase: "CREATED"` on every node in an export.
- `parentIndex: { guid: <parent guid>, position: <string> }`. `position` is a **fractional index** (printable ASCII such as `"!"`, `"#"`, `"~"`). Order siblings by comparing the strings by code unit. To insert between two siblings, generate a string that sorts strictly between them.
- The node list is **not** in tree order. Build the tree from `parentIndex`.
- Figma's SVG exports use node ids in clip-path ids (`clip0_707_7816` → node `707:7816`), which helps match exports to nodes.

### 4.2 Document and pages
- `DOCUMENT` (`0:0`, name "Document", `documentColorProfile: "SRGB"`)
  - `CANVAS` = page: `name`, `backgroundColor`, `backgroundEnabled`, `isPageDivider` (pages like `---------`), `internalOnly`.
  - The page **`Internal Only Canvas`** (`internalOnly: true`) holds internal data: variables and collections (parent `0:2` in TTRPG stuff), style definitions, and copies of library components. Hide it in the UI.

### 4.3 Node types seen
`DOCUMENT, CANVAS, FRAME, TEXT, ROUNDED_RECTANGLE, ELLIPSE, LINE, VECTOR, REGULAR_POLYGON, BOOLEAN_OPERATION, SECTION, SYMBOL, INSTANCE, BRUSH, VARIABLE_SET, VARIABLE`

- **Groups** are `FRAME`s with `resizeToFit: true` (every "Group N" layer has it). Some resize-to-fit frames have fills, which groups can't, so `fig-model` treats a node as a group only when it also has no fills, strokes or auto layout (*assumed*). Groups have `frameMaskDisabled: false` yet don't clip in Figma (*assumed*).
- `BRUSH` = brush/pencil strokes (`brushType`, `scatterStrokeSettings`).

**Plugin API ↔ .fig names:**

| Plugin API | .fig |
|---|---|
| `PAGE` | `CANVAS` |
| `COMPONENT` | `SYMBOL` |
| `COMPONENT_SET` | `FRAME` + `isStateGroup` |
| `GROUP` | `FRAME` + `resizeToFit` (see above) |
| `RECTANGLE` | `ROUNDED_RECTANGLE` |
| `fills` / `strokes` | `fillPaints` / `strokePaints` |
| `layoutMode` etc. | `stack*` (§6) |
| `clipsContent` | `!frameMaskDisabled` |
| `mainComponent` | `symbolData.symbolID` |
| `x`, `y`, `rotation` | `transform` |
| `width`, `height` | `size` |

### 4.4 Common fields
- `size: { x, y }`; `transform: { m00, m01, m02, m10, m11, m12 }`, a 2×3 affine matrix **relative to the parent** (`m02`/`m12` = x/y).
- `opacity`, `visible`, `locked`.
- `fillPaints`, `strokePaints`, `strokeWeight`, `strokeAlign` (`CENTER|INSIDE|OUTSIDE`), `strokeJoin`, `strokeCap`, `dashPattern`; independent borders: `borderStrokeWeightsIndependent`, `border{Top,Right,Bottom,Left}Weight`.
- Corners: `cornerRadius`, `rectangleCornerRadiiIndependent`, `rectangle{TopLeft,TopRight,BottomLeft,BottomRight}CornerRadius`.
- `effects` (shadows, blurs; §5).
- `fillGeometry` / `strokeGeometry`: precomputed outlines (`commandsBlob`, §3). Derived data: Figma recomputes them for new and resized shapes on import (verified, M8 and new-tools import checks).
- `vectorData: { vectorNetworkBlob, normalizedSize }` for VECTOR, BRUSH and shapes.
- Constraints: `horizontalConstraint`, `verticalConstraint`, `proportionsConstrained`.
- `frameMaskDisabled: false` means the frame **clips its content**.
- `exportSettings`, `editInfo` (user id + timestamps), `pluginData`.

## 5. Paints, effects and images, verified

```jsonc
// SOLID
{ "type": "SOLID", "color": { "r":1,"g":1,"b":1,"a":1 }, "opacity": 1, "visible": true,
  "blendMode": "NORMAL", "authoredColor": { "space": "DEFAULT", "c0":1,"c1":1,"c2":1,"c3":1 } }
// IMAGE
{ "type": "IMAGE", "opacity": 1, "visible": true, "blendMode": "NORMAL",
  "transform": { "m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":0 },
  "image": { "hash": <20 bytes sha1>, "name": "kuva" },
  "imageThumbnail": { "hash": <20 bytes>, "name": "kuva" },
  "animationFrame": 0, "imageScaleMode": "FILL", "imageShouldColorManage": true,
  "rotation": 0, "scale": 0.5, "originalImageWidth": 486, "originalImageHeight": 855,
  "thumbHash": <bytes>, "altText": "" }
```
- Colours are floats from 0 to 1.
- Gradients use `stops` and a `transform` that maps node-normalised space (0..1) into paint space; so do `STRETCH` images (Plugin API `CROP`) (verified by rendering, §13).
- A paint bound to a variable has `colorVar` (§9.2); `color` still holds a resolved value.
- `imageThumbnail` points at a second, smaller image in `images/` (its hash differs from `image`).
- Effects: `{ type, visible, radius, color, authoredColor, offset, spread, blendMode, showShadowBehindNode }`. Types seen: `DROP_SHADOW`, `INNER_SHADOW`, `BACKGROUND_BLUR`; `LAYER_BLUR` is in the schema but not in the references (*assumed* to work alike). A drop shadow's `radius` is the blur radius.

**Figtional writes** new images to `images/<sha1 of the bytes>`, with `image` and `imageThumbnail` both pointing at that full image, and `originalImageWidth`/`originalImageHeight` read from the PNG/JPEG/GIF header. Figma accepts the full image as its own thumbnail (verified, new-tools import check, 0.1.4 + `a2b1a60`, released as 0.2.0).

## 6. Auto layout, verified (fields seen in the references)

| .fig field | Plugin API |
|---|---|
| `stackMode` | `layoutMode` (`HORIZONTAL`/`VERTICAL`/`NONE`; `GRID` is in the schema, not seen) |
| `stackSpacing` | `itemSpacing` |
| `stackCounterSpacing` | `counterAxisSpacing` |
| `stackHorizontalPadding` / `stackPaddingRight` | `paddingLeft` / `paddingRight` |
| `stackVerticalPadding` / `stackPaddingBottom` | `paddingTop` / `paddingBottom` |
| `stackPrimarySizing` / `stackCounterSizing` | `primaryAxisSizingMode` / `counterAxisSizingMode` |
| `stackPrimaryAlignItems` / `stackCounterAlignItems` | `primaryAxisAlignItems` / `counterAxisAlignItems` |
| `stackChildAlignSelf` | `layoutAlign` |
| `stackChildPrimaryGrow` | `layoutGrow` |
| `stackPositioning` | `layoutPositioning` (`ABSOLUTE`) |
| `bordersTakeSpace` | `strokesIncludedInLayout` |
| `minSize` / `maxSize` | `minWidth/minHeight` / `maxWidth/maxHeight` |
| `stackLayoutVersion` | internal; keep it |

The stored `size` and `transform` already contain the **resolved** layout, so unedited files need no layout pass. After an edit, `fig-model`'s `computeLayout` recomputes it.

**Semantics** (verified by re-laying out every auto-layout frame in the references against Figma's stored result: Responsive 100%, TTRPG 99.4%, Futurice 98.3% of children identical within 0.5 px; `packages/fig-model/src/layout.test.ts`):
- **Defaults:** fields holding the enum's first value are omitted (alignment MIN, align-self AUTO, counter sizing FIXED, no wrap). **Primary sizing is the exception:** Figma writes `stackPrimarySizing: FIXED` explicitly and omits it when the frame hugs. `RESIZE_TO_FIT` and `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE` both mean hug.
- **Padding:** `stackPaddingRight`/`stackPaddingBottom` default to the left/top value. With `bordersTakeSpace: true` and visible strokes, the stroke widths (per side when `borderStrokeWeightsIndependent`) are added to the padding.
- **Justify:** `SPACE_EVENLY` and `SPACE_BETWEEN` both behave as Figma's "auto" spacing (space between; one item is centred). `SPACE_AROUND`: half gaps at both ends.
- **Hug:** primary = sum of children + spacing + padding; counter = largest child + padding. **An empty auto-layout frame keeps its stored ("implicit") size.**
- **Fill:** `stackChildPrimaryGrow > 0` shares the free primary space equally; `stackChildAlignSelf: STRETCH` fills the counter axis. **Hug wins over a stale fill flag on the same axis:** an auto-layout child that hugs along that axis, or text that auto-sizes along it (`textAutoResize` HEIGHT → vertical; WIDTH_AND_HEIGHT → both), keeps its content size.
- **min/max:** `minSize`/`maxSize` (`{ value: { x, y } }`, null = unset) clamp hug and fill sizes. A stretch child capped by `maxSize` is placed by the parent's alignment.
- **Absolute** (`stackPositioning: ABSOLUTE`) and hidden children are skipped. Rotated children take up their rotated bounding box.
- **Instance sublayers** are not reliable ground truth: Figma stores `derivedSymbolData` for only some of them, and the rest keep the component's geometry even when a property hides a sibling (e.g. TTRPG "Statbar"). Figma lays them out at draw time, so `computeLayout` keeps an instance's stored size unless it is marked dirty.

**Figtional writes** Plugin API `primaryAxisAlignItems: 'SPACE_BETWEEN'` as `SPACE_EVENLY`, the value Figma's own files use for "auto" spacing.

## 7. Text, verified

- **`textData` is the source of truth:** `characters`, `lines[]` (list and indent info per line), and per-character style runs: `characterStyleIDs[i]` → `styleOverrideTable[styleID]` (fills per run verified by rendering, §13; other overridden properties *assumed* alike).
- **Style fields:** `fontName { family, style, postscript }`, `fontSize`, `lineHeight`, `letterSpacing`, `textAlignHorizontal`, `textAlignVertical`, `textAutoResize`, `textCase`, `textDecoration…`, `paragraphSpacing`, `paragraphIndent` (schema; not seen in the references), `maxLines`, `textTruncation`, `hyperlink`, `styleIdForText`.
- **Line height** (verified against stored layouts): `{ units: 'RAW', value: v }` = Plugin API `PERCENT` v × 100 % of the font size (RAW 1.5 at 24 px = 36 px); `{ units: 'PERCENT', value: 100 }` = Plugin API `AUTO`, the font's natural line height (`derivedTextData.fontMetaData[].fontLineHeight` × size, e.g. Inter 1.21); `PIXELS` = px. Text box height = lines × round(line height) (41.6 px × 3 lines = 126). Auto-width text is `ceil(advance width)` wide.
- **`derivedTextData` is a cache:** `layoutSize`, `baselines[]` (position, width, lineHeight, character range), `glyphs[]` (`commandsBlob` → outline, position, fontSize, advance), `decorations` (underline/strike rectangles). Unedited text can be drawn from it without the fonts. **Invalidate it on any text or style edit.**
- Version fields (`fontVersion`, `textUserLayoutVersion`, `textBidiVersion`, `textExplicitLayoutVersion`): keep them.

**Figtional writes** edited text by changing `textData.characters` (that is enough) and **removing** `derivedTextData`, also when only a style property changes: Figma recomputes the layout on import, whether the cache is removed or left stale (verified, M4 import check). Figtional measures edited text with installed fonts for its own layout and rendering. The layer `name` is not updated by the file format: like the Plugin API, Figtional renames layers with `autoRename: true` when their text changes.

## 8. Components and instances, verified

### 8.1 Instances
```jsonc
"symbolData": {
  "symbolID": { "sessionID": 3, "localID": 71 },   // → SYMBOL node
  "symbolOverrides": [ { "guidPath": { "guids": [ {…} ] }, "size": { "x":300, "y":53 }, … } ],
  "uniformScaleFactor": 1
},
"derivedSymbolData": [...],      // Figma's laid-out values per inner node, keyed by guid path
"componentPropAssignments": [...]
```
- A component (`SYMBOL`) has `componentPropDefs`, `variantPropSpecs` (variants), `isSymbolPublishable` and `sharedSymbolVersion`.
- An instance stores **no children** in `nodeChanges`. Its content = a clone of the component's subtree, plus `symbolOverrides` keyed by `guidPath`, plus `derivedSymbolData`. Implemented in `FigDocument.expandInstance` (TTRPG and Futurice: 33,137 instances expanded, none missing).
- **`guidPath`:** `[a]` targets node `a` anywhere in the component (**intermediate frames are not listed**); `[a, b]` targets `b` inside nested instance `a`. The path lists only the nested instances on the way, plus the target. An override with the path `[<symbolID>]` (the component itself) also appears (seen with `size`).
- **Ids in paths are override ids** (verified, Futurice): nodes of components **copied from a library** carry `overrideKey` (their id in the library), and `guidPath` and `derivedSymbolData` use it instead of the local guid. Local components have no `overrideKey`, so their guid is used. `fig-model`'s `overrideId(node)` implements this; before it, every override on a library component was silently ignored.
- **Precedence** (implemented, *assumed* correct): component values < overrides stored on the nested instance itself < overrides from enclosing instances < `derivedSymbolData` (Figma's laid-out `size`, `transform`, `fillGeometry`, `strokeGeometry`, `derivedTextData`).
- Override fields seen (TTRPG): `size`, `textData`, `stackPrimarySizing`/`stackCounterSizing`, `componentPropAssignments`, `overriddenSymbolID` (**instance swap**), `fontSize`, `fontName`, `strokePaints`, `fillPaints`, `visible`, corner radii, paddings, `styleIdForText`, `overrideLevel`, text layout versions.
- **Plugin API ids** of instance sublayers: `I<instance id>;<override id>`, one more `;<id>` per nested instance (e.g. `I1:2;3:4;5:6`). Intermediate frames add no segments; same ids as in `guidPath`.

### 8.2 Component properties
- **Definitions** (TTRPG, Futurice): `componentPropDefs[]: { id, name, initialValue, sortPosition, type, preferredValues, varValue }`, `type` `TEXT` | `BOOL` | `INSTANCE_SWAP` | `VARIANT` (also `SLOT`, `NUMBER`, … in the schema). `initialValue` is `{ textValue: TextData }`, `{ boolValue }` or `{ guidValue }`; `varValue` repeats it as VariableData (`TEXT_DATA` with `textDataValue`, `BOOLEAN`, `SYMBOL_ID` with `symbolIdValue: { guid }`; variant definitions use `STRING` ''). `INSTANCE_SWAP` has `preferredValues.instanceSwapValues: [{ type: COMPONENT | COMPONENT_SET, key }]`.
- **Bindings** of a layer are written twice: `componentPropRefs: [{ defID, componentPropNodeField: TEXT_DATA | VISIBLE | OVERRIDDEN_SYMBOL_ID }]` and `parameterConsumptionMap.entries: [{ variableData: { value: { propRefValue: { defId } }, dataType: PROP_REF, resolvedDataType }, variableField }]`.
- **Instance values:** `componentPropAssignments: [{ defID, value: { textValue | boolValue | guidValue }, varValue, legacyDerivedTextData? }]`. `legacyDerivedTextData` (on the assignment, not in `value`) is Figma's layout of the assigned text.

### 8.3 Component sets and variants
- A **set** is a `FRAME` with `isStateGroup: true` holding all definitions, plus `stateGroupPropertyValueOrders: [{ property, values[] }]`.
- A **variant** is a `SYMBOL` named `"Prop=Value, Prop2=Value"`, with `variantPropSpecs: [{ propDefId, value }]` for the `VARIANT` definitions. Its own `componentPropDefs` hold a **stub** `{ id, parentPropDefId }` for every non-variant definition, where `parentPropDefId` is the set's definition. Layers inside a variant bind to the stub's id.
- **Instances of a variant key their values by that variant's stub `id`** (verified: TTRPG 1,811 and Futurice 2,583 assignments, none using the set-level id). Figma **ignores set-level ids on import**: such instances show their default values (components import check, 0.1.3 + `734c0da`). For a plain component, `defID` is its own definition id.
- Variant definition ids in Figma's files look random (e.g. `2875058928:1474337614`).

### 8.4 Library and missing components
- Library components used by the file are **embedded** as `SYMBOL`s with `sourceLibraryKey`, `componentKey`, `publishID` and `sharedSymbolVersion`, under frames on `Internal Only Canvas` (e.g. `Mutabor / Components / Input Field`). Instances refer to them through `symbolData.symbolID` like local ones. Futurice: 818 SYMBOLs, 735 of them library copies.
- A component that is truly missing from the file has not been seen yet (§14).

### 8.5 Figtional writes
- Definition and stub ids are session guids; Figma accepts them (verified, components import check, 0.1.3 + `1d8757a`, released as 0.1.4).
- A component missing from the file is drawn as a labelled placeholder, with no attempt to approximate it.
- When an instance switches variant, its values are re-keyed to the new variant's stubs.
- Text bound to a property is changed by setting the property value on the instance that owns it, because property values take precedence over overrides. Other changes inside instances become `symbolOverrides` entries.
- After changing instance content, Figtional re-lays it out and writes `derivedSymbolData` entries itself (empty `fillGeometry`/`strokeGeometry` for resized shapes, no `derivedTextData` for changed text).

## 9. Variables, verified

### 9.1 Nodes
```jsonc
// VARIABLE_SET (collection)
{ "type": "VARIABLE_SET", "name": "Variable collection",
  "variableSetModes": [ { "id": { "sessionID":707,"localID":0 }, "name": "Mode 1", "sortPosition": "!" } ],
  "isCollectionExtendable": true }
// VARIABLE
{ "type": "VARIABLE", "name": "text", "variableSetID": { "guid": { … set guid … } },
  "variableResolvedType": "COLOR",
  "variableDataValues": { "entries": [
    { "modeID": { … }, "variableData": { "value": { "colorValue": { "r":0,"g":0,"b":0,"a":0.2 } },
      "dataType": "COLOR", "resolvedDataType": "COLOR" } } ] } }
```
- Names use `/` for groups. Both live on `Internal Only Canvas`.
- **References** to variables and collections are `{ guid }` for local ones and `{ assetRef: { key, version } }` for library ones (matched by the node's `key`). The schema types `VariableID` and `VariableSetID` both allow either form.
- Collections in Futurice: Colors [Light, Dark], Brand Colors, Primitive Colors, Semantic Colors [Light, Dark], Responsive [Desktop, Tablet, Phone], Responsive [Desktop, Mobile]. All 1,157 `colorVar` aliases resolve inside the file.

### 9.2 Bindings (Futurice)
- **Paint colour:** `paint.colorVar = { value: { alias: <ref> }, dataType: "ALIAS", resolvedDataType: "COLOR" }`. `paint.color` still holds a resolved value (see §9.3 for which).
- **Other fields:** `node.variableConsumptionMap.entries[]: { variableData: { value: { alias }, dataType: "ALIAS", resolvedDataType: "FLOAT" }, variableField: "STACK_PADDING_LEFT" | "STACK_PADDING_TOP" | … }` (1,144 nodes).
- Component property bindings use `parameterConsumptionMap` with `propRefValue` (§8.2; 2,447 nodes).

### 9.3 Explicit modes
- `variableModeBySetMap: { entries: [{ variableSetID, variableModeID }] }` on a frame picks a mode per collection for its subtree (47 frames, 67 entries in Futurice, all library collections referenced by `assetRef`). The nearest ancestor wins; otherwise the collection's first mode.
- **Inline colours don't follow explicit modes in Figma's files:** under explicit modes, a bound paint's inline `color` equals the effective mode's value in only 155 cases, the default mode's value in 1,632 and neither in 1,895 (Futurice). Figma's PNG exports resolve the variable in the effective mode (§13).
- **But after importing a file, Figma shows the stored inline colour**: it doesn't re-resolve bound colours right away, even though its own exports resolve them live (verified, new-tools import check: a Dark card that kept its Light inline colour imported light).

**Figtional writes** `{ guid }` for local collections (verified: Figma shows the mode in the Layer panel) and `{ assetRef: { key, version } }` for embedded library collections. When it sets or clears a mode, it also rewrites the stored values of everything bound in the subtree (paint colours, and fields in `variableConsumptionMap` such as text, visibility and numbers) to the effective mode's values (verified: the card then imported dark, new-tools import check, 0.1.4 + `a2b1a60`, released as 0.2.0).

## 10. Styles, verified

- **Definitions** are ordinary nodes on `Internal Only Canvas` with `styleType` (`FILL`, `TEXT`, `EFFECT`, `GRID`):
  - fill styles: hidden, locked `ROUNDED_RECTANGLE` 100×100 with `fillPaints`;
  - grid styles: hidden, locked `FRAME` 100×100 with `layoutGrids`;
  - text styles: `TEXT` nodes with the style's typography and the sample text `Rag 123`.

  Fields: `name`, `isPublishable`, `styleType`, `version` ("session:counter"), `sortPosition` (newer files; orders the styles list), `styleDescription`. Published and library styles also have a 40-hex `key`. (TTRPG, Futurice, Prototyping in Figma.)
- **References** on nodes: `styleIdForFill`, `styleIdForStrokeFill`, `styleIdForText`, `styleIdForEffect`, `styleIdForGrid`, either `{ guid }` (unpublished local styles, e.g. all 348 in TTRPG) or `{ assetRef: { key, version } }` such as `{ key: "<40 hex>", version: "3:42" }` (published or library styles), resolved by matching the style node's `key`.
- **Values are inline:** a node with `styleIdForFill` still has its own `fillPaints`. A missing style only loses the *name*, never the look.
- Futurice: 151 style nodes and 9,058 style references, all resolved inside the file. Prototyping in Figma: 22 `assetRef` references, all resolved.

**Figtional writes** new styles in the unpublished local form, without a key (its Plugin API reports a key derived from the guid, and ids as `S:<key>,<node id>` like Figma). **Effect styles** are written like fill styles, as a hidden `ROUNDED_RECTANGLE` with `effects`: no reference file has one, and Figma accepts this form (verified, new-tools import check, 0.1.4 + `a2b1a60`, released as 0.2.0). Applying a style sets the reference field and copies its values inline; changing a style rewrites the inline values of every node using it (and of instance overrides); setting a value directly on a node removes the reference, as Figma does.

## 11. Prototypes, verified

There are two generations. Figma doesn't migrate the old format when it opens or saves a file: `Prototyping in Figma.fig`, exported from current Figma (at Figtional 0.1.0), still has both forms side by side.

### 11.1 Modern (Responsive example.fig)
- **Flow starting point**, on a top-level frame: `"prototypeStartingPoint": { "name": "Figma showcase · Mobile", "description": "", "position": "!" }`. `position` orders the flows (fractional index).
- **Interactions**, on any node:
  ```jsonc
  "prototypeInteractions": [ {
    "id": { "sessionID": 3, "localID": 2 },
    "event": { "interactionType": "ON_CLICK" },
    "actions": [ {
      "transitionNodeID": { "sessionID": 2, "localID": 7 },   // destination top-level frame
      "transitionType": "DISSOLVE", "transitionDuration": 0.2, "easingType": "OUT_CUBIC",
      "connectionType": "INTERNAL_NODE", "navigationType": "NAVIGATE",
      "transitionResetScrollPosition": true } ],
    "isDeleted": false, "stateManagementVersion": 1 } ]
  ```
  Interaction ids use their own session (3), separate from the node ids (2).
- `ConditionalActions` and `PrototypeVariableTarget` (variables and conditionals) are in the schema but not in the references.

### 11.2 Legacy (Prototyping in Figma.fig; all guids have `sessionID: 0`)
- **Page level** (`CANVAS`), instead of named flows:
  ```jsonc
  "prototypeStartNodeID": { "sessionID": 0, "localID": 2 },
  "prototypeDevice": { "type": "PRESET", "size": { "x": 375, "y": 812 },
                       "presetIdentifier": "APPLE_IPHONE_X_SPACE_GREY", "rotation": "NONE" }
  ```
- **Node level:** the first interaction is stored as **flat fields on the node**, *and* duplicated in `prototypeInteractions` (with `id` `0:0` and no `stateManagementVersion`): `transitionNodeID`, `interactionType` (`ON_CLICK`), `connectionType` (`INTERNAL_NODE` | `CLOSE` | `NONE`), `navigationType` (`NAVIGATE` default/absent | `OVERLAY`), `transitionType` (`MOVE_FROM_BOTTOM`, `MOVE_FROM_RIGHT`, …; absent = instant), `transitionDuration`, `easingType` (`INOUT_CUBIC`), `transitionPreserveScroll`.
- The **"no destination" sentinel** is guid `{ sessionID: 4294967295, localID: 4294967295 }` (uint32 max), seen with `interactionType: "NONE"` / `connectionType: "NONE"`. Treat it as null.
- Leftovers with no active interaction happen (`transitionNodeID` with `event.interactionType: "NONE"`, or an empty action `{}`). Ignore them when drawing and keep them when writing.

### 11.3 Both generations
- **Overlays:** `overlayPositionType` (`BOTTOM_CENTER`, …) on the destination frame. A close button uses `connectionType: "CLOSE"`.
- **Scrolling:** `scrollDirection` (`HORIZONTAL`, …) on frames that overflow. `scrollBehavior: "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME"` marks fixed elements (here a status-bar component).
- Interactions can live on `SYMBOL`s and are inherited by their `INSTANCE`s unless overridden.
- Plugin API mapping: `node.reactions[]` (`trigger.type`, `actions[].type: "NODE"|"CLOSE"|"BACK"`, `destinationId`, `navigation`, `transition`), `page.flowStartingPoints`, `page.prototypeStartNode`, `frame.overflowDirection`, `node.scrollBehavior`, `frame.overlayPositionType`.

### 11.4 Figtional writes (not implemented yet)
Policy, to be confirmed by an experiment before implementing:
- **Read:** `prototypeInteractions` is the source of truth; fall back to the flat fields only when it is absent.
- **Write:** always write `prototypeInteractions`. If a node already has the legacy flat fields, keep them **in sync** with the first interaction (update them, or clear them when that interaction is removed). Never add legacy fields to nodes that don't have them. Keep page-level `prototypeStartNodeID`/`prototypeDevice` as they are; new flows go in as `prototypeStartingPoint`.
- **Experiment:** in Figma, make one prototype edit (change a destination, add an interaction, remove one) on a copy of `Prototyping in Figma.fig` and of `Responsive example.fig`, export both, and diff the decoded nodes against the originals. Copy exactly what Figma does with the flat fields, and record the result here and in `compat-log.md`.

## 12. Writing rules (Figtional)

Rules that apply to every edit; topic-specific ones are in each section's "Figtional writes" part. Implemented in `fig-model/src/edit.ts` (`EditSession`) and the Plugin API layer (`packages/mcp-server`).

- **Schema and key order:** re-encode with the file's own schema chunk, unchanged, and keep each object's key order; append new fields at the end (§2).
- **Unknown data survives:** nodes are edited in place, never rebuilt from a model, so fields and node types Figtional doesn't know are kept.
- **New nodes** get guids in a fresh session (largest existing `sessionID` + 1) and fractional-index positions among their siblings. Variables, collections and styles go on `Internal Only Canvas` (created if missing).
- **Derived data:** new nodes have no `fillGeometry`, `strokeGeometry` or `derivedTextData`; resizing removes them (and an instance's `derivedSymbolData`); editing text removes `derivedTextData`. Figma recomputes the geometry and text layout on import (verified, M4, M8 and new-tools import checks), and instance layout after component edits (components import check). Vectors get only `vectorData` (§3).
- **Older and newer forms of the same data:** write the newer form, keep older fields that are already present in sync, and never add or strip them (e.g. the legacy prototype fields, §11.4).
- **Saving** is atomic (temp file + rename, with a `.bak` copy); new images are added to `images/` (§5).

## 13. Rendering, verified against Figma's exports

`packages/fig-render` turns nodes into SVG (and PNG via resvg). What made it match Figma:
- **Use Figma's stored geometry.** `fillGeometry` gives the exact outlines (corner radii, smoothing, booleans, vectors), so the renderer doesn't reimplement shapes. Nodes without geometry fall back to rect/ellipse paths; vectors without geometry (written by Figtional) are drawn from their network.
- **`strokeGeometry` for INSIDE and OUTSIDE strokes is a *centred* outline twice the stroke weight** (±weight around the edge). Clip it to the shape for INSIDE and mask it to outside the shape for OUTSIDE; CENTER strokes are used as stored. Not clipping made every inside border twice as thick.
- **Bound colours are resolved in the effective mode** (§9.3): a solid paint with `colorVar` is drawn with the variable's value in the mode in effect at the node (nearest `variableModeBySetMap` per collection, following aliases), not the inline `color`. Futurice "Home - Landing Page light" went from 2.17% to 2.02% differing pixels; the other 22 exports were unchanged (0.2.0).
- **Glyph outlines are in em units with y pointing up.** Draw each at `translate(position) scale(fontSize, -fontSize)`. Per-character fills come from `textData.characterStyleIDs[firstCharacter]` → `styleOverrideTable[styleID].fillPaints`. Underlines and strikethroughs are the rectangles in `derivedTextData.decorations`.
- **Gradient and `STRETCH` image transforms** map node-normalised space into paint space: draw the unit gradient or image through `scale(w, h) · inverse(transform)`.
- **Export bounds = render bounds:** a frame that doesn't clip exports including its overflowing children (Discover (overflow behavior): 375 wide, 1436 px export). Drop shadows extend the bounds. **Sections export at their own bounds.** Exports are capped at 4096 px on the longest side (Figma scales down).
- Boolean operations draw their own `fillGeometry` (the result), never their operands.
- Masks: a child with `mask: true` masks its later siblings (`maskType` ALPHA / VECTOR / LUMINANCE).
- Drop shadows: SVG `stdDeviation = radius / 2` matches well.

Render-diff results (differing pixels, pixelmatch threshold 0.15) are printed by `packages/fig-render/src/render-diff.test.ts`, whose failure thresholds are looser (3–6%). Measured in 0.2.0: the 21 exports of the small references are all ≤ 2% different (most < 0.1%); what remains is anti-aliasing and 1 px shadow edges.

## 14. Open questions and assumptions

- **Futurice "About/L" colours (unexplained since 0.1.0):** in Figma's PNG export, several sections are dark green, but in the `.fig` their fill is bound to `background/brown-1`, beige in both Light and Dark, with no explicit mode or colour override above. All texts and images match after the override fixes, and resolving variables in the effective mode (§13) didn't change this. The export probably reflects a newer library state than the file; another explanation to watch for is library variable values being re-resolved at export.
- **Missing components:** not yet seen in a file. Expected when a file is exported without its libraries; the viewer then shows a placeholder, and `derivedSymbolData` may still hold partial data (*assumed*).
- **fig-kiwi version:** 101 and 106 appear in files exported on the same day (Responsive example and Prototyping in Figma are 101), so it seems to reflect the file, not the exporter (*assumed*). `figtional validate` warns about unseen versions.
- **Deflate message chunks:** it is unverified whether Figma accepts a deflate-compressed message; Figtional always writes zstd.
- **Assumed, consistent with every file so far:** the vector network winding bit (§3), group detection and group clipping (§4.3), override precedence (§8.1), non-fill properties in text style runs (§7).
- **In the schema but not in the references:** `GRID` auto layout (§6), `LAYER_BLUR` effects (§5), `paragraphIndent` (§7), prototype conditionals and variables (§11.1).
- **Prototype writing** (§11.4): the policy for keeping legacy fields in sync needs the edit-and-export experiment before it is implemented.

## 15. Reference files in `references/`

| Folder | .fig | Figma screenshots | Figma exports |
|---|---|---|---|
| `Playground/` | 33 nodes, page "Page 1" | 1 screenshot | – |
| `TTRPG stuff/` | 4,378 nodes; pages General v15, Pokemon, Archive, Työpaikka rope, Pokemon website; local components, text styles, a variable | page screenshots | `exports Pokemon website/{Home,Rules,Character creator}.{png,svg}` (used for render diffs) |
| `Futurice_com UI/` | 17,228 nodes, 6 visible pages incl. divider `---------`; embedded library components, styles and variables (139 variables, 6 collections) | page screenshots | `export About L.png`, `export Home - Landing Page light.png` |
| `Responsive example/` | 534 nodes (FRAME, TEXT, VECTOR, ELLIPSE), page "Page 1"; modern prototype; frames `2:2` Explore · Mobile (390×982), `2:7` Auto layout · Mobile, `2:12` Collaborate · Mobile (390×948), `2:17` Explore · Tablet (834×1000) | – | `Exports/<frame name>.{png,svg}` for all 4 frames (names contain `·`, U+00B7) |
| `Prototyping in Figma/` | 921 nodes, page "Prototyping in Figma", legacy prototype format; screens `0:2` Logged out, `0:47`/`0:77` Register (step 1/2), `0:68` Login, `0:78` Discover (overflow behavior, 375×2267), `0:83`/`0:92` Photo open (overlay), `0:88` Profile, `0:90` Search, `0:94` Individual chat, `0:627` Chats, `0:681` Search keyboard (overlay, 375×291), `0:725` Search results, `0:745` Search results (preserve scroll position); info frames `0:1104` "See how it works" and `0:1156` "Welcome" | 1 page screenshot | `Exports/<frame name>.{png,svg}` for the 14 screens (the duplicate name is exported as `Photo open (overlay)-1`) |

All reference material is harmless and free to read, but **local only and never committed**; what we learn goes into this document. Figma's SVG exports show how Figma itself turns nodes into SVG (rects, paths with absolute coordinates, a `clip-path` per clipping frame); use them as the target style for `fig-render`.

## 16. Inspecting files

With the project's own packages (in a throwaway vitest file, or after `npm run build`):

```ts
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';

const fig = FigArchive.open('references/Playground/Playground.fig');
const canvas = fig.decodeCanvas();          // { version, schema, message, messageBytes, … }
const doc = new FigDocument(canvas, fig);   // scene tree with instances expanded
console.log(doc.pages.map((p) => p.name), doc.getNodeById('1:4')?.data);
```

From the command line: `node packages/cli/dist/bin.js dump <file>`, `inspect <file> <nodeId> [--json]`, `validate <file>`.
