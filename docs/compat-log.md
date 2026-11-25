# Compatibility log

Results of checks against real Figma: importing files written by Figtional, and edit-and-export experiments (PLAN.md §7). Newest first. Record the Figtional version the file was written with (from `figtional --version`; add the commit for unreleased builds), the file, what was changed, and exactly what Figma did.

| Figtional | File | Change | Result in Figma |
|---|---|---|---|
| 0.1.3 + `1d8757a` | `compat-out/components/Playground-components.fig` (rebuilt with Inter installed) | As the next row; labels measured with the installed Inter 4 variable font ("Button" 36.97 px): set 229×44, Small 93 px, Large 109 px at x = 120 | **OK** (within the font limitation): imported; values and variants correct; layout matches Figma except text width: Figma measured "Button" 38 px (Figtional 37 px with Inter 4 variable), so the variants are 94/110 px in Figma vs 93/109 px, the gap is 26 px in both, and the set is 1 px narrower than Figma would make it (229 vs 230 px). The difference comes from the Inter version, not the layout code. |
| 0.1.3 + `c7c49d0` | `compat-out/components/Playground-components.fig` (rebuilt again) | As the next row, plus: the Large variant placed beside Small (x = 120), and its copied label measured (set 227×44 fits both variants) | **Set 3 px too narrow**: Figma needed 230 px, the set was 227 px. Cause: Inter wasn't installed, so Figtional measured the labels with Arial ("Button" 34.7 px instead of about 38 px); Figma re-measures text on import but keeps the stored set size. Values and variant placement OK. |
| 0.1.3 + `734c0da` | `compat-out/components/Playground-components.fig` (rebuilt) | Same content as the 0.1.0 row below, with the instances' values keyed to the variants' stubs | **Values OK**: both instances show their values ("Buy now" with icon; Large "No icon" without). **Set too narrow**: the Large variant overflowed the set, and Large overlapped Small. Causes: Large's copied label was never measured (0×0), so the set was fitted to a too-small Large; the overlap came from the test script not moving the copy (Figma would overlap too). |
| 0.1.0 | `compat-out/components/Playground-components.fig` | Button component set built by `use_figma`: two variants (Size=Small/Large) with TEXT "Label" and BOOLEAN "Show icon" properties bound to layers; instance with Label = "Buy now"; instance switched to Large with Label = "No icon" and the icon hidden; a detached instance | **Partly OK** (checked with 0.1.3): the set, both instances (Small, Large) and the detached frame imported, but both instances showed the **default** label and icon. Cause: values were keyed to the set-level property ids, which Figma ignores (fixed in the row above; see fig-format.md "Instance values"). |
| 0.1.0 | `compat-out/m8/Responsive-edited.fig` | `use_figma` edits: heading text changed; new local variable collection + COLOR variable; new auto-layout card (fill bound to the variable, corner radius, two text layers with fill width, nested auto-layout button); no `fillGeometry` on new nodes | **OK**: imported without warnings; heading changed; card, wrapped text and button appear with correct shapes; "Figtional tokens" collection exists and the card fill is bound to `accent/primary`. (The card overlapped "Explore · Tablet" only because the test script placed it there.) |
| 0.1.0 (pre-release) | `Playground.text-stale.fig` | Text of TEXT `1:4` changed to "FIGTIONAL TEST"; old `derivedTextData` kept | **OK**: imported; canvas shows "FIGTIONAL TEST"; no visible problems from the stale layout data. |
| 0.1.0 (pre-release) | `Playground.text-stripped.fig` | Same text change; `derivedTextData` removed | **OK**: imported; canvas shows "FIGTIONAL TEST", so Figma recomputes text layout itself. The layer name stayed "RESET AND RETURN…" because only the text was changed (see note). |
| 0.1.0 (pre-release) | `Playground.color.fig` | Solid fill of FRAME `1:3` set to red | **OK**: imported; that frame is red, nothing else changed. |
| 0.1.0 (pre-release) | `Playground.roundtrip.fig` | None (decode + re-encode, raw-copied images, our ZIP writer) | **OK**: imported; identical to the original. |

**Conclusions (M8 import check, 0.1.0):** Figma recomputes geometry for new and resized nodes that have no `fillGeometry`/`strokeGeometry`, accepts new nodes in a fresh session id, new local variable collections/variables on the internal page, and paint bindings to them (`colorVar` alias by guid).

**Conclusions (M4 gate passed):**
- Figma imports archives written by Figtional: our ZIP layout (sizes in local headers, no data descriptors), raw-copied images, re-encoded zstd message and unchanged schema chunk.
- Edited `textData.characters` is what Figma shows. Figma **recomputes text layout on import**, with or without the old `derivedTextData`. Decision: when Figtional edits text, it **removes** `derivedTextData` (smaller, never stale in our own renderer), as in `text-stripped`.
- The layer name doesn't follow the text by itself. In Figma, setting `characters` on a text layer whose `autoRename` is true also renames the layer, so `use_figma` must do that too (M8).

## Automated checks (no Figma involved)

| Figtional | Check | Result |
|---|---|---|
| 0.1.0 | Decode + re-encode the message of all 5 reference files (`fig-kiwi` v101 and v106) | Byte-identical (after switching to the order-preserving encoder) |
| 0.1.0 | Rewrite the whole archive of Futurice.com UI (270 MB, 519 entries) | Same entries in the same order; images copied raw; 0.7 s |
| 0.1.0 | Decode every path, vector network and glyph blob in the 4 small references | No errors, no trailing bytes |
