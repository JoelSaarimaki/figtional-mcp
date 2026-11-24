# Compatibility log

Results of checks against real Figma: importing files written by Figtional, and edit-and-export experiments (PLAN.md §7). Newest first. Record the Figtional version or commit, the file, what was changed, and exactly what Figma did.

| Date | Figtional | File | Change | Result in Figma |
|---|---|---|---|---|
| 2026-11-24 | 0.1.0 | `compat-out/m8/Responsive-edited.fig` | `use_figma` edits: heading text changed; new local variable collection + COLOR variable; new auto-layout card (fill bound to the variable, corner radius, two text layers with fill width, nested auto-layout button); no `fillGeometry` on new nodes | **Pending**: import into Figma and check that the card, the variable binding and the new text appear and that nothing is reported as broken. |
| 2026-11-24 | 0.1.0 (uncommitted) | `Playground.text-stale.fig` | Text of TEXT `1:4` changed to "FIGTIONAL TEST"; old `derivedTextData` kept | **OK**: imported; canvas shows "FIGTIONAL TEST"; no visible problems from the stale layout data. |
| 2026-11-24 | 0.1.0 (uncommitted) | `Playground.text-stripped.fig` | Same text change; `derivedTextData` removed | **OK**: imported; canvas shows "FIGTIONAL TEST", so Figma recomputes text layout itself. The layer name stayed "RESET AND RETURN…" because only the text was changed (see note). |
| 2026-11-24 | 0.1.0 (uncommitted) | `Playground.color.fig` | Solid fill of FRAME `1:3` set to red | **OK**: imported; that frame is red, nothing else changed. |
| 2026-11-24 | 0.1.0 (uncommitted) | `Playground.roundtrip.fig` | None (decode + re-encode, raw-copied images, our ZIP writer) | **OK**: imported; identical to the original. |

**Conclusions (M4 gate passed):**
- Figma imports archives written by Figtional: our ZIP layout (sizes in local headers, no data descriptors), raw-copied images, re-encoded zstd message and unchanged schema chunk.
- Edited `textData.characters` is what Figma shows. Figma **recomputes text layout on import**, with or without the old `derivedTextData`. Decision: when Figtional edits text, it **removes** `derivedTextData` (smaller, never stale in our own renderer), as in `text-stripped`.
- The layer name doesn't follow the text by itself. In Figma, setting `characters` on a text layer whose `autoRename` is true also renames the layer, so `use_figma` must do that too (M8).

## Automated checks (no Figma involved)

| Date | Check | Result |
|---|---|---|
| 2026-11-24 | Decode + re-encode the message of all 5 reference files (`fig-kiwi` v101 and v106) | Byte-identical (after switching to the order-preserving encoder) |
| 2026-11-24 | Rewrite the whole archive of Futurice.com UI (270 MB, 519 entries) | Same entries in the same order; images copied raw; 0.7 s |
| 2026-11-24 | Decode every path, vector network and glyph blob in the 4 small references | No errors, no trailing bytes |
