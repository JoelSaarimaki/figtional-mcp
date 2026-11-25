# .fig file format: working notes

A living reference for Figma's `.fig` export format, as observed in the files in `references/`. **Add to this document whenever you learn something new** (field semantics, defaults Figma expects, things that broke an import). Mark each claim as *verified* (seen in the files or confirmed by a Figma import) or *assumed*.

Last verified with Figtional 0.1.0 against 5 reference exports, `fig-kiwi` versions **101** and **106**, schemas with 674–675 definitions. All five decode and **re-encode byte-for-byte** with `packages/fig-format` (including the 270 MB Futurice.com UI file).

---

## 1. Container (ZIP), verified

`.fig` = a ZIP archive (`PK\x03\x04`):

| Entry | Content |
|---|---|
| `canvas.fig` | The document, in fig-kiwi binary format (§2) |
| `meta.json` | Export metadata (§1.1) |
| `thumbnail.png` | File thumbnail (size given in `meta.json.client_meta.thumbnail_size`) |
| `images/` | Directory entry |
| `images/<40-hex sha1>` | Image files, no extension. The filename is the SHA-1 hash that `Paint.image.hash` refers to (20 raw bytes → hex). |

Entry order seen in the files: `canvas.fig`, `thumbnail.png`, `meta.json`, `images/`, `images/*`. Keep this order when writing.

Compression per entry (verified): `canvas.fig`, `thumbnail.png`, `images/*` are **STORED** (method 0); `meta.json` is **DEFLATE** (method 8). Flags `0x0808` (data descriptor + UTF-8 names). No ZIP64. Our writer copies unchanged entries raw (no recompression) and writes sizes in the local header instead of data descriptors; that is valid ZIP (*Figma import still to be verified*).

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

## 2. canvas.fig (fig-kiwi), verified

```
offset 0   : "fig-kiwi"            8 bytes ASCII magic
offset 8   : uint32 LE version     (101 or 106 seen)
offset 12  : chunk*                each = uint32 LE byteLength + bytes
```
- The version differs between files exported on the same day (Responsive example and Prototyping in Figma are 101, the others 106), so it seems to reflect the file, not the exporter (*assumed*). `figtional validate` warns about unseen versions.
- **Chunk 0: kiwi binary schema**, compressed with **raw deflate**. Decode with `kiwi-schema.decodeBinarySchema`, then `compileSchema`.
- **Chunk 1: message**, compressed with **zstd** (magic `28 b5 2f fd`). Older files may use deflate. Pick the decompressor by the magic bytes.
- The root type is `Message`. Decode with `compiled.decodeMessage(bytes)`.

Re-encoding: write the **original chunk 0 bytes unchanged**, encode the message, and compress it with zstd (`node:zlib` has zstd since Node 22.15; it is *unverified* whether Figma accepts deflate here). Status: *not yet verified by a Figma import*. Log the results in `docs/compat-log.md`.

**Field order matters for byte-identical output (verified).** kiwi messages are `(field id, value)*` pairs and any order is valid, but Figma's order is neither schema order nor id order (e.g. `Message.originFileKey` (id 47) comes before `nodeChanges` (id 4)). kiwi's generated encoder writes schema order, so re-encoding gave the same length but different bytes. kiwi's *decoder* assigns fields in wire order, so `OrderedEncoder` (`packages/fig-format/src/kiwi.ts`) writes each object's fields **in its own key order**. Unmodified messages come out byte-identical, and new fields are appended. Keep this property: don't rebuild node objects in a different key order.

kiwi notes: enum values are decoded to names (an unknown value would decode to `undefined`, but the embedded schema always knows them); deprecated fields are skipped by kiwi's encoder (none exist in the current schemas).

The schema has a very large number of types (Slides, FigJam, Sites/CMS, Make code layers, animation, AI chat…). Ignore what you don't need, but **pass everything through unchanged**.

## 3. Message, verified

```ts
{
  type: "NODE_CHANGES",
  sessionID: number, ackID: number,
  originFileKey?: string,
  nodeChangeOrder?: ...,
  nodeChanges: NodeChange[],   // flat list of all nodes
  blobs: { bytes: Uint8Array }[] // geometry / glyph data, referenced by index
}
```

Sizes in the references: Playground 33 nodes / 151 blobs; TTRPG stuff 4,378 / 1,043; Futurice.com UI 17,228 / 3,566.

## 4. Nodes, verified

### 4.1 Identity & tree
- `guid: { sessionID, localID }` → node id string `"sessionID:localID"` (Figma URL form: `node-id=sessionID-localID`).
- `phase: "CREATED"` on every node in an export.
- `parentIndex: { guid: <parent guid>, position: <string> }`. `position` is a **fractional index** (printable ASCII such as `"!"`, `"#"`, `"$"`, `"~"`, `"W"`, `"X"`). Order siblings by comparing strings by code unit. To insert between two siblings, generate a string that sorts strictly between them.
- The node list is **not** in tree order. Build the tree from `parentIndex`.
- SVG exports from Figma use node ids in clip-path ids: `clip0_707_7816` → node `707:7816`. This is handy for matching exports to nodes.

### 4.2 Hierarchy
- `DOCUMENT` (`0:0`, name "Document", `documentColorProfile: "SRGB"`)
  - `CANVAS` = page. Fields: `name`, `backgroundColor`, `backgroundEnabled`, `isPageDivider` (pages like `---------` are dividers), `internalOnly`.
    - The page named **`Internal Only Canvas`** (`internalOnly: true`) holds internal data, including the `VARIABLE_SET`/`VARIABLE` nodes (parent `0:2` in TTRPG stuff). Hide it in the UI.

### 4.3 Node types seen
`DOCUMENT, CANVAS, FRAME, TEXT, ROUNDED_RECTANGLE, ELLIPSE, LINE, VECTOR, REGULAR_POLYGON, BOOLEAN_OPERATION, SECTION, SYMBOL, INSTANCE, BRUSH, VARIABLE_SET, VARIABLE`

- `SYMBOL` = component (Plugin API `COMPONENT`). Variant sets are FRAMEs with `isStateGroup: true` (Plugin API `COMPONENT_SET`).
- `ROUNDED_RECTANGLE` = Plugin API `RECTANGLE`.
- `BRUSH` = brush/pencil strokes (`brushType`, `scatterStrokeSettings`).
- **Groups** are `FRAME`s with `resizeToFit: true` (verified: every "Group N" layer has it). Some resize-to-fit frames have fills, which groups can't, so `fig-model` treats a node as `GROUP` only when it also has no fills, strokes or auto layout (*assumed*). Groups have `frameMaskDisabled: false` yet don't clip in Figma, so ignore clipping for groups (*assumed*).

### 4.4 Common geometry fields
- `size: { x, y }`: width/height.
- `transform: { m00, m01, m02, m10, m11, m12 }`: 2×3 affine matrix **relative to the parent**. `m02`/`m12` = x/y.
- `opacity`, `visible`.
- `fillPaints: Paint[]`, `strokePaints: Paint[]`, `strokeWeight`, `strokeAlign` (`CENTER|INSIDE|OUTSIDE`), `strokeJoin`, `dashPattern`.
- Independent borders: `borderStrokeWeightsIndependent`, `border{Top,Right,Bottom,Left}Weight`.
- Corners: `cornerRadius`, `rectangle{TopLeft,TopRight,BottomLeft,BottomRight}CornerRadius`.
- `effects: Effect[]` (shadows, blurs).
- `fillGeometry` / `strokeGeometry`: precomputed paths (`commandsBlob` → index into `blobs`). These are derived data and must be regenerated or dropped when the shape changes (*assumed*).
- `vectorData`: `vectorNetworkBlob` + `normalizedSize` for VECTOR/BRUSH/shapes.
- Constraints: `horizontalConstraint`, `verticalConstraint`, `proportionsConstrained`.
- `frameMaskDisabled`: `false` means the frame **clips its content**.
- `exportSettings`, `editInfo` (user id + timestamps), `pluginData`.

### 4.5 Paint, verified
```jsonc
// SOLID
{ "type": "SOLID", "color": { "r":1,"g":1,"b":1,"a":1 }, "opacity": 1, "visible": true,
  "blendMode": "NORMAL", "authoredColor": { "space": "DEFAULT", "c0":1,"c1":1,"c2":1,"c3":1 } }
// IMAGE
{ "type": "IMAGE", "opacity": 1, "visible": true, "blendMode": "NORMAL",
  "transform": { "m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":0 },
  "image": { "hash": <20 bytes sha1>, "name": "kuva" },
  "imageThumbnail": { "hash": <20 bytes>, "name": "kuva" },
  "imageScaleMode": "FILL", "scale": 0.5, "rotation": 0,
  "originalImageWidth": 486, "originalImageHeight": 855,
  "imageShouldColorManage": true, "thumbHash": <bytes>, "altText": "" }
```
Colours are floats from 0 to 1. Gradient paints use `stops` and a `transform` (*assumed*, to verify).

### 4.6 Auto layout (field name → Plugin API), verified field presence
| .fig field | Plugin API |
|---|---|
| `stackMode` | `layoutMode` (`HORIZONTAL`/`VERTICAL`/`NONE`/grid?) |
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
| `stackLayoutVersion` | internal. Keep it. |

The stored `size` and `transform` values already contain the **resolved** layout result, so the viewer doesn't need to run auto layout for unedited files. After an edit, `fig-model`'s `computeLayout` recomputes it.

**Auto-layout semantics** (verified by re-laying out every auto-layout frame in the references and comparing with Figma's stored result: Responsive 100%, TTRPG 99.4%, Futurice 98.3% of children identical within 0.5 px; `packages/fig-model/src/layout.test.ts`):
- **Defaults:** fields holding the enum's first value are omitted (alignment MIN, align-self AUTO, counter sizing FIXED, no wrap). **Primary sizing is the exception:** Figma writes `stackPrimarySizing: FIXED` explicitly and omits it when the frame hugs. `RESIZE_TO_FIT` and `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE` both mean hug.
- **Padding:** `stackPaddingRight`/`stackPaddingBottom` default to the left/top value when missing. With `bordersTakeSpace: true` (Plugin API `strokesIncludedInLayout`, border-box) and visible strokes, the frame's stroke widths (per side when `borderStrokeWeightsIndependent`) are added to the padding.
- **Justify:** `SPACE_EVENLY` and `SPACE_BETWEEN` both behave as Figma's "auto" spacing (space between; one item is centred). `SPACE_AROUND`: half gaps at both ends.
- **Hug:** primary = sum of children + spacing + padding; counter = largest child + padding. **An empty auto-layout frame keeps its stored ("implicit") size.**
- **Fill:** `stackChildPrimaryGrow > 0` shares the free primary space equally; `stackChildAlignSelf: STRETCH` fills the counter axis. **Hug wins over a stale fill flag on the same axis:** an auto-layout child that hugs along that axis, or text that auto-sizes along it (`textAutoResize` HEIGHT → vertical; WIDTH_AND_HEIGHT → both), keeps its content size.
- **min/max:** `minSize`/`maxSize` (`{ value: { x, y } }`, null = unset) clamp hug and fill sizes. A stretch child capped by `maxSize` is placed by the parent's alignment.
- **Absolute** children (`stackPositioning: ABSOLUTE`) and hidden children are skipped. Rotated children take up their rotated bounding box.
- **Instance sublayers** are not reliable ground truth: Figma stores `derivedSymbolData` only for some sublayers, and the rest keep the component's geometry even when a property hides a sibling (e.g. TTRPG "Statbar"). Figma lays them out at draw time. Hence `computeLayout` keeps an instance's stored size unless it is marked dirty.

### 4.7 TEXT, verified
- **Line height** (verified against stored layouts): `{ units: 'RAW', value: v }` = Plugin API `PERCENT` v × 100 % of the font size (RAW 1.5 at 24 px = 36 px); `{ units: 'PERCENT', value: 100 }` = Plugin API `AUTO`, the font's natural line height (`derivedTextData.fontMetaData[].fontLineHeight` × size, e.g. Inter 1.21); `PIXELS` = px. Text box height = lines × round(line height) (41.6 px × 3 lines = 126). Auto-width text is `ceil(advance width)` wide.
- Style: `fontName { family, style, postscript }`, `fontSize`, `lineHeight { value, units: "PERCENT"|"PIXELS"|"RAW" }`, `letterSpacing`, `textAlignHorizontal`, `textAlignVertical`, `textAutoResize`, `textCase`, `textDecoration…`, `maxLines`, `textTruncation`, `hyperlink`, `styleIdForText`.
- `textData`: **source of truth**. `characters` plus `lines[]` (list/indent info per line), and style override runs (`characterStyleIDs` + `styleOverrideTable`, *assumed*, to verify on mixed-style text).
- Editing (verified by Figma import, 0.1.0): changing `textData.characters` is enough; Figma recomputes the layout on import, whether `derivedTextData` is removed or left stale. Figtional removes it on edit. The layer `name` is not updated automatically in the file: the Plugin API renames layers with `autoRename: true` when their text changes, so our `use_figma` must do the same.
- `derivedTextData`: a **cache**. `layoutSize`, `baselines[]` (position, width, lineHeight, character range), `glyphs[]` (`commandsBlob` → glyph outline path in `blobs`, position, fontSize, advance). The viewer can draw text from the glyph outlines without fonts. **Invalidate it on any text or style edit.**
- Version fields (`fontVersion`, `textUserLayoutVersion`, `textBidiVersion`, `textExplicitLayoutVersion`): keep them.

### 4.8 Components & instances, verified
- `SYMBOL` fields: `componentPropDefs`, `variantPropSpecs`, `isSymbolPublishable`, `sharedSymbolVersion`.
- `INSTANCE`:
  ```jsonc
  "symbolData": {
    "symbolID": { "sessionID": 3, "localID": 71 },   // → SYMBOL node
    "symbolOverrides": [ { "guidPath": { "guids": [ {…} ] }, "size": { "x":300, "y":53 }, … } ],
    "uniformScaleFactor": 1
  },
  "derivedSymbolData": [...],             // cached resolved values per inner node
  "componentPropAssignments": [...]
  ```
- An instance stores **no children** in `nodeChanges`. Its content = a clone of the symbol's subtree, plus the `symbolOverrides` keyed by `guidPath` (the path of guids from the instance down through nested instances), plus `derivedSymbolData`. Implemented in `fig-model` (`FigDocument.expandInstance`); verified on TTRPG stuff and Futurice.com UI (33,137 instances expanded, none missing).
- **`guidPath`** (verified): `[a]` targets node `a` anywhere in the component (**intermediate frames are not listed**); `[a, b]` targets node `b` inside nested instance `a`. So the path lists only the nested instances on the way, plus the target. An override with the path `[<symbolID>]` (the component itself) also appears (seen with `size`).
- **Ids in paths are override ids** (verified, Futurice.com UI): nodes of components **copied from a library** carry `overrideKey` (their id in the library), and `guidPath` and `derivedSymbolData` use that, not the local guid. Local components have no `overrideKey`, so their guid is used. `fig-model`'s `overrideId(node)` implements this. Before this was handled, every override on a library component was silently ignored.
- **Precedence** (implemented, *assumed* correct): component values < overrides stored on the nested instance itself < overrides from enclosing instances < `derivedSymbolData` (Figma's laid-out result: `size`, `transform`, `fillGeometry`, `strokeGeometry`, `derivedTextData`).
- Override fields seen (TTRPG): `size`, `textData`, `stackPrimarySizing`/`stackCounterSizing`, `componentPropAssignments`, `overriddenSymbolID` (**instance swap**), `fontSize`, `fontName`, `strokePaints`, `fillPaints`, `visible`, corner radii, paddings, `styleIdForText`, `overrideLevel`, text layout versions.
- **Component properties**: a node in a component has `componentPropRefs: [{ defID, componentPropNodeField: "TEXT_DATA" | "VISIBLE" | "OVERRIDDEN_SYMBOL_ID" }]`. Instances carry `componentPropAssignments: [{ defID, value: { textValue | boolValue | guidValue }, varValue, legacyDerivedTextData }]`. Variant components declare `componentPropDefs: [{ id, parentPropDefId }]`, where `parentPropDefId` links to the component set's definition; instances of a variant key their values by the variant's stub `id` (see "Instance values" below). `legacyDerivedTextData` is Figma's layout for the assigned text.
- Variant names: `SYMBOL.name` is `"Prop=Value, Prop2=Value"`; the set has `stateGroupPropertyValueOrders: [{ property, values[] }]`. Each variant has `variantPropSpecs: [{ propDefId, value }]`.
- **Plugin API ids** for instance sublayers: `I<instance id>;<override id>`, with one more `;<id>` per nested instance (e.g. `I1:2;3:4;5:6`). Intermediate frames don't add segments. Same ids as in `guidPath`.
- Library components are embedded (see §4.12). A truly missing component gets a placeholder (*not yet seen*).
- **Property definitions** (verified, TTRPG and Futurice): `componentPropDefs[]: { id, name, initialValue, sortPosition, type, preferredValues, varValue }` with `type` `TEXT` | `BOOL` | `INSTANCE_SWAP` | `VARIANT` (also `SLOT`, `NUMBER`, … in the schema). `initialValue` is `{ textValue: TextData }`, `{ boolValue }` or `{ guidValue }`; `varValue` repeats it as VariableData (`TEXT_DATA` with `textDataValue`, `BOOLEAN`, `SYMBOL_ID` with `symbolIdValue: { guid }`; variant definitions use `STRING` ''). `INSTANCE_SWAP` has `preferredValues.instanceSwapValues: [{ type: COMPONENT | COMPONENT_SET, key }]`.
- **Component set**: all definitions live on the set (`FRAME` + `isStateGroup`), plus `stateGroupPropertyValueOrders: [{ property, values[] }]`. Each variant `SYMBOL` has `variantPropSpecs: [{ propDefId, value }]` for the `VARIANT` definitions, and a **stub** `{ id, parentPropDefId }` for every non-variant definition. Layers inside a variant bind to the stub's id. Variant definition ids look random (e.g. `2875058928:1474337614`); Figtional uses session guids, which Figma accepts (*pending import check*).
- **Bindings** are written twice: `componentPropRefs: [{ defID, componentPropNodeField: TEXT_DATA | VISIBLE | OVERRIDDEN_SYMBOL_ID }]` and `parameterConsumptionMap.entries: [{ variableData: { value: { propRefValue: { defId } }, dataType: PROP_REF, resolvedDataType }, variableField }]`.
- **Instance values**: `componentPropAssignments: [{ defID, value, varValue, legacyDerivedTextData? }]`. **Verified:** for an instance of a variant, `defID` is the stub id of **the variant the instance uses** (TTRPG 1,811 and Futurice 2,583 assignments; none use the set-level id). Figma **ignores set-level ids on import**: instances written that way showed their default values (components import check, 0.1.3). When an instance switches variant, its values are re-keyed to the new variant's stubs. For a plain component, `defID` is the component's own definition id. `legacyDerivedTextData` (on the assignment, not inside `value`) is Figma's layout of the assigned text.
- **Instance layout**: Figma stores the laid-out size/transform of an instance's inner layers in `derivedSymbolData` (keyed by guid path). When Figtional changes instance content, it re-lays it out and writes those entries itself (with empty `fillGeometry`/`strokeGeometry` for resized shapes, no `derivedTextData` for changed text).

### 4.9 Variables, verified
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
Variable names use `/` for groups (Figma convention).

**Bindings** (verified, Futurice.com UI):
- Paint colour: `paint.colorVar.value.alias` (see §4.12).
- Other fields: `node.variableConsumptionMap.entries[]: { variableData: { value: { alias }, dataType: "ALIAS", resolvedDataType: "FLOAT" }, variableField: "STACK_PADDING_LEFT" | "STACK_PADDING_TOP" | … }` (1,144 nodes).
- Component property bindings use `parameterConsumptionMap` with `propRefValue: { defId }` and `variableField: "VISIBLE"` etc. (2,447 nodes).
- **Explicit modes**: `variableModeBySetMap: { entries: [{ variableSetID, variableModeID }] }` on frames (47 nodes) picks a mode per collection for a subtree. The nearest ancestor wins; otherwise the collection's first mode. `variableSetID` is a `VariableSetID { guid | assetRef }` (schema); all 67 entries in Futurice use `assetRef` (library collections). Figtional writes `{ guid }` for local collections, like local variable aliases (*assumed* until an import check), and `{ assetRef: { key, version } }` for embedded library collections.
- **Inline colours don't follow explicit modes (verified, Futurice):** under explicit modes, a bound paint's inline `color` equals the effective mode's value in only 155 cases, the default mode's value in 1,632 and neither in 1,895. Figma resolves bound variables when drawing (see §5b), so Figtional doesn't rewrite inline colours when it sets a mode.
- Library variables point to their collection with `variableSetID: { assetRef: { key, version } }` instead of `{ guid }`.
- Collections in Futurice.com UI: Colors [Light, Dark], Brand Colors, Primitive Colors, Semantic Colors [Light, Dark], Responsive [Desktop, Tablet, Phone], Responsive [Desktop, Mobile].

### 4.10 Prototyping, modern generation, verified (Responsive example.fig)
- **Flow starting point**, on a top-level frame:
  ```jsonc
  "prototypeStartingPoint": { "name": "Figma showcase · Mobile", "description": "", "position": "!" }
  ```
  `position` orders the flows (fractional index).
- **Interactions**, on any node (here: buttons/frames inside screens):
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
  Interaction ids use their own session (3) separate from the node ids (2). Plugin API equivalents: `reactions` (`trigger.type: "ON_CLICK"`, `actions[].destinationId`, `transition`) and `flowStartingPoints` on the page.
- `ConditionalActions` and `PrototypeVariableTarget` (variables/conditionals) are in the schema but don't appear in the references yet.

### 4.11 Prototyping, legacy generation, verified (Prototyping in Figma.fig)
Older files (all guids have `sessionID: 0`) store prototypes differently.

**Verified:** this file was exported from current Figma (at Figtional 0.1.0) and still contains *both* the legacy flat fields and `prototypeInteractions`. Figma does not migrate the old format when it opens or saves a file. It keeps both forms side by side.

**Policy (decided, details to confirm by experiment):**
- **Read:** `prototypeInteractions` is the source of truth. Fall back to the flat fields only when it is absent.
- **Write:** always write `prototypeInteractions`. If a node already has the legacy flat fields, keep them **in sync** with the first interaction (update them, or clear them when that interaction is removed). Never add legacy fields to nodes that don't have them. Keep page-level `prototypeStartNodeID`/`prototypeDevice` as they are. New flows go in as `prototypeStartingPoint`.
- **Experiment (before implementing prototype writes):** in Figma, make one prototype edit (change a destination, add an interaction, remove one) on a copy of this file and of `Responsive example.fig`, export both, and diff the decoded nodes against the originals. Copy exactly what Figma does with the flat fields, and record the result here and in `docs/compat-log.md`.

- **Page level** (`CANVAS`), instead of named flows:
  ```jsonc
  "prototypeStartNodeID": { "sessionID": 0, "localID": 2 },
  "prototypeDevice": { "type": "PRESET", "size": { "x": 375, "y": 812 },
                       "presetIdentifier": "APPLE_IPHONE_X_SPACE_GREY", "rotation": "NONE" }
  ```
- **Node level**: the first interaction is stored as **flat fields on the node**, *and* duplicated in `prototypeInteractions` (with `id` `0:0` and no `stateManagementVersion`):
  `transitionNodeID`, `interactionType` (`ON_CLICK`), `connectionType` (`INTERNAL_NODE` | `CLOSE` | `NONE`), `navigationType` (`NAVIGATE` default/absent | `OVERLAY`), `transitionType` (`MOVE_FROM_BOTTOM`, `MOVE_FROM_RIGHT`, …; absent means instant), `transitionDuration`, `easingType` (`INOUT_CUBIC`), `transitionPreserveScroll`.
- The **"no destination" sentinel** is guid `{ sessionID: 4294967295, localID: 4294967295 }` (uint32 max), seen together with `interactionType: "NONE"` / `connectionType: "NONE"`. Treat it as null.
- Leftover fields with no active interaction happen: `transitionNodeID` with `event.interactionType: "NONE"`, or an action `{}`. Ignore them when rendering and preserve them when writing.
- **Overlay frames**: `overlayPositionType` (`BOTTOM_CENTER`, …) on the destination frame. A close button uses `connectionType: "CLOSE"`.
- **Scrolling**: `scrollDirection` (`HORIZONTAL`, …) on frames that overflow. `scrollBehavior: "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME"` marks fixed elements (here: a status-bar component).
- Interactions can live on `SYMBOL`s and are inherited by their `INSTANCE`s, unless the instance overrides them.

Plugin API mapping for both generations: `node.reactions[]` (`trigger.type`, `actions[].type: "NODE"|"CLOSE"|"BACK"`, `destinationId`, `navigation`, `transition`), `page.flowStartingPoints`, `page.prototypeStartNode`, `frame.overflowDirection`, `node.scrollBehavior`, `frame.overlayPositionType`.

### 4.12 Styles & library assets, verified
- **Style definitions** are ordinary nodes with `styleType` (`FILL`, `TEXT`, `EFFECT`, `GRID`), a `key` (40-hex) and `styleDescription`. Fill styles are stored as `ROUNDED_RECTANGLE` nodes, and text styles as `TEXT` nodes. Library ones live on `Internal Only Canvas`.
- **Style references** on nodes: `styleIdForFill`, `styleIdForStrokeFill`, `styleIdForText`, `styleIdForEffect`, `styleIdForGrid`. Two forms:
  - local style in older/simple files: `{ guid: {…} }` (TTRPG stuff)
  - library or published style: `{ assetRef: { key: "<40 hex>", version: "3:42" } }`, resolved by matching the style node's `key`
- **Values are inline**: a node with `styleIdForFill` still has its own `fillPaints` with the resolved colour. A missing style therefore only loses the *name*, never the look.
- **Local style nodes (verified, TTRPG / Futurice / Prototyping):** on `Internal Only Canvas`; fill styles are `ROUNDED_RECTANGLE` 100×100 and grid styles `FRAME` 100×100 (`visible: false`, `locked: true`, `fillPaints`, or `layoutGrids` for grids); text styles are `TEXT` nodes with the style's typography and the sample text `Rag 123`. Fields: `name`, `isPublishable`, `styleType`, `version` ("session:counter"), `sortPosition` (newer files; orders the styles list), `styleDescription`; published or library styles also have a 40-hex `key`. Unpublished local styles have no key and nodes refer to them with `{ guid }` (TTRPG: all 348 references).
- **Effect styles (*assumed*, no reference has one):** Figtional writes them like fill styles, as a hidden `ROUNDED_RECTANGLE` with `effects`. Needs a Figma import check.
- **Writing styles (Figtional):** new styles follow the local form above, without a key (the Plugin API reports a key derived from the guid, and ids as `S:<key>,<node id>` like Figma). Applying a style sets the reference field and copies the style's values inline; changing a style rewrites the inline values of every node using it (and instance overrides); setting a value directly on a node removes the reference, as Figma does.
- **Variable bindings in paints**: `paint.colorVar = { value: { alias: { assetRef: { key, version } } }, dataType: "ALIAS", resolvedDataType: "COLOR" }`. `paint.color` still holds the resolved value. `VARIABLE` nodes carry the `key` that the alias refers to.
- **Library components**: copies are embedded as `SYMBOL` nodes with `sourceLibraryKey`, `componentKey`, `publishID` and `sharedSymbolVersion`, under frames on `Internal Only Canvas` (e.g. `Mutabor / Components / Input Field`). Instances refer to them through `symbolData.symbolID` like local components.
- Counts in `Futurice.com UI.fig`: 818 SYMBOLs, of which 735 are library copies; 151 style nodes; 9,058 style references and 1,157 `colorVar` aliases, **all found inside the file** (0 missing). `Prototyping in Figma.fig`: 22 `assetRef` style references, all found.
- **Unexplained (0.1.0):** in Figma's PNG export of Futurice.com UI "About/L", several sections are dark green, but in the `.fig` their fill is bound to `background/brown-1` (beige in both Light and Dark, with no explicit mode or colour override anywhere above). All texts and images match after the override fixes, so the export probably reflects a newer library state than the file. Keep an eye out for another explanation (for example library variable values being re-resolved at export).
- Not yet seen: an instance whose component is missing from the file. Expected when a file was exported without its libraries being available. Then the viewer shows a placeholder and `derivedSymbolData` may still hold partial data (*assumed*).

### 4.13 Editing rules (implemented in `fig-model/src/edit.ts` and the Plugin API layer)
- New nodes get guids in a fresh session (max existing `sessionID` + 1). New variables and collections go on the internal page.
- New nodes have no `fillGeometry`/`strokeGeometry`/`derivedTextData`; resizing removes them (and an instance's `derivedSymbolData`). Figma recomputes text layout on import (verified, M4); Figma also recomputes geometry for new and resized shapes (verified by the M8 import check, 0.1.0).
- Text inside an instance: if the text node is bound to a component property (`componentPropRefs` / `parameterConsumptionMap` TEXT_DATA), Figtional sets the property value on the instance that owns it (`componentPropAssignments`), because property values take precedence over overrides. Otherwise it writes a `symbolOverrides` entry with the guid path.
- Plugin API `primaryAxisAlignItems: 'SPACE_BETWEEN'` is written as `SPACE_EVENLY` (the value Figma's own files use for "auto" spacing).

## 5. Blobs, verified

`message.blobs[i].bytes` is referenced by `commandsBlob`, `vectorNetworkBlob`, etc. Codecs: `packages/fig-format/src/blobs.ts`. Every geometry, vector network and glyph blob in the four small references decodes without leftover bytes.
- **Path commands blob** (verified): a sequence of `[u8 cmd][f32 LE args…]`: `0` = close, `1` = moveTo(x,y), `2` = lineTo(x,y), `3` = quadTo(cx,cy,x,y), `4` = cubicTo(c1x,c1y,c2x,c2y,x,y). Glyph blobs start with a `0` (close) before the first moveTo; skip it.
- **Vector network blob** (verified): header `[u32 vertexCount][u32 segmentCount][u32 regionCount]`; vertex = `[u32 styleID][f32 x][f32 y]` (12 bytes); segment = `[u32 styleID][u32 start][f32 tangentStart.x][f32 tangentStart.y][u32 end][f32 tangentEnd.x][f32 tangentEnd.y]` (28 bytes); region = `[u32 (styleID << 1) | windingBit][u32 loopCount]`, then per loop `[u32 count][u32 segmentIndex…]`. Winding bit 1 = NONZERO, 0 = ODD (*assumed*). Coordinates are in `vectorData.normalizedSize` space (*assumed*; scale to `size` when rendering).
- Glyph outlines are in em units (scale by the glyph's `fontSize`, *assumed*, to verify in M5).

## 5b. Rendering notes (verified by render-diffing against Figma's PNG exports)

`packages/fig-render` turns nodes into SVG (and PNG via resvg). What made it match Figma:
- **Bound colours are resolved in the effective mode.** A solid paint with `colorVar` is drawn with the variable's value in the mode in effect at the node (nearest `variableModeBySetMap`, per collection, following aliases), not the inline `color`. Verified: Futurice "Home - Landing Page light" went from 2.17% to 2.02% differing pixels, the other 22 exports were unchanged (0.1.5).
- **Use Figma's stored geometry.** `fillGeometry` gives the exact shape outlines (corner radii, smoothing, booleans, vectors), so the renderer doesn't reimplement shapes. Only nodes without geometry fall back to rect/ellipse paths.
- **`strokeGeometry` is the stroke outline, but for INSIDE and OUTSIDE strokes it is a *centred* outline twice the stroke weight** (it extends ±weight around the edge). Clip it to the shape for INSIDE, and mask it to outside the shape for OUTSIDE. CENTER strokes are used as stored. Not clipping made every inside border twice as thick.
- **Glyph outlines are in em units with y pointing up.** Draw each at `translate(position) scale(fontSize, -fontSize)`. Per-character styles come from `textData.characterStyleIDs[firstCharacter]` → `styleOverrideTable[styleID].fillPaints`. Underlines and strikethroughs are precomputed rectangles in `derivedTextData.decorations`.
- **Gradient and image (`STRETCH`, Plugin API `CROP`) transforms map node-normalised space (0..1) into paint space.** Draw the unit gradient or image through `scale(w, h) · inverse(transform)`.
- **Export bounds = render bounds:** a frame that doesn't clip exports including its overflowing children (Discover (overflow behavior): 375 wide frame, 1436 px export). Drop shadows extend the bounds. **Sections export at their own bounds.** Exports are capped at 4096 px on the longest side (Figma scales down).
- Boolean operations draw their own `fillGeometry` (the result), never their operand children.
- Masks: a child with `mask: true` masks its later siblings (`maskType` ALPHA / VECTOR / LUMINANCE).
- Drop shadow `radius` is the blur radius; SVG `stdDeviation = radius / 2` matches well.

Render-diff results (differing pixels, pixelmatch threshold 0.15) are printed by `packages/fig-render/src/render-diff.test.ts`. In 0.1.0 the 21 exports of the small references were all ≤ 2% different (most < 0.1%); the remaining differences are anti-aliasing and 1 px shadow edges.

## 6. Reference material in `references/`

| Folder | .fig | Figma screenshots | Figma exports |
|---|---|---|---|
| `Playground/` | 33 nodes, page "Page 1" | 1 screenshot | – |
| `TTRPG stuff/` | 4,378 nodes, pages: General v15, Pokemon, Archive, Työpaikka rope, Pokemon website | page screenshots | `exports Pokemon website/{Home,Rules,Character creator}.{png,svg}`: use these for render diffs |
| `Futurice_com UI/` | 17,228 nodes, 6 visible pages incl. divider `---------` | page screenshots | `export About L.png`, `export Home - Landing Page light.png` |
| `Responsive example/` | 534 nodes (FRAME, TEXT, VECTOR, ELLIPSE), page "Page 1"; prototype flow; 4 top-level frames `2:2` Explore · Mobile (390×982), `2:7` Auto layout · Mobile, `2:12` Collaborate · Mobile (390×948), `2:17` Explore · Tablet (834×1000) | – | `Exports/<frame name>.{png,svg}` for all 4 frames (names contain `·`, U+00B7) |

| `Prototyping in Figma/` | 921 nodes, page "Prototyping in Figma", legacy prototype format; screens `0:2` Logged out, `0:47`/`0:77` Register (step 1/2), `0:68` Login, `0:78` Discover (overflow behavior, 375×2267), `0:83`/`0:92` Photo open (overlay), `0:88` Profile, `0:90` Search, `0:94` Individual chat, `0:627` Chats, `0:681` Search keyboard (overlay, 375×291), `0:725` Search results, `0:745` Search results (preserve scroll position); plus the large info frames `0:1104` "See how it works" and `0:1156` "Welcome" | 1 page screenshot | `Exports/<frame name>.{png,svg}` for the 14 screens (the duplicate name is exported as `Photo open (overlay)-1`) |

All reference material is harmless and free to read, but it is **local only and never committed**. What we learn goes into this document.

The SVG exports show how Figma itself turns nodes into SVG (rects, paths with absolute coordinates, `clip-path` per clipping frame). Use them as the target style for `fig-render`.

## 7. Plugin API ↔ .fig naming quick map

| Plugin API | .fig |
|---|---|
| `PAGE` | `CANVAS` |
| `COMPONENT` | `SYMBOL` |
| `COMPONENT_SET` | `FRAME` + `isStateGroup` |
| `RECTANGLE` | `ROUNDED_RECTANGLE` |
| `fills` / `strokes` | `fillPaints` / `strokePaints` |
| `layoutMode` etc. | `stack*` (§4.6) |
| `clipsContent` | `!frameMaskDisabled` |
| `mainComponent` | `symbolData.symbolID` |
| `x`, `y`, `rotation` | `transform` |
| `width`, `height` | `size` |

## 8. Inspection snippet

Use the project's own packages (in a throwaway vitest file, or after `npm run build`):

```ts
import { FigArchive } from '@figtional/fig-format';
import { FigDocument } from '@figtional/fig-model';

const fig = FigArchive.open('references/Playground/Playground.fig');
const canvas = fig.decodeCanvas();          // { version, schema, message, messageBytes, … }
const doc = new FigDocument(canvas, fig);   // scene tree with instances expanded
console.log(doc.pages.map((p) => p.name), doc.getNodeById('1:4')?.data);
```

From the command line: `node packages/cli/dist/bin.js dump <file>`, `inspect <file> <nodeId> [--json]`, `validate <file>`.
