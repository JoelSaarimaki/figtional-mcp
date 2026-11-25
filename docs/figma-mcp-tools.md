# Official Figma MCP server: tool surface snapshot

Reference for Figtional's Figma-compatible tools (PLAN.md §5). It records what the **official Figma MCP server** exposes and how Figma's own skills expect it to behave. Figtional copies these names, parameters, response shapes and error behaviour.

**Source:** the official Figma Claude Code plugin `figma@claude-plugins-official` **v2.2.157**, read locally on 2026-11-24 from `~/.claude/plugins/cache/claude-plugins-official/figma/2.2.157/`. No Figma MCP tool was called. Paths below are relative to that folder.

- `.mcp.json`: the remote server is `https://mcp.figma.com/mcp` (streamable HTTP, OAuth). It sends the header `X-Figma-Plugin-Bundle: figma_prod@2_2_157` and lists 19 tool titles in `_meta.ideToolTitles`.
- `skills/`: the skills Claude Code loads (16 skills). `skills-figquery/` is a Cursor-only variant (see §6).
- `figma-power/`: POWER.md and steering docs (the Kiro "power"), with an older 13-tool table.
- **Not available locally:** the server's real JSON input schemas and tool descriptions. Parameter lists below come from skill prose and examples. Anything not stated directly in a skill is marked **(inferred)**. **TODO:** when an authenticated session is available, capture the live `tools/list` output and diff it against this file.

Legend: **R** = required, **O** = optional.

---

## 1. Common conventions

### 1.1 URL → `fileKey` / `nodeId`
Source: `skills/figma-code-connect/SKILL.md` §1, `skills/figma-swiftui/SKILL.md` "Shared context" #1, `figma-power/steering/implement-design.md` Step 1.

| URL | `fileKey` | `nodeId` |
|---|---|---|
| `figma.com/design/:fileKey/:name?node-id=X-Y` | `:fileKey` | `X-Y` → `X:Y` |
| `figma.com/file/:fileKey/:name?node-id=X-Y` (legacy) | `:fileKey` | `X-Y` → `X:Y` |
| `figma.com/design/:fileKey/branch/:branchKey/:name` | **`:branchKey`** | from `node-id` |
| `figma.com/board/:fileKey/...` | FigJam file | |
| `figma.com/slides/:fileKey/...` | Slides file | |

- The skills say "always convert hyphens to colons" (`1234-5678` → `1234:5678`). The power steering docs and the motion skill pass the raw `"42-15"` form, so the server **probably accepts both** (inferred). Figtional should accept both.
- Instance-sublayer ids look like `I4005:6111;30:8005` (`skills/figma-implement-motion/SKILL.md`).
- The editor type comes from the URL path: `/design/` = `figma`, `/board/` = `figjam`, `/slides/` = `slides` (`skills/figma-use/SKILL.md` §4).

### 1.2 Cross-cutting parameters
- `fileKey`: required by nearly every tool on the remote server. The Code Connect tables say "Yes (remote) / Optional (desktop)" for `fileKey` and `nodeId`. The desktop server falls back to the current selection, which explains the error "You currently have nothing selected" (inferred).
- `nodeId`: `"123:456"`.
- `clientLanguages`, `clientFrameworks`: **comma-separated strings** for `get_design_context` and `create_design_system_rules` (e.g. `"typescript,javascript"`, `"swift"`, `"react"`, `"swiftui"`, `"unknown"`). They are shown as **arrays** (`["react"]`) for `get_context_for_code_connect`. They steer output framing; motion snippet format is inferred from `clientFrameworks`.
- `skillNames`: a comma-separated **logging-only** string ("does not affect execution"). Skills add their own name, prefixed `resource:` when the skill was loaded as an MCP resource. Documented for `use_figma` and `get_design_context`. Figtional should accept and ignore it.
- MCP **resources**: the server also serves skills as resources (the `resource:` prefix), Make project files (README "Bringing Make context"), and shader/plugin source URIs.

### 1.3 Rate limits (README)
Read tools are rate-limited: Starter/View/Collab seats get up to 6 calls **per month**, and Dev/Full seats follow REST API Tier 1 per-minute limits. Write tools are exempt. Figtional has no limits.

---

## 2. Tool inventory

The 19 tools titled in `.mcp.json` are the core set. Other tools are mentioned only in skills and may be gated or rolling out. The **Figtional** column is the implementation state on 2026-11-25.

| Tool | Kind | Figtional |
|---|---|---|
| `whoami` | identity | yes |
| `get_metadata` | read | yes |
| `get_design_context` | read | yes |
| `get_screenshot` | read | yes |
| `get_variable_defs` | read | yes |
| `get_figjam` | read | not yet (planned for FigJam exports) |
| `search_design_system` | read | yes (the file and its embedded library assets) |
| `get_libraries` | read | yes (libraries embedded in the export) |
| `get_code_connect_map` | Code Connect read | yes (always empty: no Code Connect data in `.fig`) |
| `get_code_connect_suggestions` | Code Connect read | no |
| `get_context_for_code_connect` | Code Connect read | no |
| `add_code_connect_map` | Code Connect write | no |
| `send_code_connect_mappings` | Code Connect write | no |
| `create_design_system_rules` | prompt | yes |
| `use_figma` | write (JS) | yes (Plugin API subset; see README) |
| `create_new_file` | write | no |
| `upload_assets` | write | no (only images already in the file can be used) |
| `generate_diagram` | write (Mermaid→FigJam) | no |
| `generate_figma_design` | write (web capture) | no |
| `generate_image` | write (AI, credits) | no |
| *skills only:* `get_motion_context` | read | no (candidate) |
| *skills only:* `html_to_figma`, `send_code_to_figma`, `generate_deck` | write | no |
| *skills only:* `create_shader`, `get_shader`, `list_shaders`, `update_shader` | account library | no |
| *skills only:* `create_generative_plugin`, `get_generative_plugin`, `list_generative_plugins`, `update_generative_plugin` | account library | no |
| *figquery only:* `get_comments` | read | no |

---

## 3. Read tools

### 3.1 `whoami`
- **Params:** none (inferred).
- **Returns:** the authenticated user's identity and plan information (POWER.md). Fields the skills rely on:
  - a list of **plans**, each with a `key` used as `planKey` (`skills/figma-create-new-file/SKILL.md`). With no plans, file creation can't proceed. With several, the agent asks the user to choose.
  - per-plan `specs_enabled` (`skills/figma-spec/SKILL.md`). `whoami` does **not** say which plan owns a file.
  - `code_layers_enabled` (`skills/figma-code-workflows/SKILL.md`).
  - identity fields such as email or handle (inferred; not named in the skills).
- **Mentioned in:** figma-create-new-file, figma-spec, figma-code-workflows, figma-shaders, figma-generative-plugins, figma-use-figjam, POWER.md.
- **Figtional:** return a pseudo-user and one pseudo-plan, plus the scope (PLAN §5.1). Keep the field names above so plan-resolution flows still work.

### 3.2 `get_metadata`
- **Params:** `fileKey` (R), `nodeId` (O). Possibly `clientLanguages`/`clientFrameworks` (inferred, unverified).
- **Returns:** a "sparse XML representation" of the subtree with ids, layer types, names, positions (x/y) and sizes (POWER.md, `skills/figma-use/references/validation-and-recovery.md`). The skills also use it to check auto-layout direction, sizing, padding, spacing and variant names. Whether those layout properties actually appear as attributes is unverified.
  - **No `nodeId`:** returns only the document's top-level pages as `{guid, name}` entries, with no XML dump (`skills/figma-use/references/gotchas.md` "get_metadata operates on one subtree").
  - Accepts a page/canvas id (`skills/figma-swiftui/references/design-to-code.md` §1).
  - XML element and attribute names are not documented in the plugin. From memory of the real server: lower-case kebab type tags (`<frame>`, `<text>`, `<instance>`, `<symbol>`, `<rounded-rectangle>`) with `id`, `name`, `x`, `y`, `width`, `height` attributes **(inferred, must verify)**.
- **Errors:** FigJam → fails with "unsupported for FigJam files". Slides → unsupported (design editor type only) (`figma-use-figjam/SKILL.md`, `figma-use-slides/SKILL.md`).
- **Role in workflows:** the cheap structural check after writes, and the **fallback when `get_design_context` is too large or truncated**: get the node map, then re-fetch child nodes.
- **Mentioned in:** figma-use (SKILL, validation-and-recovery, gotchas), figma-generate-design, figma-swiftui, figma-use-figjam, figma-use-slides, POWER.md and implement-design.md.

### 3.3 `get_design_context`
- **Params:** `fileKey` (R), `nodeId` (R on remote), `clientLanguages` (O, comma string), `clientFrameworks` (O, comma string), `skillNames` (O, logging). Default output is **React + Tailwind** (README, POWER.md). The skill tells agents to "request a screenshot as part of your initial call", which suggests a screenshot-related option or default (exact parameter name unknown, inferred).
- **Returns** (text, plus an image when the screenshot is included):
  - **Reference code**: React + Tailwind JSX. Elements carry `data-node-id="1:379"` and `data-name="<layer name>"`. It uses arbitrary values (`inset-[8.53%_4.32%_8.3%_52.53%]`, `font-['SF_Pro:Expanded_…']`, `font-[590]`, `leading-[22px]`) and `contents` for layout-transparent groups.
  - **Variables** inline as `var(--<variable/path>, <fallback>)`, e.g. `var(--backgrounds/primary, white)`. Spaces in names become `-`, e.g. `var(--labels---vibrant---controls/secondary, #8c8c8c)` (`figma-swiftui/references/design-to-code.md`).
  - **Assets** as constants: `const imgFoo = "https://…/api/mcp/asset/<uuid>"`. These URLs are **expiring**, and the agent must download them (`curl -L`) and never ship them. Older docs (POWER.md, README) describe a **`localhost` assets endpoint** (desktop server): "use that source directly". SVG assets have root `width`/`height` attributes.
  - **Code Connect**: mapped components are wrapped in `<CodeConnectSnippet data-name="…" data-snippet-language="SwiftUI|tsx|html">…</CodeConnectSnippet>`. The response also includes `componentName`, `source` and a snippet (`figma-generate-library/references/code-connect-setup.md` §1).
  - **SF Symbols** come out as `<SFSymbol>{Image(systemName: "…")}</SFSymbol>`.
  - **Motion markers** on animated elements: `motion.div` tags, `data-motion-keys`, `data-motion-wrapper-for`, `data-motion-transform-template`. The response may tell the agent to call `get_motion_context`.
  - A **screenshot** of the node (`figma-swiftui/references/design-to-code.md` §1).
  - The response may be **flagged as sparse**. The agent must then fetch the visible child nodes with parallel `get_design_context` calls (`skills/figma-design-to-code/SKILL.md`).
- **Errors and limits:**
  - Large selections are slow, error out, or come back **truncated**. The documented recovery is `get_metadata`, then per-child `get_design_context` (README, POWER.md, implement-design.md).
  - `"You currently have nothing selected"` (or an access/empty error) when `nodeId` points at a page/canvas or another non-renderable node. `get_screenshot` and `get_metadata` accept such ids (`figma-swiftui/references/design-to-code.md` §1).
- **Mentioned in:** figma-design-to-code (mandatory pre-skill), figma-implement-motion, figma-swiftui, figma-generate-diagram, figma-use-slides, figma-generate-library (code-connect-setup), README, POWER.md and all steering docs.

### 3.4 `get_screenshot`
- **Params:** `fileKey` (R), `nodeId` (R). Possibly `clientLanguages`/`clientFrameworks` (inferred).
- **Returns:** an image of the node (MCP image content, PNG inferred). The skills describe it as pixel-accurate and expensive.
- **Errors:** an empty `nodeId` → `"invalid nodeId"` (`figma-use-figjam/SKILL.md`). Works on FigJam and Slides nodes, and on page ids.
- **Workflow:** the visual source of truth for design-to-code. For write validation, take one shot after composition and one after a fix, no more (`figma-use/SKILL.md` Rule 5).
- **Mentioned in:** figma-use, figma-design-to-code, figma-use-figjam, figma-use-slides, figma-swiftui, validation-and-recovery.md, implement-design.md.

### 3.5 `get_variable_defs`
- **Params:** `fileKey`, `nodeId` (inferred, by analogy with the other node tools). `clientLanguages`/`clientFrameworks` (inferred).
- **Returns:** "variables and styles used in your selection (color, spacing, typography, etc.)" (README, POWER.md). From memory of the real server: a flat JSON object `{ "<variable or style name>": "<resolved value>" }`, where colours are hex and typography is a `Font(family: …, style: …, size: …, weight: …, lineHeight: …)` string **(inferred, must verify)**.
- **Mentioned in:** README and POWER.md only. No skill calls it.

### 3.6 `get_figjam`
- **Params:** `fileKey` (R). Optional `nodeId` (inferred). The skills show it called as `get_figjam(fileKey)`.
- **Returns:** "the full node tree as XML, including IDs of pages, sections, stickies, connectors" (`figma-use-figjam/SKILL.md`). POWER.md adds "including metadata and node screenshots". Used to find node ids and bounding boxes before `use_figma` edits.
- **Mentioned in:** figma-use-figjam, figma-generate-diagram (SKILL, references/workflow.md), POWER.md.

### 3.7 `search_design_system`
- **Params:** `fileKey` (R); `queries` (R): an array of `{ entity: "component" | "variable" | "style", query: string }`, never bare strings; `includeLibraryKeys` (O): `string[]` of `libraryKey`s from `get_libraries`. By default it searches all accessible libraries.
- **Semantics:** components are relevance-ranked by a recommendation engine on name and description. Variables match on **variable names**. There are **no OR semantics**: use one intent per query entry ("Button IconButton icon" finds nothing useful).
- **Returns:**
  ```json
  { "results": [
    { "entity": "component", "query": "button", "components": [
      { "name": "Button", "libraryName": "Design System", "assetType": "component_set",
        "componentSetKey": "abc123def", "description": "Primary action button" } ] },
    { "entity": "variable", "query": "color", "variables": [
      { "name": "colors/primary/500", "variableType": "COLOR", "variableSetKey": "set1key",
        "key": "var1key", "scopes": ["FRAME_FILL","SHAPE_FILL"], "variableCollectionName": "Colors" } ] },
    { "entity": "style", "query": "heading", "styles": [
      { "name": "Heading/H1", "styleType": "TEXT", "key": "style1key" } ] } ] }
  ```
  `assetType: "component"` carries `componentKey`; `"component_set"` carries `componentSetKey`. These keys feed `importComponentByKeyAsync`, `importComponentSetByKeyAsync`, `importVariableByKeyAsync` and `importStyleByKeyAsync` in `use_figma`. Results may include Code Connect references.
- **Mentioned in:** figma-generate-library (SKILL, references/discovery-phase.md §3), figma-generate-design SKILL (2a-iv, 2b, 2c), figma-use SKILL §9.

### 3.8 `get_libraries`
- **Params:** `fileKey` (R), `offset` (O, default 0).
- **Returns:** `{ libraries_added_to_file: [...], libraries_available_to_add: [...], libraries_available_to_add_next_offset: number | null }`. Each entry has `name`, `libraryKey`, `description`, `source` (`"team" | "community" | "organization"`). Org libraries come in **pages of 20**, and community UI kits appear only on the first page.
- **Mentioned in:** figma-generate-library (SKILL, discovery-phase.md), figma-generate-design.

### 3.9 `get_motion_context`
- **Params:** `fileKey`, `nodeId`, `recursive` (O, boolean; descendants, **capped at 500 nodes**). `clientFrameworks` picks the snippet format (CSS or motion.dev).
- **Returns:** `nodes[]`, one entry per **animated** node: `nodeId`, `codeSnippets` (CSS `@keyframes` and/or motion.dev), `textAnimations` (with `derivedTimingInfo`: `startMs`, `staggerStepMs`, `groupDurationMs`, `presetDurationMs`, `grouping`, `order`), `keyframeBindings` (fallback), `motionSummary` (only when there's no snippet), `fallbackNodeId`, and optional `timelineDurationMs`/`transformOrigin`. Recursive mode adds a top-level `timelineCohorts[]` with `{ rootNodeId, durationMs, loopMode: 'once'|'loop'|'boomerang', memberNodeIds[] }`. It dedupes identical snippets into a comment that points to the first node. Joins to `get_design_context` through `data-node-id`.
- **Mentioned in:** `skills/figma-implement-motion/SKILL.md` and its references.

### 3.10 Code Connect reads
Source: `skills/figma-code-connect/SKILL.md`, `skills/figma-generate-library/references/code-connect-setup.md`, `figma-power/steering/code-connect-components.md`. Code Connect needs published components and an Organization or Enterprise plan.

- **`get_code_connect_map`**: `nodeId` (O; omit for all mappings in the file), `fileKey` (R remote), `codeConnectLabel` (O). Returns `{ [nodeId]: { componentName, source, label, snippet, snippetImports } }`.
- **`get_code_connect_suggestions`**: `fileKey`, `nodeId`, `excludeMappingPrompt` (O, boolean; `true` gives a lightweight list). Returns unmapped published components (name, `mainComponentNodeId`, properties JSON, thumbnail image), or one of these literal messages: **"No published components found in this selection"** or **"All component instances in this selection are already connected to code via Code Connect"**.
- **`get_context_for_code_connect`**: `fileKey`, `nodeId`, `clientFrameworks` (array), `clientLanguages` (array). Returns component property definitions (TEXT, BOOLEAN, VARIANT, INSTANCE_SWAP, SLOT).

**Figtional:** `get_code_connect_map` returns empty or "not available in Figtional" (PLAN). The two other reads could do the same.

---

## 4. Write and other tools (not planned for Figtional, recorded for completeness)

- **`add_code_connect_map`**: `nodeId`, `fileKey`, `source`, `componentName`, `label` (enum: `React`, `Web Components`, `Vue`, `Svelte`, `Storybook`, `Javascript`, `Swift`, `Swift UIKit`, `Objective-C UIKit`, `SwiftUI`, `Compose`, `Java`, …), `template` (O), `templateDataJson` (O). Errors: `CODE_CONNECT_MAPPING_ALREADY_EXISTS`, `CODE_CONNECT_ASSET_NOT_FOUND`, `CODE_CONNECT_INSUFFICIENT_PERMISSIONS`, `CODE_CONNECT_NO_LIBRARY_FOUND`.
- **`send_code_connect_mappings`**: `fileKey`, `nodeId` (O), `mappings[]` of `{nodeId, componentName, source, label, template?, templateDataJson?}`. Errors are reported per mapping. On full success it returns fresh `get_design_context` output.
- **`create_design_system_rules`**: `clientLanguages`, `clientFrameworks` (comma strings). Returns a guidance prompt plus a rules template for the agent to fill and save into CLAUDE.md or similar. No file input is documented (`figma-power/steering/create-design-system-rules.md` Step 1). PLAN plans to derive it from the file's variables, styles and components.
- **`create_new_file`**: `fileName` (R), `planKey` (R, e.g. `"team::1234567890"`), `editorType` (R; enum, e.g. `"design"`, plus FigJam and Slides values), `projectId` (O). Returns `file_key` (plus a URL, inferred). A new Slides file has an empty slide grid.
- **`generate_diagram`**: `name` (R), `mermaidSyntax` (R), `userIntent` (O), `useArchitectureLayoutCode` (O, architecture only), `fileKey` (O; without it a new FigJam draft is created). Supported types: `flowchart`, `sequenceDiagram`, `stateDiagram(-v2)`, `gantt`, `erDiagram`. Emojis are rejected. Returns a `figma.com/board/{fileKey}/…` link or a widget.
- **`upload_assets`**: `fileKey`, `count`, `nodeIds` (O; one per upload, sets the uploads as image fills), `scaleMode` (e.g. `'FILL'`). Returns `{ uploads: [{ submitUrl }], instructions }`. The agent POSTs raw bytes (multipart field `file`, whose filename becomes the layer name). The result carries an `imageHash`. This is the **only** supported image path. `figma.createImage*` inside `use_figma` is not.
- **`generate_figma_design`**: captures a running web app into `fileKey` (required). **`html_to_figma`**: converts a static HTML document. **`send_code_to_figma`**: imports a project as a Code Layer or Make file, following its returned `nextStep`. **`generate_image`**: AI image, costs credits, ask the user first. **`generate_deck`**: template decks.
- **Shaders and generative plugins**: `create_*` (`name`, `description`, `kind` for shaders, `planKey`) → `get_*` (`id`, `includeSource`) → `update_*` (`id`, `kind`, `files: [{path, content}]`, `commitMessage`, `metadata`). Plus `list_*`.

---

## 5. `use_figma`: the JavaScript write tool

Source: `skills/figma-use/SKILL.md` and `references/` (gotchas, api-reference, plugin-api-standalone.index.md and .d.ts, validation-and-recovery), plus the FigJam and Slides skills.

### 5.1 Call shape
- **Params:** `fileKey` (R; the skills require passing it on every call, e.g. `references/workflow.md`), the JavaScript source (parameter name probably `code`, inferred), `skillNames` (O, logging). There may also be a short `description` parameter (inferred, unverified).
- Runs in the file's **editor type**: `figma`, `figjam` or `slides`. `figma.editorType` can be `'figma'|'figjam'|'dev'|'slides'|'buzz'`.
- Must be loaded with the `figma-use` skill ("MANDATORY prerequisite").

### 5.2 Execution model
- The code is **automatically wrapped in an async function**. Top-level `await` and `return` work. Don't write an async IIFE or call `figma.closePlugin()`, which is auto-called. The FigJam reference snippets still end with `figma.closePlugin()` (≈80 occurrences), and the Slides skill says "return … in `closePlugin()` output", so **`closePlugin()` and `closePlugin(message)` must be harmless**. A message probably becomes the result (inferred).
- **Output = the `return` value only**, JSON-serialized (objects, arrays, strings, numbers). `console.log` is **not** returned. A script with no return gives nothing useful.
- **Errors are auto-captured** (thrown or uncaught). The error result includes **`safeToRetryWithoutCanvasRead: boolean`**. `true` means "fix and retry"; `false` means "the canvas may be partially changed: read it first". In Figma, changes are **not** transactional: a failing script can leave partial edits. Figtional's planned all-or-nothing behaviour can always report `true`.
- **Inline images:** `await node.screenshot(opts?)` attaches a PNG to the tool response. The default scale is 0.5x, capped so the longest side is ≤ 1024 px. An explicit `{scale}` bypasses the cap. `{contentsOnly:false}` includes overlapping siblings. The caption carries metadata: `"Card (300x150 at 0,60).png"`.
- **State:** nothing persists between calls. IDs are passed back in as string literals. Page context **resets to the first page** at the start of every call.
- **Concurrency:** agents are told to fan out **parallel `use_figma` calls**, one per page, so concurrent calls on one file must be safe.
- **No network** (`createImageAsync(url)` can't fetch). Undo, notifications, `showUI`, client storage, timers, codegen, payments and `closePluginWithFailure` are unavailable.

### 5.3 Globals and non-standard helpers
`figma` (Plugin API, `apiVersion '1.0.0'`). The sub-APIs `figma.variables`, `figma.util`, `figma.viewport`, `figma.motion`, `figma.annotations`, `figma.parameters`, `figma.teamLibrary` (the last is "not implemented"), `figma.spec` (Specs feature) and `figma.fileKey` are present.

Figma MCP **extensions to the standard Plugin API** (the skills push these hard). Figtional implements `createAutoLayout`, `query()`, `set()`, `placeholder` (accepted, no visual effect) and `screenshot()`:
- `figma.createAutoLayout(direction?, props?)`: a frame with auto layout and both axes HUG; `'HORIZONTAL'` by default; props may be the first or second argument.
- `node.query(selector)`: CSS-like search inside a subtree. Selectors: type (`FRAME`, `TEXT`…), `[name=X]`, `[name*=]`, `[name^=]`, `[name$=]`, dot paths `[fills.0.type=SOLID]` and `[fills.*.type=SOLID]`, `[mainComponent=id]`, `[mainComponent.name=Button]`, the combinators `>`, descendant, `+` and `~`, `:first-child`, `:last-child`, `:nth-child(n)`, `:not()`, `:is()`, `:where()`, `#id`, comma union and `*`. Returns a **QueryResult** with `.length`, `.first()`, `.last()`, `.toArray()`, `.each()`, `.map()`, `.filter()`, `.values(keys)`, `.set(props)`, `.query()` and iteration. There is no global `figma.query`.
- `node.set(props)`: batch assignment. `layoutMode` is always applied first, `width`/`height` go through `resize()`, and it returns `this`.
- `node.placeholder = true|false`: an "AI in progress" shimmer overlay. It must be cleared.
- `await node.screenshot(opts)` (see §5.2).
- `figma.util.getSfSymbolCharacter(name)`.

### 5.4 Documented rules and pitfalls (with exact error strings)
| Rule | Error when broken |
|---|---|
| `figma.notify()` is unavailable | throws `"not implemented"` |
| Page switching is async only: `await figma.setCurrentPageAsync(page)`. Reading `figma.currentPage` is fine. | `figma.currentPage = p` throws `"Setting figma.currentPage is not supported"` |
| Switch pages at most once per call (each switch reloads the file). Other pages load lazily: `page.loadAsync()`. `figma.loadAllPagesAsync()` | "Not implemented" |
| Load fonts before **any** text mutation, including `appendChild`/`insertChild`/`setBoundVariable` on nodes with unloaded fonts. Load the node's current fonts via `getStyledTextSegments(['fontName'])`. Check style names with `listAvailableFontsAsync()` (`"SemiBold"` vs `"Semi Bold"`). Inter is preloaded. | `Cannot write to node with unloaded font "<family> <style>"` |
| Colours are in the 0–1 range. A paint `color` is `{r,g,b}` only; opacity goes on the paint. | "Property value out of range"; `Unrecognized key(s) in object: 'a' at [0].color` |
| `fills`/`strokes`/`effects` are read-only arrays: clone, modify, reassign | |
| `setBoundVariableForPaint`, `…ForEffect` and `…ForLayoutGrid` **return a new object**: reassign it | |
| `lineHeight`/`letterSpacing` take `{unit, value}`, not numbers | |
| `layoutSizingHorizontal/Vertical`: `FIXED` always works. `HUG` only on an auto-layout frame or its TEXT child. `FILL` only on a non-absolute child of auto layout. Append first, then set. | `Error: in set_layoutSizingHorizontal: node must be an auto-layout frame or a child of an auto-layout frame`; `…: FILL can only be set on children of auto-layout frames` |
| `primary/counterAxisSizingMode` take `'FIXED'|'AUTO'` only | `Expected 'FIXED' | 'AUTO', received 'FILL'` |
| `resize()` resets sizing modes to FIXED, so call it before `layoutSizing*`. `width`/`height` are read-only. | |
| Wrapping text needs `textAutoResize='HEIGHT'` + `resize()` (the default `WIDTH_AND_HEIGHT` ignores FILL) | |
| `counterAxisAlignItems` has no `'STRETCH'` | |
| Type-specific members on the wrong node type (optional chaining doesn't help) | `TypeError: node.X: no such property 'X' on Y node` (e.g. `node.children: no such property 'children' on TEXT node`) |
| Assigning an unknown property (nodes are non-extensible) | `Cannot add property X, object is not extensible` |
| `node.description` only on COMPONENT/COMPONENT_SET: reading elsewhere gives `undefined`, writing throws | `no such property` TypeError |
| `componentPropertyDefinitions` / `addComponentProperty` on a variant | `Can only get/set component property definitions of a component set or non-variant component` |
| `addComponentProperty` returns the generated key string (`"Label#2:0"`); never guess it | `Property "Label" not found` |
| `figma.createPage()` exists only in Design files | `TypeError: figma.createPage no such property 'createPage' on the figma global object` |
| `combineAsVariants` needs ComponentNodes and does **not** auto-lay out variants | |
| `detachInstance()` can implicitly detach and re-id ancestor instances | `The node with id X does not exist` |
| A missing node via `getNodeByIdAsync` returns `null` | `Cannot read properties of null` |
| New top-level nodes land at (0,0): place them to the right of existing content | |
| Set `variable.scopes` explicitly (the default is `ALL_SCOPES`). Collections start with one mode ("Mode 1"). The mode limit depends on the plan. | |
| `figma.getLocalComponents*()` doesn't exist: use `findAllWithCriteria({types:['COMPONENT','COMPONENT_SET']})` | |
| Images only via the `upload_assets` tool. Inside scripts, only copy an existing `imageHash`. | |
| `figma.showUI()`, `figma.openExternal()` | silently no-op |
| Other unsupported APIs | `"<name>" is not a supported API` |
| Moving nodes across calls with `appendChild` can fail silently, and `Internal Figma Error: Parent not found` is mentioned | |

Editor-mode node availability (`figma-use/SKILL.md` §4): in **Design**, Sticky, Connector, ShapeWithText, CodeBlock, Slide, SlideRow, SlideGrid, InteractiveSlideElement and Webpage are blocked. In **FigJam**, most design nodes are blocked and it has a single implicit page. In **Slides**, FigJam nodes and Page are blocked, and `figma.getSlideGrid()`/`createSlide()` are added.

### 5.5 Plugin API surface used in the skill examples, by frequency
Counts are occurrences inside code blocks of every `skills/**/*.md` plus `skills/figma-generate-library/scripts/*.js` (Claude Code tree, about 10.5k code lines). They include some deliberate WRONG examples. Code Connect template APIs (`figma.code`, `figma.selectedInstance`) are excluded. Use this to rank what Figtional implements first.

**Tier 1 (≥ 50):** `.fills =` 169 · `.appendChild()` 137 · `figma.loadFontAsync` 125 · `.characters =` 114 · `.name =` 108 · `figma.getNodeByIdAsync` 105 · `.resize()` 84 · `.x =` 74 / `.y =` 64 · `figma.createText` 71 · `.layoutSizingHorizontal =` 62 · `.fontSize =` 59 · `.setBoundVariable()` 58 · `.fontName =` 53

**Tier 2 (20–49):** `.findAllWithCriteria()` 44 · `figma.createAutoLayout` 39 · `figma.variables.getVariableByIdAsync` 31 · `figma.setCurrentPageAsync` 28 · `.itemSpacing` 28 · `figma.currentPage` (read) 27+ · `figma.variables.setBoundVariableForPaint` 27 · `.setValueForMode()` 27 · `figma.variables.createVariable` 25 · `.addComponentProperty()` 25 · `mainComponent` 25 · `figma.createFrame` 24 · `figma.createComponent` 23 · `.remove()` 23 · `.lineHeight` 22 · `.cornerRadius` 22 · `.setVariableCodeSyntax()` 21 · `.counterAxisAlignItems` 21 · `.createInstance()` 20 · `figma.createRectangle` 20 · `.strokes` 20 · `.scopes` 20 · `.layoutMode` 20 · `figma.createShapeWithText` 20 (FigJam)

**Tier 3 (10–19):** `.findAll()` 17 · `figma.variables.getLocalVariableCollectionsAsync` 19 · `.primaryAxisAlignItems` 19 · `.getStyledTextSegments()` 18 · `figma.root.children` 17 · `.layoutSizingVertical` 17 · `.findOne()` 14 · `figma.variables.createVariableCollection` 14 · `figma.combineAsVariants` 14 · `.padding{Top,Right,Bottom,Left}` 14 each · `.letterSpacing` 14 · `.effects` 13 · `.renameMode()` 12 · `figma.createSticky` 12 · `figma.importComponentSetByKeyAsync` 11 · `figma.createSection` 11 · `figma.createConnector` 11 · `.clone()` 11 · `.addMode()` 10 · `.resizeWithoutConstraints()` 10 · `.textAutoResize` 10 · `.primaryAxisSizingMode`/`.counterAxisSizingMode` 10

**Tier 4 (< 10):** `.textAlignHorizontal` 9 · `figma.variables.importVariableByKeyAsync` 9 · `figma.variables.getLocalVariablesAsync` 9 · `figma.createTable` 9 · `.description` 8 · `figma.getSlideGrid` 8 · `figma.createPage` 7 · `.set()` 7 · `.query()` 7 · `componentProperties` 7 · `figma.motion.*` 7 · `figma.importStyleByKeyAsync` 6 · `figma.createTextStyle` 6 · `figma.createNodeFromSvg` 6 · `.strokeWeight` 6 · `boundVariables` (read) 6 · `.setExplicitVariableModeForCollection()` 5 · `.effectStyleId` 5 · `figma.importComponentByKeyAsync` 5 · `figma.createLine` 5 · `figma.listAvailableFontsAsync` 4 · `figma.getLocalTextStylesAsync` 4 · `figma.createEffectStyle` 4 · `.setProperties()` 4 · `.insertChild()` 4 · `.insertCharacters()` 4 · `.detachInstance()` 4 · `.dashPattern` 4 · `.rotation` 4 · `.opacity` 4 · `figma.variables.createVariableAlias` 3 · `.setTextStyleIdAsync()` 3 · `.screenshot()` 3 · `.deleteCharacters()` 3 · `.layoutWrap` 3 · `.layoutGrow` 3 · `.clipsContent` 3 · `.documentationLinks` 3 · `figma.mixed` 3 · `figma.util.getSfSymbolCharacter` 3 · `figma.createVector` 3 · `figma.variables.setBoundVariableForEffect` 2 · `figma.group` 2 · `figma.createEllipse`/`createStar` 2 · `.placeholder` 2 · `.constraints` 2 · `.layoutGrids` 2 · `page.loadAsync` 2 · `.textCase` 2 · `.textAlignVertical` 2 · `.strokeAlign` 2 · `figma.getLocalEffectStylesAsync` 3 · single uses: `swapComponent`, `editComponentProperty`, `setRangeFontName`, `setRangeFontSize`, `setRangeFills`, `getRangeFontName`, `setFillStyleIdAsync`, `setStrokeStyleIdAsync`, `setEffectStyleIdAsync`, `textStyleId`, `textDecoration`, `layoutPositioning`, `counterAxisSpacing`, `blendMode`, `findChildren`, `findChild`, `exportAsync`, `getMainComponentAsync`, `figma.viewport.scrollAndZoomIntoView`.

Takeaways for Figtional's subset (compared with PLAN §5.3):
- **State in Figtional (2026-11-25).** Implemented: `createAutoLayout`, `node.query`/`node.set`, `getStyledTextSegments`, `addComponentProperty` (returns a key) and the other component property APIs, `setVariableCodeSyntax`, `variable.scopes`, `renameMode`, `findAllWithCriteria`, `node.screenshot()`, `placeholder`, `importComponentSetByKeyAsync` (embedded library sets only). Not yet: `setExplicitVariableModeForCollection`, `createNodeFromSvg`, the async style setters (`set*StyleIdAsync`), `importStyleByKeyAsync`.
- **Order:** text and paint plus `getNodeByIdAsync` and `appendChild`/`resize` cover most usage. Auto layout and variables come next. Components come after that.
- **FigJam/Slides APIs** (`createSticky`, `createShapeWithText`, `createConnector`, `createTable`, slide grid) matter only if FigJam/Slides exports are supported.

---

## 6. Surprise: the Cursor variant uses a different `use_figma` dialect

`.cursor-plugin/plugin.json` points Cursor at `skills-figquery/`, generated from a separate "fig-query" plugin. Its `figma-use` says a **`$fig` plan-based builder global** must do all node creation: "Never use `figma.createFrame()`, `figma.createText()` or any `figma.create*` methods. They do not exist in this environment." `$fig.frame/autoLayout/text/rectangle/instance/get/set/query`, `planNode.node`, `planNode.screenshot()`, auto-flush and `await $fig.done()` are described in `skills-figquery/figma-use/references/fig-builder.md`. The server likely serves two `use_figma` runtimes chosen per client or plugin bundle (inferred from the `X-Figma-Plugin-Bundle` header). **Figtional should mirror the standard Plugin API dialect** used by the Claude Code `skills/` tree. `$fig` is out of scope unless Cursor parity becomes a goal.

---

## 7. Behaviours a faithful clone should reproduce

1. **Design-to-code flow:** `get_design_context` (with screenshot), then `get_screenshot` if no image came back, then download assets, then implement. If the response is **truncated or too large**, the expected recovery is `get_metadata`, then per-child `get_design_context`. A truncation notice should say so. When the response is **sparse**, it should say so too, so the agent drills into the children.
2. **Page or canvas node passed to `get_design_context`:** error `"You currently have nothing selected"` (or similar). `get_metadata` and `get_screenshot` accept the same id.
3. **`get_metadata` without `nodeId`:** list pages as `{guid, name}` only. Fail on FigJam ("unsupported for FigJam files") and Slides.
4. **`get_screenshot` with an empty `nodeId`:** `"invalid nodeId"`.
5. **URL handling:** accept `1-2` and `1:2`, `/design/`, `/file/`, `/board/`, `/slides/` and the `/branch/:branchKey/` form (the branch key is the file key). Instance ids like `I1:2;3:4`.
6. **Asset URLs** in design context: expiring `…/api/mcp/asset/<uuid>` URLs (remote) or localhost URLs (desktop). Figtional serves them from its local asset endpoint. SVGs keep root `width`/`height`.
7. **`use_figma` runtime contract:** async wrapper with top-level `await`/`return`; JSON result; `console.log` dropped; tolerate `figma.closePlugin()`; `safeToRetryWithoutCanvasRead` on errors; `figma.notify` throws `"not implemented"`; the `currentPage` setter throws; page context resets per call; inline `node.screenshot()` images with the `"Name (WxH at X,Y).png"` caption; the exact error strings in §5.4 (agents pattern-match on them); and Figtional limitations raised as `NotSupportedInFigtional: <api>`, distinct from Figma's own `"<name>" is not a supported API`.
8. **Font loading enforcement:** throw `Cannot write to node with unloaded font "<family> <style>"` when text is mutated without `loadFontAsync`. Treat Inter as preloaded. Without this, scripts that pass on Figtional fail on Figma.
9. **Parallel calls:** handle several concurrent `use_figma` calls on one file, as agents fan out one per page.
10. **Node lookup:** `getNodeByIdAsync` returns `null` for unknown ids. Reading `description` on non-components returns `undefined`.
11. **Code Connect:** reads return the literal "No published components…" or "already connected…" messages, or a clear "not available in Figtional".
12. **`skillNames`:** accept it on every tool and ignore it.
13. **`whoami`:** return a `plans` list with a `key`, so `create_new_file`-style plan resolution doesn't dead-end. Leave out or set false `specs_enabled` and `code_layers_enabled`.
