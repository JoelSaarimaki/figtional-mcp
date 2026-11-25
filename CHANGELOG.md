# Changelog

All notable changes to Figtional MCP. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): every release raises the patch version; minor and major versions are raised only when decided explicitly. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

New entries go under **[Unreleased]** on the `development` branch, in the groups Added, Changed, Fixed and Removed. `npm run release` turns them into the next version's section.

## [Unreleased]

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

[Unreleased]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.2...development
[0.1.2]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/JoelSaarimaki/figtional-mcp/releases/tag/v0.1.0
