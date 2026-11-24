# Figtional MCP

**Figtional MCP** is a local MCP server that lets AI agents read and edit Figma `.fig` export files as if they were connected to Figma, but limited to the files *you* choose.

The official Figma MCP server gives an agent access to every file in your Figma account. Figtional works on local `.fig` exports instead: you export the file(s) you want to share, point Figtional at them, and the agent sees only those files. Nothing leaves your machine.

Use it to:
- **Practise working with Figma MCP** in a safe environment. The tools behave like Figma's, so what you learn carries over.
- **Edit Figma files locally** with an AI agent, then import the result back into Figma.

Works on Windows, macOS and Linux.

It also includes a read-only **web viewer** that renders a `.fig` file in the browser the way Figma does, with a page selector, a layer outline and an inspect panel.

> **Status:** early development. All read tools work (`whoami`, `get_metadata`, `get_design_context`, `get_variable_defs`, `get_screenshot`, `search_design_system`, `get_libraries`), the web viewer works, and `use_figma` supports a first subset of the Plugin API for editing (see Limitations). See [PLAN.md](PLAN.md) for the roadmap.

## Features

- **Figma-compatible MCP tools**: `get_metadata`, `get_design_context` (React + Tailwind or HTML/CSS), `get_screenshot`, `get_variable_defs`, `search_design_system`, `whoami`, … with the same names and parameters as the official Figma MCP, so existing prompts and skills keep working.
- **Editing** through a subset of the Figma Plugin API (`use_figma`): text, colours, variables, screens, components, auto layout and pages. Changes are saved immediately to a `.fig` file that opens in Figma.
- **Library support**: library components, styles and variables that Figma embeds in the export work normally. Components that are really missing are shown as placeholders.
- **Optional extra tools** (`--extra-tools`, off by default): Figtional-only helpers such as `figtional_find_nodes`. They are off by default so the tool set matches Figma MCP's.
- **Explicit scope**: one file, a list of files, or a folder of `.fig` files. Nothing else is visible, and files are read-only unless marked writable.
- **Web viewer**: `figtional serve design.fig` → `http://127.0.0.1:3846`.
- **Fully local**: no network access, no Figma account needed. `get_design_context` serves images and vectors from a local asset server on `http://localhost:3845` (like Figma's desktop MCP server).

## Getting a `.fig` file

In Figma: **Main menu → File → Save local copy…** This produces a `.fig` file. If the file uses shared libraries, the parts it uses are included in the export.

To bring changes back into Figma, drag the edited `.fig` into the Figma file browser (or use **Import**). This creates a **new** Figma file: comments, version history and links to the original are not carried over. To apply the changes to the original file instead, use the Figtional viewer as a visual reference.

## Installation

```bash
git clone <repo-url> figtional-mcp
cd figtional-mcp
npm install
npm run build
```

Requires Node.js 22.15 or newer.

## Usage

### MCP server

Run it over stdio and choose what the agent can access: one file, several files, or every `.fig` in a folder.

Until the package is published, run the built CLI directly: `node packages/cli/dist/bin.js mcp …` (or `npm link` inside `packages/cli` to get a `figtional` command).

```bash
npx figtional mcp ./designs/App.fig                       # one file
npx figtional mcp ./designs/App.fig ./designs/Marketing.fig  # specific files
npx figtional mcp ./designs/                              # all .fig files in the folder
npx figtional mcp --recursive ./designs/                  # ...including subfolders
npx figtional mcp --writable ./designs/App.fig            # allow edits
npx figtional mcp --writable --out ./edited ./designs/App.fig   # write edits elsewhere
```

With a folder source, `.fig` files added to the folder later appear automatically. Nothing outside the folder is reachable, and symlinks that point out of it are ignored.

Claude Code (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "figtional": {
      "command": "npx",
      "args": ["figtional", "mcp", "--writable", "./designs/App.fig"]
    }
  }
}
```

Or with a config file (`figtional.config.json`):

```json
{
  "sources": [
    { "file": "./designs/App.fig", "key": "app", "writable": true },
    { "file": "./designs/Marketing.fig" },
    { "dir": "./designs/archive", "recursive": true }
  ],
  "outDir": "./edited"
}
```

```bash
npx figtional mcp --config figtional.config.json
```

Tools accept Figma-style URLs as well as `fileKey` + `nodeId`:
`https://www.figma.com/design/app/App?node-id=1-4` → file `app`, node `1:4`. A key outside the configured sources gives an error. Files from a folder source are keyed by their relative path, with `--` between folders (`archive--old-landing`). `whoami` lists every available file key.

### Web viewer

```bash
npx figtional serve                              # every .fig below the current folder
npx figtional serve ./designs/App.fig            # http://127.0.0.1:3846
npx figtional serve --port 4000 --watch ./designs/App.fig
npx figtional serve ./designs/                   # folder → file switcher in the top bar
```

- File switcher and page selector (top bar)
- Prototype flows: connection arrows and a click-through "Present" mode
- Deep links: `?file=<key>&page=<id>&node-id=1-4` (add `&proto=1` or `&present=1`)
- Reloads automatically when the file changes on disk, so you can watch an agent's edits
- Layer outline (left)
- Pan/zoom canvas
- Inspect panel with node properties and file metadata (right)

The viewer cannot edit files.

### Other commands

```bash
npx figtional dump App.fig               # pages, node counts, format version
npx figtional inspect App.fig 1:4        # node outline (XML); add --json for the decoded data
npx figtional validate App.fig           # format version and round-trip check
```

## Development

The format was worked out from real Figma exports kept in a local, git-ignored `References/` folder (`.fig` files plus Figma screenshots and PNG/SVG exports). What we learned is recorded in [docs/fig-format.md](docs/fig-format.md). Tests that need reference files skip when the folder is missing. To run them, put `.fig` exports with matching PNG/SVG frame exports in `References/<project>/`.

## Editing with `use_figma`

Start Figtional with `--writable` (or `"writable": true` per source). The agent then sends Plugin API code, exactly as with Figma MCP:

```js
await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
const card = figma.createAutoLayout("VERTICAL", { itemSpacing: 12, paddingLeft: 24, paddingRight: 24 });
const title = figma.createText();
title.fontName = { family: "Inter", style: "Semi Bold" };
title.characters = "Hello";
card.appendChild(title);
return { id: card.id };
```

- Each successful call is saved to the file right away (with a `.bak` of the previous version), or to `--out <dir>`.
- A call that throws changes nothing. Figma can leave partial edits behind; Figtional doesn't.
- Text is measured with fonts installed on your machine and auto layout is recalculated, so screenshots and the viewer show the result. Figma recalculates text layout itself when you import the file.
- Supported: creating and editing frames, auto layout, rectangles, ellipses, lines, text, components and instances, pages and variables; text/visibility/fill overrides inside instances; `node.screenshot()`. Unsupported calls fail with `NotSupportedInFigtional: …`.

## How it works

A `.fig` export is a ZIP archive containing `canvas.fig` (Figma's binary **fig-kiwi** document), `meta.json`, `thumbnail.png` and an `images/` folder. Figtional decodes `canvas.fig` using the kiwi schema embedded in the file itself, builds a document tree, and re-encodes it with the same schema when saving, which keeps it compatible with Figma. See [PLAN.md](PLAN.md) for details.

## Limitations

- `use_figma` supports a **subset** of the Plugin API. Calls that are not supported fail with a clear `NotSupportedInFigtional` error; that is a Figtional limitation, not necessarily a Figma one. Not supported yet: component properties and variants, detaching instances, creating styles, vectors/SVG import, new images, prototype interactions.
- The `use_figma` sandbox (Node's `vm`) keeps scripts away from `require`, files and the network by convention, but it is not a security boundary. The access boundary is the file scope you start Figtional with.
- Rendering is visually faithful but not pixel-identical to Figma (some blend modes, effects and text shaping differ).
- Text that hasn't been edited is drawn exactly as Figma laid it out. Edited or new text uses **fonts installed on your machine**. If a design font is missing, Figtional falls back to a basic sans-serif, serif or monospace font for display, but the file keeps the original font, so Figma shows it correctly after import.
- No Code Connect, comments, version history or multiplayer. Those live in Figma's cloud, not in `.fig` files.

## License

[MIT](LICENSE)

## Disclaimer

Figtional is an independent project. It is not affiliated with or endorsed by Figma, Inc. "Figma" is a trademark of Figma, Inc.
