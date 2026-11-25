#!/usr/bin/env node
/**
 * Prepares a release on the `development` branch (see CONTRIBUTING.md "Versions and releases").
 *
 *   npm run release            # patch: 0.1.0 → 0.1.1 (the default for every release)
 *   npm run release -- minor   # only when explicitly decided: 0.1.3 → 0.2.0
 *   npm run release -- major   # only when explicitly decided: 0.4.2 → 1.0.0
 *
 * It sets the same version in the root and every package, moves the CHANGELOG's [Unreleased]
 * entries under the new version, refreshes package-lock.json, and prints the remaining steps.
 * It does not commit, tag, merge or push.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const level = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(level)) {
  console.error(`usage: npm run release [-- patch|minor|major]   (got "${level}")`);
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'development' && !process.env.FIGTIONAL_RELEASE_ANY_BRANCH) {
  console.error(`Releases are prepared on "development" (current branch: "${branch}").`);
  process.exit(1);
}
if (git('status', '--porcelain')) {
  console.error('The working tree has uncommitted changes. Commit or stash them first.');
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

const rootPkgPath = join(root, 'package.json');
const rootPkg = readJson(rootPkgPath);
const [major, minor, patch] = rootPkg.version.split('.').map(Number);
const next =
  level === 'major'
    ? `${major + 1}.0.0`
    : level === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

// 1. Same version everywhere.
rootPkg.version = next;
writeJson(rootPkgPath, rootPkg);
for (const dir of readdirSync(join(root, 'packages'))) {
  const p = join(root, 'packages', dir, 'package.json');
  try {
    const pkg = readJson(p);
    pkg.version = next;
    writeJson(p, pkg);
  } catch {
    /* not a package */
  }
}

// 2. CHANGELOG: [Unreleased] entries become the new version's section.
const changelogPath = join(root, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
const marker = '## [Unreleased]';
if (!changelog.includes(marker)) {
  console.error('CHANGELOG.md has no "## [Unreleased]" section.');
  process.exit(1);
}
const unreleased = changelog
  .split(marker)[1]
  .split(/\n## \[/)[0]
  .trim();
if (!unreleased)
  console.warn('Warning: [Unreleased] is empty. Add the changes in this release to CHANGELOG.md.');
let updated = changelog.replace(marker, `${marker}\n\n## [${next}]`);
// Comparison links at the bottom: [Unreleased] now starts from the new tag.
updated = updated.replace(
  /^\[Unreleased\]: (.+)\/compare\/v([\d.]+)\.\.\.development$/m,
  (_m, base, prev) =>
    `[Unreleased]: ${base}/compare/v${next}...development\n[${next}]: ${base}/compare/v${prev}...v${next}`,
);
writeFileSync(changelogPath, updated);

// 3. Lockfile (a fixed command line, so running it through the shell is safe on every OS).
execSync('npm install --package-lock-only --ignore-scripts --silent', { cwd: root, stdio: 'inherit' });

console.log(`
Version ${next} prepared on "development" (${level}).

Next steps:
  1. Review CHANGELOG.md, then commit:  git commit -am "Release ${next}"
  2. Open a pull request from development to main and merge it (merge commit, not squash).
  3. Tag the release on main:           git tag -a v${next} -m "Figtional ${next}" && git push origin main v${next}
  4. Bring development up to date:      git checkout development && git merge --ff-only main && git push
`);
