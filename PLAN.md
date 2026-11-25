# Figtional MCP — Implementation Plan

## 1. Goal

A **local** MCP server that exposes the same tools an AI agent would get from the official Figma MCP server, but backed by `.fig` export files on disk instead of the Figma cloud. Access is limited to what the user explicitly passes in (one file, a list of files, or every `.fig` in a folder), which fixes the main security problem with Figma MCP: it gives the agent access to *every* file in the user's account.

**Purpose, in priority order:**
1. **Practising Figma MCP in an information-safe environment.** People learn what an agent can do with Figma MCP, and how to prompt it, without exposing their whole Figma account. Because users will judge **Figma MCP's capabilities from Figtional's behaviour**, the tools must behave like Figma's: same names, parameters, output shapes and, where practical, the same limits. Figtional-only tools would distort that picture, so they are **off by default** (§5.2).
2. **Real local editing of Figma files**, which are then imported back into Figma manually.

**Priorities:** reading comes before editing. Both are in scope.

**Distribution:** an open-source tool for many users on **Windows, macOS and Linux**.

Secondary deliverable: a **read-only web viewer** (`figtional serve`) that renders `.fig` files the way Figma does, with a page selector, a layer outline and a metadata/inspect panel. It is also the main way to see what an agent changed: there are no textual change reports.

The files must round-trip: a `.fig` written by Figtional must open in Figma without errors or lost design data.

## Status (version 0.1.0)

The current version is in `package.json` and [CHANGELOG.md](CHANGELOG.md); this table describes 0.1.0. Work for the next release happens on the `development` branch.

| Milestone | State |
|---|---|
| M0 Scaffold | **Done**: npm workspaces (`fig-format`, `fig-model`, `fig-render`, `mcp-server`, `viewer`, `cli`), TS 5.9, vitest, eslint, prettier, CI matrix, LICENSE, CONTRIBUTING. |
| M1 `fig-format` read | **Done**: lazy ZIP reader/writer, fig-kiwi container, order-preserving kiwi encoder (byte-identical round-trip on all references), path/vector-network blob codecs, atomic save with `.bak`. |
| M2 `fig-model` read | **Done** (first version): scene tree, instance expansion (overrides, nested instances, derived data, text/visibility/swap properties), groups, styles and variables by key, explicit modes, usage collection. |
| M3 MCP read tools | **Done** (first version): `whoami`, `get_metadata`, `get_variable_defs`, `search_design_system`, `get_libraries`, `get_code_connect_map` (empty), `create_design_system_rules`; extras behind `--extra-tools`; file/files/folder sources with realpath checks. `get_design_context` and `get_screenshot` are registered but return a `NotSupportedInFigtional` error until M7/M5. |
| M4 `fig-format` write | **Done**: the Figma import gate passed in 0.1.0 (round-trip, fill edit and text edits; see `docs/compat-log.md`). |
| M5 `fig-render` | **Done** (first version): SVG/PNG rendering from stored geometry and glyph outlines; fills (solid, linear/radial gradients, images in all scale modes), strokes with alignment, effects (drop/inner shadow, layer blur), clipping, masks, blend modes, mixed-style text, decorations, missing-component placeholders, font fallback for edited text. `get_screenshot` works (PNG, longest side ≤ 2048 px). Render-diff harness against all Figma exports: 21 of 23 within 2% (see `docs/fig-format.md` §5b). Not yet: background blur, angular/diamond gradients (drawn as radial), auto-layout recomputation for edited content. |
| Auto layout engine (part of M8, done early) | **Done**: `computeLayout` in `fig-model` (hug/fill/fixed, padding incl. borders, spacing modes, alignment, wrap, min/max, absolute children, dirty-set re-measuring). Verified against Figma's stored layouts (see `docs/fig-format.md` §4.6). Still needed for edits: text measurement with installed fonts (new text sizes), and regenerating geometry for resized shapes. |
| M6 Viewer | **Done** (first version): `figtional serve` with file switcher, page selector, lazy layer tree, pan/zoom canvas (each top-level item rendered as its own PNG, loaded when visible, sharper when zoomed), click / Ctrl-click selection, inspect panel (position, auto layout, layout-in-parent, appearance, fills/strokes/effects with variables, text, component properties, styles, prototype), File tab (meta, format, variables per mode, styles), prototype connections, Present mode (flows, navigate, overlays with position, close/back, hotspots), auto-reload when the file changes, deep links (`?file=&page=&node-id=&proto=1&present=1`). Loopback only, Host-header check, GET only. Known: very large library-heavy frames take ~2 s to render. |
| M7 `get_design_context` | **Done** (first version): React + Tailwind (default) or HTML/CSS (`clientFrameworks`/`clientLanguages`), Figma-style arbitrary values, `data-name`/`data-node-id`, `var(--name, fallback)` for bound colours and spacing, mixed-style text as spans, image fills and vector exports served by a local asset server (`http://localhost:3845/assets/<hash>.<ext>`, like Figma's desktop server; another port if 3845 is taken), truncation notice for large nodes, "nothing selected" error for pages, list of used variables/styles. Verified by rendering the generated HTML in a browser and comparing with Figma's export (Responsive example: visually near-identical apart from fonts). Not yet: separate component functions for instances, Code Connect, masks (approximated by clipping). The viewer moved to port 3846. |
| M8 `use_figma` | **First version done; Figma import check passed (0.1.0).** Sandbox runner (async wrapper, JSON return, harmless `closePlugin`, all-or-nothing calls with `safeToRetryWithoutCanvasRead: true`, per-file lock, atomic save after each successful call, `--out` copies accumulate). Plugin API subset: traversal and search (`findAll`, `findAllWithCriteria`, `query()`), `node.set()`, create frame/auto layout/rectangle/ellipse/line/text/section/component/instance/page, clone/remove/appendChild/insertChild, geometry, fills/strokes/effects/radii (with Figma's validation errors), auto-layout and layout-sizing properties (Figma's error strings), text (characters, fonts with `loadFontAsync` enforcement, sizes, line height, letter spacing, alignment, auto-resize, ranges, styled segments), instance text/visibility/fill overrides (text bound to a component property sets the property, as in Figma), variables (collections, modes, variables, values, code syntax, scopes, binding to fills and numeric fields), `node.screenshot()`. Edits are measured with installed fonts and re-laid out with the auto-layout engine. Components (0.1.0): `combineAsVariants`, `addComponentProperty`/`editComponentProperty`/`deleteComponentProperty` (TEXT, BOOLEAN, INSTANCE_SWAP, VARIANT), `componentPropertyDefinitions`, `componentPropertyReferences`, `componentProperties`, `variantProperties`, `setProperties` (incl. variant switching), `detachInstance`; instances are re-laid out after property changes (written to `derivedSymbolData`); geometry getters apply pending layout immediately, like Figma. Not yet: styles creation, vectors/SVG import, images not already in the file, prototype reactions, plugin data. These throw `NotSupportedInFigtional`. |
| M9 to M10 | Not started. |
| Easier setup (development, for 0.1.1) | **Done, awaiting user checks.** `figtional setup` (guided; detects Claude Code via `claude mcp add --scope user`, Claude Desktop incl. the Microsoft Store install, Cursor, VS Code; merges JSON with `.bak`; `--yes/--client/--print`). `npm run package` builds one universal zip (bundled `lib/figtional.mjs`, resvg binaries for win32 x64/arm64, darwin x64/arm64, linux gnu/musl x64/arm64, launchers, double-click setup scripts) and a Claude Desktop extension (`.mcpb`, manifest v0.3: folder, subfolders, allow editing). `release.yml` smoke-tests the zip on Windows/macOS/Linux x64+ARM with Node 22.15.0 and 24 and publishes on tag. Open: whether Claude Desktop's built-in Node.js is ≥ 22.15 (needed for zstd); macOS Gatekeeper behaviour for the downloaded `.command` and resvg binary. Standalone executables (no Node.js needed) deferred. |
| Viewer Present mode | **Basic, kept but limited** (user feedback, 0.1.0): it follows click navigation, overlays and close/back, but lacks much of what makes Figma's prototype player communicate the intended UX: hotspot hints that flash on misclicks, Smart Animate and the full set of transitions (push, slide, move in/out with direction, duration and easing), hover/press/drag/key/after-delay triggers, scroll-to and preserved scroll positions, fixed/sticky layers while scrolling, overlay backgrounds and click-outside-to-close settings, device frames, variables and conditionals, keyboard navigation and focus handling. Candidates for M10, after editing features. |

## 2. Key decisions & findings

| Topic | Finding / decision |
|---|---|
| **Format** | `.fig` exports are ZIP archives containing `canvas.fig`, `meta.json`, `thumbnail.png` and `images/<sha1>`. `canvas.fig` is the `fig-kiwi` binary: an 8-byte magic, a uint32 version (**101** or **106** in the references), then length-prefixed chunks. Chunk 0 is the **kiwi schema** (raw deflate). Chunk 1 is the **message** (zstd). The message is `NODE_CHANGES`, a flat list of `nodeChanges` plus `blobs`. Details: `docs/fig-format.md`. |
| **Schema is embedded** | Every file carries its own schema (674–675 definitions). We decode with the schema from *the file itself* and re-encode with the same schema. We never hardcode one. |
| **Tree structure** | Nodes are flat. The parent comes from `parentIndex.guid`, and sibling order from `parentIndex.position`, a fractional-index string. Node ids are `sessionID:localID` (in URLs, `1-4`). |
| **Hidden page** | `Internal Only Canvas` holds internal data: variables, and copies of library components. Hide it from users. |
| **Libraries (verified)** | Figma's export **embeds copies of the library assets the file uses**. In Futurice.com UI, 735 of 818 components are library copies (`sourceLibraryKey`, `componentKey`) on the internal page. All 9,058 style references and 1,157 variable references (`assetRef.key`) are found inside the file by `key`. Paints also store their **resolved values inline**. So library styles, variables and components render and inspect normally. **Fallback** for a component that really is missing: a placeholder (dashed box with the component name and instance size), with no attempt to approximate it. Style and variable *values* still work from the inline values, and only their names may be unknown. |
| **Text** | `textData` is the source of truth. `derivedTextData` (layout + glyph outlines) is a cache that goes stale on edit. **Unedited text is drawn from the stored glyph outlines**, so it looks exactly right even if the font isn't installed. Edited or new text is measured and drawn with installed fonts. |
| **Fonts** | Only **fonts installed on the user's machine** are used. None are bundled. They are discovered from the standard font folders on each OS (Windows: `%WINDIR%\Fonts`, `%LOCALAPPDATA%\Microsoft\Windows\Fonts`; macOS: `/System/Library/Fonts`, `/Library/Fonts`, `~/Library/Fonts`; Linux: `/usr/share/fonts`, `/usr/local/share/fonts`, `~/.local/share/fonts`, `~/.fonts`), e.g. via resvg's system font loading plus a font-metadata index. Matching is by family + style (weight/italic). If a font is **missing**, it falls back to a basic default of the same kind: sans-serif (Arial / Helvetica / DejaVu Sans / Liberation Sans, whichever exists), serif, or monospace. The closest available weight is used. The file keeps the **original** `fontName` (we never rewrite it to the fallback), so Figma uses the right font after import. The viewer's inspect panel marks substituted fonts. |
| **Privacy** | The only privacy feature is **source scoping at startup** (§4). Running locally on files you chose is the protection. No further privacy features (no image toggles, redaction, etc.). |
| **Components** | `SYMBOL` = component, `INSTANCE` = instance with `symbolData.symbolOverrides`. Instances must be resolved (component tree + overrides). This is the hardest part of reading the format. |
| **Prototypes** | Two generations (modern `prototypeInteractions`/`prototypeStartingPoint`, and legacy flat fields plus page-level start node and device). Both are read and shown in the viewer. **Editing prototypes is a stretch goal**, and it follows the write policy in `docs/fig-format.md` §4.11. |
| **Writing** | `use_figma` runs a **subset** of the Plugin API in a sandbox (§5.3). Unsupported APIs throw clear errors. |
| **Getting edits back into Figma** | Manual import of the `.fig` as a new Figma file. This is understood to be **destructive** (it loses comments, version history and links). No "what changed" reports: the viewer's rendering is the reference for anyone who wants to redo changes in the original file. |
| **zstd encoding** | `node:zlib` (Node ≥ 22.15) compresses and decompresses zstd. Messages re-encode byte-identically (order-preserving encoder). Whether Figma accepts our re-written archives is the **M4 gate** (manual Figma import). |
| **Screenshots** | Render to SVG ourselves and rasterise with `@resvg/resvg-js`, which ships prebuilt binaries for Windows, macOS and Linux. No headless browser. |
| **Fidelity** | Aim for visually faithful, not pixel-perfect. Measure against the reference exports (§7). |
| **Reference files** | Local only and **never committed**. Claude may read them freely. Committed tests use small synthetic fixtures. |
| **Cross-platform** | Pure TS + WASM, plus resvg's prebuilt native binaries. Use `node:path` everywhere. File keys are case-insensitive (the slug is lowercased). npm scripts must not depend on bash or PowerShell. CI runs on all three OSes. |
| **Concurrency** | One writer per file. Writes are atomic (temp file + rename) and keep a `.bak` of the previous version. |

## 3. Architecture

TypeScript monorepo (npm workspaces), **Node ≥ 22.15** (developed on 24). 22.15 is the first version whose `node:zlib` has zstd, so no WASM or native zstd dependency is needed.

```
packages/
  fig-format/   # Pure library: read/write .fig (zip, fig-kiwi, kiwi, blobs). No I/O policy.
  fig-model/    # Document model: tree building, instance resolution, geometry, text, variables, mutations.
  fig-render/   # Node tree → SVG (+ PNG via resvg). Shared by MCP screenshots and the web viewer.
  mcp-server/   # MCP server (stdio + optional streamable HTTP). Figma-compatible tool surface.
  viewer/       # Web server + client SPA (read-only Figma-like viewer).
  cli/          # `figtional` command: `mcp`, `serve`, `inspect`, `dump`, `validate`.
```

Dependencies: `@modelcontextprotocol/sdk`, `kiwi-schema` (decoding; encoding uses our own order-preserving encoder), `zod`, `vitest`. ZIP, deflate and zstd use `node:zlib` plus our own small ZIP code (lazy reads, raw copies). Planned: `@resvg/resvg-js` (M5). Viewer: Vite + a light framework (Preact or plain TS), rendering SVG from `fig-render` on a pannable/zoomable canvas.

### Data flow
```
.fig (zip) ──► fig-format.decode ──► { schema, message, blobs, images, meta, thumbnail }
                                         │
                                         ▼
                                   fig-model.Document  ◄── mutations (use_figma)
                                         │
                     ┌───────────────────┼────────────────────┐
                     ▼                   ▼                    ▼
               fig-render (SVG/PNG)   MCP tools           fig-format.encode ──► .fig
                     │
                     ▼
                 viewer
```

When saving, the image entries in the ZIP are copied as they are (without recompressing them). Only `canvas.fig` (and, optionally, `thumbnail.png`) are rewritten, which keeps writes to large files fast.

## 4. Access control model (the reason this project exists)

The server only knows about **sources** given explicitly. There are three kinds of scope, and they can be combined:

| Scope | CLI | Config entry |
|---|---|---|
| One file | `figtional mcp ./App.fig` | `{ "file": "./App.fig" }` |
| Several specific files | `figtional mcp ./App.fig ./Marketing.fig` | `{ "file": "./App.fig" }, { "file": "./Marketing.fig" }` |
| All `.fig` files in a folder | `figtional mcp ./designs/` (add `--recursive` for subfolders) | `{ "dir": "./designs", "recursive": false }` |

A positional argument that is a directory is a folder source, and a file argument is a file source. Each source can have `writable` and `key` (file sources only). Config file: `figtional.config.json` → `{ "sources": [ … ], "outDir"?: "…", "extraTools"?: false }`, loaded with `--config`.

Folder source rules:
- **Non-recursive by default.** `recursive: true` includes subfolders. Only `*.fig` files count, and the check is case-insensitive.
- **Live**: the folder is rescanned when files are listed or a key is resolved, so new files appear without a restart.
- **No escaping**: paths are resolved with `realpath`. Symlinks or junctions that point outside the folder are ignored. `..` is rejected.
- Our own artifacts (`*.bak`, temp files, the `outDir` if it lies inside the folder) are excluded.
- Listing only reads `meta.json`. `canvas.fig` is decoded lazily and kept in an LRU cache (large files are ~270 MB).

Other rules:
- **File keys**: for file sources, the slug of the filename or `key` if given. For folder sources, the slug of the relative path with `--` between folders (`marketing--landing-v2`), so the key fits in one URL path segment. Collisions get a numeric suffix and a startup warning. Tools accept Figma-style URLs (`https://www.figma.com/design/<key>/<name>?node-id=1-4`) and `fileKey` + `nodeId`, and both resolve **only** against the configured sources.
- `whoami` reports the configured scope, so the agent and the user can see exactly what is accessible.
- Files are **read-only by default**. Writing requires `writable: true` or `--writable`.
- Writes go to the original path (atomically, with a `.bak` copy) or to `--out <dir>`.
- No network access. The viewer binds to `127.0.0.1` only.

## 5. MCP tool surface

Tool names, parameter names, response shapes and (where practical) limits copy the official Figma MCP server, so practice with Figtional carries over to the real thing. Before implementing, **record the official tools' current schemas and descriptions** in `docs/figma-mcp-tools.md` (they change over time) and test against that record. Where Figtional *can't* do what Figma can, the error message must say it is a Figtional limitation, so users don't conclude that Figma MCP can't do it either.

### 5.1 Figma-compatible tools (always on)
| Tool | Behaviour |
|---|---|
| `whoami` | A local pseudo-user, plus the configured scope (files: keys, names, pages, writable flag). |
| `get_metadata` | Sparse XML of a node or page (ids, types, names, positions, sizes), in Figma MCP's XML format. |
| `get_design_context` | Reference code for a node plus assets, variables and styles used. **Default React + Tailwind**, as Figma's default. **HTML/CSS** when the request's framework/language hints ask for it (same parameters as Figma MCP). Assets come from a local asset endpoint. |
| `get_screenshot` | PNG of a node, rendered by `fig-render`. |
| `get_variable_defs` | Variables and styles used by a node (name → value, resolved by mode), including library ones embedded in the file. |
| `get_libraries` | Libraries whose assets are embedded in the export (one per `sourceLibraryKey`). Exports don't store library names, so they are labelled `Library <key prefix>`. |
| `get_code_connect_map` | Empty `{}` (no Code Connect data in `.fig`). |
| `get_figjam` | Supported only for FigJam exports; otherwise an error. |
| `create_design_system_rules` | A rules prompt generated from the file's variables, styles and components. |
| `search_design_system` | Search components, variables and styles across the configured files only. |
| `use_figma` | Write tool (§5.3). Registered only when at least one source is writable. |

### 5.2 Figtional extras: **off by default**
Turned on with `--extra-tools` or `"extraTools": true`, or one by one with `"extraTools": ["figtional_find_nodes", …]`. When they are on, `whoami` says so, so it's clear the session isn't a faithful Figma MCP simulation.

`figtional_list_files` (paged), `figtional_list_pages`, `figtional_get_prototype` (flows, starting points, interactions), `figtional_find_nodes` (by name/type/text), `figtional_get_node_json` (raw decoded node, for debugging).

### 5.3 Write tool: `use_figma` subset
A JS sandbox (`node:vm` with a timeout, no `require`, no fs/network) that runs agent code against a `figma` global built on `fig-model`. Like real Figma, **changes take effect immediately**: after each successful `use_figma` call, the file is saved atomically. A call that throws leaves the file unchanged (all-or-nothing per call).

Supported scope, in priority order:
1. **Traversal**: `figma.root`, `currentPage`, `setCurrentPageAsync`, `getNodeByIdAsync`, `findAll`/`findOne`/`findAllWithCriteria`, `children`, `parent`.
2. **Text (content and style)**: `characters`, `insertCharacters`/`deleteCharacters`, `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textAlign*`, `textCase`, `textDecoration`, `setRange*` for mixed styles, `figma.loadFontAsync` (a no-op that checks the font name), `textStyleId`.
3. **Colour & paint**: `fills`, `strokes`, `strokeWeight`, `opacity`, `effects`, `fillStyleId`, `figma.util.rgb`/`solidPaint`.
4. **Variables**: `figma.variables.getLocalVariablesAsync`/`getLocalVariableCollectionsAsync`, `createVariableCollection`, `createVariable`, `setValueForMode`, `addMode`, `setBoundVariable`, `setBoundVariableForPaint`, `importVariableByKeyAsync` (only for library variables embedded in the file).
5. **Screens & layout**: `createFrame`, `createRectangle`, `createEllipse`, `createText`, `createLine`, `clone`, `remove`, `appendChild`, `insertChild`, `x/y/resize/rotation`, `cornerRadius`, `clipsContent`, constraints, and auto layout (`layoutMode`, `padding*`, `itemSpacing`, `counterAxisSpacing`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `*SizingMode`, `layoutSizingHorizontal/Vertical`, `layoutGrow`, `layoutAlign`, `layoutPositioning`, `layoutWrap`).
6. **Components**: `createComponent`, `createComponentFromNode`, `combineAsVariants`, `createInstance`, `swapComponent`, `setProperties`, `addComponentProperty`, `detachInstance`, `importComponentByKeyAsync` (embedded library components only).
7. **Pages**: `figma.createPage()`, `page.name`, `page.remove()`, page ordering. The last remaining user page and the internal page cannot be removed.
8. **Prototype (stretch goal)**: `reactions`, `flowStartingPoints`, following the legacy/modern write policy (`docs/fig-format.md` §4.11).

Also needed, per `docs/figma-mcp-tools.md` §5: Figma MCP's **extensions** to the Plugin API that its skills rely on (`figma.createAutoLayout`, `node.query()`, `node.set()`, `node.placeholder`, `await node.screenshot()`), `getStyledTextSegments`, `findAllWithCriteria`, `setVariableCodeSyntax`, `variable.scopes`, `renameMode`, `setExplicitVariableModeForCollection`, the `import*ByKeyAsync` family, plus the runtime contract (async wrapper, JSON `return` value, harmless `figma.closePlugin()`, `safeToRetryWithoutCanvasRead` on errors, font-loading enforcement with Figma's exact error strings, page context reset per call).

Unsupported APIs throw `NotSupportedInFigtional: <api>` (a Figtional limitation, not a Figma one).

**Layout after edits**: auto layout is recomputed by `fig-model` for edited subtrees, so the viewer, screenshots and the saved file show correct sizes and positions. This needs a layout engine for Figma's auto layout (fixed/hug/fill, padding, spacing, alignment, wrap, absolute children, min/max), plus text measurement with fonts. This is a significant chunk of M8, so start with horizontal/vertical stacks and add wrap and grid later.

Mutations must produce Figma-valid node changes: new GUIDs in a fresh `sessionID`, valid fractional `position` strings, required default fields copied from Figma's own defaults (learned from the reference files), and derived data (`derivedTextData`, `fillGeometry`, `derivedSymbolData`) regenerated or dropped when stale.

## 6. Web viewer

`figtional serve [sources…] [--port 3846]` → `http://127.0.0.1:3846`. Without sources it serves every `.fig` below the current folder (recursively, skipping hidden folders and `node_modules`), because the viewer is read-only and local. Guards for this implicit scope: it refuses drive/filesystem roots, the home folder, the folder holding all user folders and system folders (`%WINDIR%`, Program Files, ProgramData, `/usr`, `/etc`, `/System`, `/Library`, `/Applications`…), and stops after 2,000 folders or 8 levels with a warning. Explicit folders are not limited. `figtional mcp` never defaults: its scope is always explicit.

- **Top bar:** file switcher (with several files), page selector (hides `Internal Only Canvas`), zoom controls.
- **Left panel:** layer outline (tree with type icons, expand/collapse, hidden-node dimming), the same as Figma's Layers panel.
- **Canvas:** infinite pan/zoom in the page's background colour, with top-level frames and their name labels.
- **Right panel (Inspect):** id, type, size/position, fills, strokes, effects, auto layout, typography, component/variant info, style and variable names (library ones included), bound variables. A "File" tab shows `meta.json`, export date, page/node counts, variables, collections and image assets.
- Missing library components are drawn as labelled placeholders.
- Click to select on canvas ↔ outline; deep-link `?file=<key>&page=<id>&node-id=1-4`.
- **Prototype:** list of flows, connection arrows toggle, and a "Present" mode (navigate, overlays, close/back, dissolve/slide transitions, scrolling with fixed elements and preserved scroll position).
- Read-only. `--watch` reloads on file changes, so it works as a live view while an agent edits. This is the main way to review an agent's changes.

## 7. Fidelity & compatibility strategy (using `references/`)

1. **Round-trip test:** `decode → encode` without changes must give a semantically identical message. Ideally the chunks are byte-identical before compression.
2. **Figma import test (manual gate):** edited and re-encoded files are imported into Figma. They must open with no warnings, and the edits must be visible. Log the results in `docs/compat-log.md`.
3. **Render diff tests:** render frames that have Figma exports (start with `Responsive example/Exports/*` and `Prototyping in Figma/Exports/*`, then TTRPG `Home`, `Rules`, `Character creator` and the Futurice.com UI exports). Compare them with the PNGs (pixel diff with tolerance, `pixelmatch`) and structurally with the SVGs. Track a score per frame and fail on regressions.
4. **Page screenshot comparison:** loose, for guidance only (screenshots include UI chrome and zoom).
5. **Schema drift:** `figtional validate` reports the version and schema hash, and warns about versions it has not seen.
6. **Edit experiments:** before implementing a write area (text, variables, components, pages, prototypes), make the same edit in Figma, export, and diff the decoded nodes, so we write what Figma writes.

Reference files at hand (local only):
| File | Nodes | Pages | Notable content |
|---|---|---|---|
| `Playground.fig` | 33 | 1 | Small: frames, rounded rects, text. First round-trip and write tests. |
| `TTRPG stuff.fig` | 4,378 | 5 | Local components/instances, brushes, a variable, local text styles, frame exports. |
| `Futurice.com UI.fig` | 17,228 | 6 | Public website design files: **embedded library components, styles and variables** (139 variables, 6 sets), booleans, sections, many vectors. Performance and fidelity stress test (≈270 MB). |
| `Responsive example.fig` | 534 | 1 | Modern prototype: 4 frames (Mobile 390 / Tablet 834), 2 flows, auto layout. Exports of every frame. |
| `Prototyping in Figma.fig` | 921 | 1 | Figma's demo file, legacy prototype format: device, overlays, scroll, transitions. 14 frame exports. |

## 8. Milestones

Reading first (M0–M7), then editing (M8).

| # | Milestone | Done when |
|---|---|---|
| **M0** | Repo scaffold | npm workspaces, TS, vitest, eslint/prettier, `.gitignore` (incl. `references/`), CI matrix on Windows/macOS/Linux, CONTRIBUTING (LICENSE exists: MIT). |
| **M1** | `fig-format` read | All references decode; `figtional dump`; blob decoders for paths/vector networks. |
| **M2** | `fig-model` read | Tree, instance resolution with overrides, embedded library assets resolved by key, missing-component placeholders, variables, styles; `figtional inspect`. |
| **M3** | MCP read tools | `whoami`, `get_metadata`, `get_variable_defs`, `search_design_system`; extras toggle; file/files/folder sources with access enforcement (including tests for symlink escape and `..`); `docs/figma-mcp-tools.md` snapshot; works in Claude Code via `.mcp.json`. |
| **M4** | `fig-format` write | Round-trip identical; zstd encoding; **Playground.fig edited and re-encoded opens in Figma** (manual gate). |
| **M5** | `fig-render` | SVG for frames, shapes, fills (solid, gradient, image), strokes, radii, effects, clipping, text (glyph blobs; installed fonts with basic fallbacks for edited text); system font index on all three OSes; PNG via resvg; render diff harness. |
| **M6** | Viewer | `figtional serve`: file/page selector, outline, canvas, inspect, deep links, `--watch`. Prototype Present mode can follow later. |
| **M7** | `get_screenshot`, `get_design_context` | React + Tailwind and HTML/CSS output in Figma MCP's conventions; local asset endpoint. |
| **M8** | `use_figma` | Sandbox; scope groups 1–7 from §5.3 in order, each preceded by an edit experiment (§7.6); auto layout recomputation; auto-save per call; edited files pass the Figma import gate. |
| **M9** | Hardening & release | Performance on Futurice.com UI (load < 3 s, lazy rendering), docs, tested on all three OSes, GitHub release. npm publish (`figtional`) comes later. |
| **M10** | Stretch | Prototype editing; viewer Present mode polish; FigJam support. |

## 9. Open questions

1. The real JSON schemas of Figma MCP's tools are not available locally: `docs/figma-mcp-tools.md` reconstructs them from the Figma plugin's skills (v2.2.157), with inferred parts marked. Capture the live `tools/list` once someone with an authenticated Figma MCP session can share it, and diff.

### Resolved
- **zstd vs. deflate for the message chunk:** moot. `node:zlib` provides zstd, so Figtional writes zstd like Figma, and Figma imports it (M4).
- **Edited text and `derivedTextData`:** Figma recomputes text layout on import (M4 test), so Figtional removes `derivedTextData` from text it edits. Our own renderer lays out edited text with installed fonts.
- **Licence:** MIT (`LICENSE`), copyright holder Joel Saarimäki (a personal project; the holder may change later).
- **File keys after renames:** no special handling. Renames only happen when the user does them (renaming in the file manager, or a re-export saved under a new name such as `App (1).fig`). Figtional never renames files: it writes to the same name, or to the same name in `--out`. Keys always come from the current filename. An unknown key gives an error that lists the available keys, so the agent can recover with `whoami`.
- **npm:** the package name `figtional` appears to be free, but publishing is not planned for some time (moved out of M9's must-haves).
- **Fonts:** only fonts installed on the user's machine (§2 "Fonts"). Missing fonts fall back to basic defaults. No fonts are bundled.
- **Privacy features:** none beyond the source scoping in §4. Running locally on chosen files *is* the privacy feature. No image-output toggles, redaction or similar.
