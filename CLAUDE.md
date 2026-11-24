# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**Figtional MCP**: an open-source (Windows/macOS/Linux) local MCP server that mimics the official Figma MCP server, backed by local `.fig` export files, plus a read-only web viewer. The point is **security**: the agent can only reach the files that were passed in explicitly.

Main use: **practising Figma MCP safely**. People will judge Figma MCP's capabilities from Figtional's behaviour, so faithfulness to Figma beats nicer custom tools. Secondary use: real local editing, with the result imported back into Figma by hand (a destructive import is accepted). Reading takes priority over editing.

Read [PLAN.md](PLAN.md) before starting any milestone, and keep it up to date (tick off milestones, record decisions, resolve open questions).

## Layout

```
packages/fig-format   # .fig zip + fig-kiwi + kiwi decode/encode, blob codecs (pure, no policy)
packages/fig-model    # document tree, instance resolution, variables, mutations
packages/fig-render   # node → SVG / PNG (resvg); render-diff tests against Figma exports
packages/mcp-server   # MCP tools (Figma-compatible names + figtional_* extras), Workspace (source scoping)
packages/viewer       # read-only web viewer: src/server.ts (API) + static/ (plain JS client, no build step)
packages/cli          # `figtional` CLI: mcp | serve | dump | inspect | validate
test/                 # shared test helpers: synthetic .fig builder, References/ paths
References/           # real Figma exports + screenshots + PNG/SVG exports (local only, git-ignored; free to read)
docs/                 # fig-format.md (format notes), figma-mcp-tools.md (official tool schema snapshot), compat-log.md
```

## Commands

```bash
npm install
npm run build           # tsc -b (all packages)
npm test                # vitest, runs against sources; reference-file tests skip if References/ is missing
npm run lint            # eslint
npm run format          # prettier (code only; Markdown is not reformatted)
node packages/cli/dist/bin.js dump "References/Playground/Playground.fig"
node packages/cli/dist/bin.js mcp --recursive References     # MCP over stdio (logs go to stderr)
```
Set `FIGTIONAL_BIG_TESTS=1` for tests that use the 270 MB file. For one-off format investigations, a throwaway `*.test.ts` that decodes a reference file and `console.log`s is the quickest route (`npx vitest run <file> --reporter=verbose`); delete it afterwards.

Cross-platform: the code must work on Windows, macOS and Linux. Use `node:path`/`node:fs` and no shell-specific npm scripts. Remember that file systems differ in case sensitivity. The development machine is Windows (PowerShell / Git Bash), and its paths contain non-ASCII characters (`ä`) and spaces, so always quote them.

## The .fig format (verified against References/)

**Full notes: [docs/fig-format.md](docs/fig-format.md).** Read it before touching format, model or render code, and **update it** whenever you find out something new about the format (mark each claim as verified or assumed). The summary below covers the essentials.

- A ZIP archive: `canvas.fig`, `meta.json`, `thumbnail.png`, `images/<sha1>` (no extension).
- `canvas.fig`: `"fig-kiwi"` (8 bytes) + uint32 LE version (101 and 106 seen) + chunks of `[uint32 LE length][bytes]`.
  - chunk 0 = kiwi **binary schema**, raw-deflate compressed
  - chunk 1 = **message**, zstd compressed (magic `28 b5 2f fd`); detect the compression by its magic bytes and never assume it
- The message has `type: "NODE_CHANGES"`, plus `nodeChanges[]` (a flat list of nodes) and `blobs[]` (geometry/glyph binaries referenced by index).
- Tree: `parentIndex.guid` = parent, `parentIndex.position` = fractional-index string (sort lexicographically by code unit).
- Node id = `${guid.sessionID}:${guid.localID}`. In Figma URLs it is written `1-4`.
- Root `DOCUMENT` → `CANVAS` (pages). `Internal Only Canvas` is an internal page and is hidden in user-facing lists.
- Node types seen: FRAME, TEXT, ROUNDED_RECTANGLE, ELLIPSE, LINE, VECTOR, REGULAR_POLYGON, BOOLEAN_OPERATION, SECTION, SYMBOL (component), INSTANCE, BRUSH, VARIABLE_SET, VARIABLE.
- TEXT: `textData` is the source of truth. `derivedTextData` (layout + glyph blobs) is a cache and goes stale on edit.
- Message fields must be re-encoded **in each object's own key order** (`OrderedEncoder`): that is what makes round-trips byte-identical. Don't rebuild node objects with a different key order; add new fields at the end.
- Library assets the file uses (components, styles, variables) are **embedded** on the internal page and found by `key` (`assetRef.key`). Paints also store their resolved values inline. A component that is truly missing gets a placeholder, with no attempt to approximate it.

## Rules

1. **Never hardcode the kiwi schema.** Always decode and encode with the schema stored in the file being processed. Keep the original schema chunk and write it back unchanged.
2. **Preserve unknown data.** Fields and node types we don't understand must survive a round-trip untouched. The model wraps raw node changes and does not convert them into a lossy DTO.
3. **Access control is the core feature.** Sources are one file, several files, or a folder (`*.fig`, non-recursive unless `recursive`). Never add a tool, endpoint or option that lists, searches or opens anything outside the configured sources. Resolve folder contents with `realpath` and reject symlink/`..` escapes. Files are read-only unless marked writable. The viewer binds to `127.0.0.1` only. Do not add network calls. See PLAN.md §4. Source scoping is the **only** privacy feature: don't add others (image toggles, redaction, …) unless asked.
4. **Mirror Figma MCP** for Figma-named tools (names, params, output formats, and limits where practical), using `docs/figma-mcp-tools.md` as the reference. Anything else goes under the `figtional_` prefix and is **off by default** (`--extra-tools`). Errors for unsupported features must say they are *Figtional* limitations. `use_figma` saves after every successful call (no save step), as Figma applies changes live. No textual change reports: the viewer is how changes are reviewed.
5. **Writes are atomic** (temp file + rename) and keep a `.bak` copy. Never modify files in `References/`. Write test outputs to a temp dir.
6. **When Figma has an older and a newer form of the same data, copy what Figma does.** Write the newer form, keep the older fields that are already present in sync, and never strip or migrate them on our own. When unsure, run an edit-and-export experiment in Figma before writing the code (see fig-format.md §4.11 for prototypes).
7. **Validate compatibility with the references**: every format change needs a round-trip test, and rendering changes should be checked against the PNG/SVG exports and screenshots in `References/`. Changes to the encoder need a manual Figma import check, logged in `docs/compat-log.md`.
8. `References/` is harmless (a public website's design files, personal projects and Figma demo files). **You may read and decode its contents freely**, without asking. It is **never committed to git**: the useful outputs are the format knowledge in `docs/fig-format.md` and test results. Never modify the originals. Tests that use reference files must skip cleanly when they are missing (for example in CI or a fresh clone).
9. `Futurice.com UI.fig` is about 270 MB / 17k nodes. Avoid O(n²) tree operations, and don't load all images eagerly.

## Conventions

- TypeScript strict, ESM, Node ≥ 22.15 (zstd in `node:zlib`). Tests in vitest next to the source (`*.test.ts`).
- Use `Playground.fig` (33 nodes) for fast unit tests, and `Responsive example.fig` (534 nodes, modern prototype flow, exports of every frame) and `Prototyping in Figma.fig` (921 nodes, legacy-format prototype with overlays, scroll and device, 14 frame exports) for prototype and first render-diff tests. Use the larger files only for integration and perf tests.
- Fonts: use only installed system fonts, with no bundled fonts. Fall back to a basic sans/serif/mono font when one is missing. Never rewrite a node's `fontName` to the fallback.
- MIT licence. npm publishing (`figtional`) is planned but not soon.
- Rendering changes: run `npx vitest run packages/fig-render` (with `FIGTIONAL_RENDER_OUT=<dir>` to get renders + diff images, and `FIGTIONAL_BIG_TESTS=1` for Futurice). Don't loosen thresholds to make a regression pass.
- Keep `fig-format` free of MCP and viewer concerns. Keep `fig-render` free of I/O so the server and viewer can share it.
