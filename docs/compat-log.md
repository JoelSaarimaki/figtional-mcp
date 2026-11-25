# Compatibility log

Results of checks against real Figma: importing files written by Figtional, and edit-and-export experiments (PLAN.md §7). Newest first. Record the Figtional version the file was written with (from `figtional --version`; add the commit for unreleased builds), the file, what was changed, and exactly what Figma did.

| Figtional | File | Change | Result in Figma |
|---|---|---|---|
| 0.1.0 | `compat-out/components/Playground-components.fig` | Button component set built by `use_figma`: two variants (Size=Small/Large) with TEXT "Label" and BOOLEAN "Show icon" properties bound to layers; instance with Label = "Buy now"; instance switched to Large with Label = "No icon" and the icon hidden; a detached instance | **Pending**: import into Figma; check the set, its properties panel, the two instances' property values, and the detached frame. |
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
