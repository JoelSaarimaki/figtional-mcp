# Contributing to Figtional MCP

Thanks for helping! Figtional is a local, file-scoped stand-in for the Figma MCP server. Before you start, read [PLAN.md](PLAN.md) for the roadmap and [docs/fig-format.md](docs/fig-format.md) for what we know about the `.fig` format.

## Setup

```bash
npm install
npm run build
npm test
```

Requires Node.js 22.15 or newer (Figtional uses the zstd support in `node:zlib`). CI runs on Windows, macOS and Linux.

## Ground rules

- **Faithful to Figma MCP.** Figma-named tools copy the official tools' names, parameters and output. Figtional-only tools use the `figtional_` prefix and are off by default.
- **Never lose data.** Fields and node types we don't understand must survive a decode → encode round-trip unchanged. Never hardcode the kiwi schema: always use the one embedded in the file.
- **Scope is the security model.** Nothing may list, search or open files outside the sources the user configured.
- **Cross-platform.** Use `node:path`, and no shell-specific npm scripts.

## Reference files

Real Figma exports are useful for tests but are **not** committed. Put them in a local `References/<project>/` folder (git-ignored). Tests that need them skip automatically when they are missing. If you learn something new about the format, add it to `docs/fig-format.md` and mark it as *verified* or *assumed*.

## Pull requests

- Add tests for format or behaviour changes.
- Run `npm run lint` and `npm test` before you push.
- Changes to the encoder need a manual check that Figma can import the result. Note it in `docs/compat-log.md`.
