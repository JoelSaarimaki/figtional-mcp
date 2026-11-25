# Contributing to Figtional MCP

Thanks for helping! Figtional is a local, file-scoped stand-in for the Figma MCP server. Before you start, read [PLAN.md](PLAN.md) for the roadmap and [docs/fig-format.md](docs/fig-format.md) for what we know about the `.fig` format.

## Setup

```bash
npm install
npm run build      # compile all packages (tsc -b)
npm test           # vitest; runs against the sources
npm run lint       # eslint
npm run format     # prettier (code; Markdown is left alone)
```

Requires Node.js 22.15 or newer (Figtional uses the zstd support in `node:zlib`). CI runs on Windows, macOS and Linux with Node 22 and 24.

Packages live in `packages/`: `fig-format` (reading and writing `.fig` files), `fig-model` (document model, auto layout, editing, components), `fig-render` (SVG/PNG), `mcp-server` (MCP tools, `use_figma`), `viewer` (web viewer; the client in `static/` is plain JavaScript with no build step) and `cli` (the `figtional` command). `CLAUDE.md` describes the codebase rules in more detail.

## Ground rules

- **Faithful to Figma MCP.** Figma-named tools copy the official tools' names, parameters and output. Figtional-only tools use the `figtional_` prefix and are off by default.
- **Never lose data.** Fields and node types we don't understand must survive a decode → encode round-trip unchanged. Never hardcode the kiwi schema: always use the one embedded in the file.
- **Scope is the security model.** Nothing may list, search or open files outside the sources the user configured.
- **Cross-platform.** Use `node:path`, and no shell-specific npm scripts.

## Reference files

Real Figma exports are useful for tests but are **not** committed. Put them in a local `references/<project>/` folder (git-ignored). Tests that need them skip automatically when they are missing. If you learn something new about the format, add it to `docs/fig-format.md` and mark it as *verified* or *assumed*.

## Pull requests

- Add tests for format or behaviour changes.
- Run `npm run lint` and `npm test` before you push.
- Keep README.md (setup, client configuration, limitations) and PLAN.md's status table up to date with your change.
- Changes to the encoder need a manual check that Figma can import the result. Note it in `docs/compat-log.md`.
