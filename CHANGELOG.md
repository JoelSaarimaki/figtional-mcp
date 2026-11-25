# Changelog

All notable changes to Figtional MCP. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): every release raises the patch version; minor and major versions are raised only when decided explicitly. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

New entries go under **[Unreleased]** on the `development` branch, in the groups Added, Changed, Fixed and Removed. `npm run release` turns them into the next version's section.

## [Unreleased]

### Changed

- `use_figma` keeps the decoded document between calls while the file is unchanged on disk, so calls after the first are faster on large files (270 MB Futurice.com UI: about 2.0 s → 1.5 s per edit; read-only calls nearly instant). A failed call still leaves nothing behind.
- Docs brought up to date with 0.2.0: README's editing features and limitations, the tool reference's implementation state, PLAN's status (M9 done: releases, multi-OS tests, Futurice.com UI loads in about 1.2 s).

### Fixed

- `use_figma`: setting only one of `minWidth`/`minHeight` (or `maxWidth`/`maxHeight`) made the save fail ("missing required field Vector.y"). Unset dimensions are now stored as Figma does (0 for a minimum, Infinity for a maximum).
- `use_figma`: `LAYER_BLUR` effects made the save fail; the file format calls them `FOREGROUND_BLUR`. Screenshots, the viewer and `get_design_context` now also show layer blurs from Figma's own files, which they ignored before.
- `use_figma`: setting `characters` renamed a text layer even after its `name` was set explicitly. Setting `name` now turns `autoRename` off, as in Figma, and `autoRename` can be read and set.
- `use_figma`: components and component sets had no `key`, so `importComponentByKeyAsync` couldn't find local components and instance-swap `preferredValues` lost their keys.
- `use_figma`: an object returned twice in a result (e.g. `{ x: o, y: o }`) was shown as `[Circular]`; only real cycles are now.
- `use_figma`: binding a single corner radius (`topLeftRadius` etc.) to a variable left the corner at 0, and other bound numbers took the default mode's value. Bound values are now applied in the mode in effect at the layer.
- `use_figma`: STRING and BOOLEAN variables (e.g. bound text and visibility) didn't follow explicit mode changes; only colours did. All bound values now follow the mode.
- Instances didn't follow root changes of their main component (fills, padding, corner radius…), and `swapComponent` or an instance-swap property kept the old component's root fills. Instances now take their component's root values except where they override them, recorded the way Figma stores instance overrides.
- Fonts installed as one variable font file (e.g. Inter 4) were used at their default weight only, so Semi Bold or Bold text was measured and drawn as Regular. Their named weights are now used.
- Screenshots and the viewer now draw new and edited text with its styled ranges (fills, fonts, sizes, underline and strikethrough) and its text case (e.g. `UPPER`, also when measuring), and draw dashed strokes; `get_design_context` outputs dashed borders.

## [0.2.0]

### Added

- `use_figma`: `figma.createNodeFromSvg()` for icons and simple drawings (paths and basic shapes with solid fills and strokes; SVG features Figtional can't reproduce faithfully, such as text, images and gradients, are refused with a Figtional limitation), and `figma.createVector()` with `vectorPaths`, `vectorNetwork` and `setVectorNetworkAsync`. The viewer and screenshots draw these vectors.
- `use_figma`: new images with `figma.createImage(bytes)` and `figma.createImageAsync()` for `data:` URLs (Figtional makes no network requests), `getImageByHash`, `image.getSizeAsync()` / `getBytesAsync()`, and `figma.base64Encode` / `base64Decode`. New images are saved into the `.fig` file and shown in screenshots and the viewer.
- `use_figma`: paint, text, effect and grid styles: `figma.createPaintStyle()` and friends, `getLocal*StylesAsync`, `getStyleByIdAsync`, `importStyleByKeyAsync` for styles embedded in the file, and applying them with `setFillStyleIdAsync`, `setStrokeStyleIdAsync`, `setEffectStyleIdAsync`, `setGridStyleIdAsync` and `setTextStyleIdAsync`. Layers using a style follow changes to it; setting a value directly detaches the style, as in Figma.
- `use_figma`: explicit variable modes (`setExplicitVariableModeForCollection`, `clearExplicitVariableModeForCollection`, `explicitVariableModes`, `resolvedVariableModes`) on frames, components, component sets, instances and sections, e.g. for light and dark themes. The colours stored with bound layers are updated to the new mode.

### Changed

- Rendering (viewer and screenshots) draws colours bound to variables in the mode in effect at each layer, as Figma does, instead of the colour stored with the layer. Frames with an explicit mode (e.g. Dark) now look right, and Futurice's landing page matches Figma's export more closely.

## [0.1.4]

### Added

- When a font isn't installed and its replacement affects a result, the tool says so in a separate "Figtional limitation" note: `use_figma` when it measured text with a replacement font (sizes and auto layout may differ in Figma), and `get_screenshot` / `node.screenshot()` when edited text is drawn with one. Results are otherwise unchanged.

### Fixed

- `use_figma`: property values set on instances of a variant (`setProperties`, also after switching variant) were stored against the component set's property instead of the variant's, so Figma showed the default text and visibility after import. They are now stored the way Figma stores them.
- `use_figma`: text copied with `clone()` in the same call it was created or edited in kept its unmeasured size (0×0 for new text), so auto layout around the copy, and a component set fitted to it, came out too small; in Figma the copy then overflowed the set. Copies are now measured like the original.

## [0.1.3]

### Changed

- `figtional setup` ends with a ready-to-run viewer command with full paths (on Windows in PowerShell and Command Prompt forms), instead of `figtional serve`, which only works where `figtional` is installed as a command.
- README and the download's README.txt: start the viewer from a terminal opened in the Figtional folder, with the designs folder as the argument. On Windows the launcher is written `.\figtional.cmd`, which PowerShell needs.

## [0.1.2]

### Fixed

- Windows: edits (`use_figma`) failed with `EPERM` while the viewer had the same file open, because the viewer kept the file open between reads. Files are now opened only for each read, a reader notices when the file was replaced, and saving retries briefly if another program is reading the file at that moment.

### Changed

- README: the install instructions point to the web viewer, and step 5 explains that the viewer and the MCP server (or Claude Desktop extension) run side by side and that the viewer reloads changed files within about 2 seconds.

## [0.1.1]

### Added

- `figtional setup`: guided setup that asks which folders the AI may read and adds Figtional to Claude Code (`claude mcp add`), Claude Desktop, Cursor and VS Code (merging their JSON config, with a `.bak` backup). `--yes`, `--client`, `--print` for scripted use.
- `figtional serve --open` opens the viewer in the browser.
- `FIGTIONAL_WRITABLE` and `FIGTIONAL_RECURSIVE` environment variables for `figtional mcp`.
- A clear error when Node.js is older than 22.15, instead of a module-loading error.
- **Downloads for each release:** `figtional-<version>.zip` (one folder for Windows, macOS and Linux, with double-click setup scripts; needs only Node.js) and `figtional-<version>.mcpb` (Claude Desktop extension with a folder picker). Built by `npm run package`, smoke-tested on all three systems and published by a GitHub Actions release workflow when a version tag is pushed.

### Changed

- README: the Quick start offers the download, the Claude Desktop extension and `figtional setup` before manual configuration; Git is only needed to install from source.
- README: Limitations now lists what a `.fig` export leaves out (comments, history, sharing, live library links, Code Connect, fonts) and what it keeps.

### Fixed

- `get_design_context`: corner radius came out as broken Tailwind (`border-r-[20px] border-undefined border-[]`) instead of `rounded-[20px]`, on every rounded frame, rectangle and ellipse. HTML/CSS output was not affected.
- macOS and Linux: `figtional serve` without sources (and `figtional setup`) refused every folder below `/var` and `/opt`, including macOS's temporary folders. Now only `/var`, `/tmp`, `/opt` and similar folders themselves are refused; system trees like `/usr` and `/System` still are.

## [0.1.0]

First release.

### Added

- **File format:** reading and writing Figma `.fig` exports, re-encoding byte for byte with the schema embedded in each file (`fig-kiwi` versions 101 and 106 seen). Files written by Figtional import cleanly into Figma.
- **Document model:** pages, layers, groups, components and instances (overrides, nested instances, library copies, component properties), styles, variables and modes, and prototype flows in both of Figma's formats.
- **Auto layout engine:** reproduces Figma's stored layouts for 98–100% of auto-layout children in the reference files.
- **Rendering:** SVG and PNG from Figma's stored geometry and glyph outlines, within 2% of Figma's own exports for most frames.
- **MCP server** with Figma MCP's tools: `whoami`, `get_metadata`, `get_design_context` (React + Tailwind or HTML/CSS, with a local asset server), `get_screenshot`, `get_variable_defs`, `search_design_system`, `get_libraries`, `get_code_connect_map`, `create_design_system_rules` and `use_figma`. Optional Figtional-only tools behind `--extra-tools`.
- **Access control:** one file, a list of files or a folder; read-only unless `--writable`; edits can go to `--out` copies.
- **`use_figma`:** a Plugin API subset covering frames, auto layout, shapes, text with font loading rules, fills, strokes, effects, pages, variables, components with properties and variants, instances, `detachInstance`, `query()`, `set()` and `screenshot()`. Calls are all-or-nothing and saved immediately; text is measured with installed fonts.
- **Web viewer** (`figtional serve`): page selector, layer tree, pan/zoom canvas, inspect panel, file info, prototype arrows and a basic Present mode. It reloads on file changes and only listens on `127.0.0.1`.
- **CLI:** `mcp`, `serve`, `dump`, `inspect`, `validate` and per-command help.

[Unreleased]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.2.0...development
[0.2.0]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JoelSaarimaki/figtional-mcp/releases/tag/v0.1.0
