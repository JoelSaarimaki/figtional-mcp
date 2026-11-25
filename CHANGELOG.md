# Changelog

All notable changes to Figtional MCP. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): every release raises the patch version; minor and major versions are raised only when decided explicitly. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

New entries go under **[Unreleased]** on the `development` branch, in the groups Added, Changed, Fixed and Removed. `npm run release` turns them into the next version's section.

## [Unreleased]

### Changed

- README: Limitations now lists what a `.fig` export leaves out (comments, history, sharing, live library links, Code Connect, fonts) and what it keeps.

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

[Unreleased]: https://github.com/JoelSaarimaki/figtional-mcp/compare/v0.1.0...development
[0.1.0]: https://github.com/JoelSaarimaki/figtional-mcp/releases/tag/v0.1.0
