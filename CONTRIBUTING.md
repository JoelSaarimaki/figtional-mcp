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

## Branches

| Branch | Purpose |
|---|---|
| `main` | Released code only. Every commit on `main` is a release and carries a version tag (`v0.1.0`, `v0.1.1`, …). Never commit to it directly. |
| `development` | The integration branch: all work lands here first. Pull requests should target `development` (GitHub suggests `main`, the repository's default branch, so change the base branch when you open one). |
| `feature/<short-name>`, `fix/<short-name>` | Optional short-lived branches for larger changes; open a pull request into `development`. |

Small changes can go straight to `development`. Before merging into `development`, run `npm run lint` and `npm test` and add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md).

## Versions and releases

Figtional has **one version** for the whole project (root `package.json` and every package; `figtional --version` and the MCP server report it). Versions follow [Semantic Versioning](https://semver.org/) with this policy:

- **Every release raises the patch version** (0.1.0 → 0.1.1 → 0.1.2 …).
- **Minor and major versions are raised only when explicitly decided** (for example "the next release is 0.2.0").
- Documentation refers to versions, not dates ("verified in 0.1.0").

A release is the merge of `development` into `main`:

1. On `development`, check that `[Unreleased]` in CHANGELOG.md describes the changes, then run `npm run release` (or `npm run release -- minor` / `-- major` when that was decided). It sets the new version everywhere, moves the changelog entries under it and updates the lockfile.
2. Commit with the message `Release X.Y.Z` and push `development`.
3. Open a pull request from `development` to `main`. Besides CI, it runs the **Release** workflow's build and smoke tests (without publishing), so the downloads are known to work on every OS before the merge. Merge it with a **merge commit** (not squash, so both branches share history).
4. Tag the merge on `main` and push the tag: `git tag -a vX.Y.Z -m "Figtional X.Y.Z"` then `git push origin main vX.Y.Z`. The tag starts the **Release** workflow (`.github/workflows/release.yml`): it builds the downloads, smoke-tests the zip on Windows, macOS and Linux (x64 and ARM, Node.js 22.15.0 and 24), and publishes a GitHub release with the changelog section as notes. Check that it went green.
5. Fast-forward `development` to `main`: `git checkout development && git merge --ff-only main && git push`.

#### With GitHub Desktop

The same steps without the command line (step 1 still needs `npm run release` in a terminal: **Repository → Open in Command Prompt** or **Open in Terminal**):

- **Step 2:** commit `Release X.Y.Z` in the **Changes** tab, then click **Push origin**.
- **Step 3:** **Branch → Create Pull Request** opens GitHub in the browser. Set the base branch to `main`, wait for the checks, and merge with **Create a merge commit**.
- **Step 4:** switch to `main` and click **Fetch origin**, then **Pull origin**, so the merge commit is local. In the **History** tab, right-click the "Merge pull request …" commit, choose **Create Tag…** and enter `vX.Y.Z`. Then click **Push origin**: Desktop pushes tags made in the app even when there are no new commits. (It doesn't notice tags made with `git tag` on the command line; push those with `git push origin vX.Y.Z`.)
- **Step 5:** switch to `development` and use **Branch → Merge into current branch…** and choose `main`. It's a fast-forward, so no merge commit is created. Then click **Push origin**.

Don't create the tag through **Draft a new release** on GitHub: the Release workflow creates the release itself and would fail because it already exists.

Before switching branches, Desktop offers to stash changed and untracked files that aren't ignored. Keep local-only material in `local-only/` (ignored) so it isn't carried along or lost with a discarded stash.

### Download packages

`npm run package` (`scripts/package.mjs`) builds what the release workflow publishes, on any OS:

- `release/figtional-X.Y.Z.zip`: our code bundled into `lib/figtional.mjs` with esbuild, the viewer's `static/` files, launchers (`figtional`, `figtional.cmd`, `Set up Figtional.cmd`, `Set up Figtional.command`) and a README.txt. The only native dependency, `@resvg/resvg-js`, is included with the binaries of every supported platform, downloaded from the npm registry and checked against the hashes in `package-lock.json`. So one zip serves Windows, macOS and Linux.
- `release/figtional-X.Y.Z.mcpb`: the same files with a `manifest.json`, as a Claude Desktop extension. The manifest is checked with `@anthropic-ai/mcpb`.

Test an unpacked zip with `node scripts/smoke-release.mjs <folder> [file.fig]` (with a `.fig` file it also takes a screenshot, edits a copy and measures text). Release pull requests and manual runs (Actions → Release → Run workflow) build and test without publishing. A new dependency that reads files next to its own module breaks in the bundle: the smoke test's `use_figma` and viewer checks are there to catch that.

## Ground rules

- **Faithful to Figma MCP.** Figma-named tools copy the official tools' names, parameters and output. Figtional-only tools use the `figtional_` prefix and are off by default.
- **Never lose data.** Fields and node types we don't understand must survive a decode → encode round-trip unchanged. Never hardcode the kiwi schema: always use the one embedded in the file.
- **Scope is the security model.** Nothing may list, search or open files outside the sources the user configured.
- **Cross-platform.** Use `node:path`, and no shell-specific npm scripts.

## Reference files

Real Figma exports are useful for tests but are **not** committed. Put them in a local `references/<project>/` folder (git-ignored). Tests that need them skip automatically when they are missing. If you learn something new about the format, add it to `docs/fig-format.md` and mark it as *verified* or *assumed*.

## Pull requests

- **Titles.** Normal pull requests (a `feature/…` or `fix/…` branch into `development`) say what the change does, in the imperative and without a version: "Fix corner radius in get_design_context". Release pull requests (`development` into `main`) are titled `Release X.Y.Z`, matching the release commit and tag, with that version's CHANGELOG section as the description.
- **Labels** are optional. Use GitHub's defaults (`bug`, `enhancement`, `documentation`) on normal pull requests if they help; release pull requests don't need one.
- Add tests for format or behaviour changes.
- Run `npm run lint` and `npm test` before you push.
- Add user-visible changes to `[Unreleased]` in CHANGELOG.md, and keep README.md (setup, client configuration, limitations) and PLAN.md's status table up to date with your change.
- Changes to the encoder need a manual check that Figma can import the result. Note it in `docs/compat-log.md`.
