import { homedir } from 'node:os';
import { parse, resolve, sep } from 'node:path';

/**
 * Folders a bare `figtional serve` must not crawl: filesystem/drive roots, the home folder and
 * system folders, i.e. the places a console tends to open in. Returns why, or undefined if fine.
 */
export function unsafeDefaultFolder(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | undefined {
  const norm = (p: string) => {
    const r = resolve(p);
    const t = r.length > parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
    return process.platform === 'win32' ? t.toLowerCase() : t;
  };
  const d = norm(dir);
  if (d === norm(parse(resolve(dir)).root)) return 'the root of a drive or filesystem';
  if (home && d === norm(home)) return 'your home folder';
  const system = [env.WINDIR, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]
    .filter((p): p is string => !!p)
    .map(norm);
  // Folders that contain everyone's home folders: refuse only the folder itself.
  const parents = [norm(resolve(home, '..'))];
  if (process.platform !== 'win32') {
    system.push(
      ...['/usr', '/etc', '/var', '/opt', '/bin', '/sbin', '/System', '/Library', '/Applications'].map(norm),
    );
    parents.push(...['/Users', '/home'].map(norm));
  }
  if (parents.includes(d)) return 'the folder that holds all user folders';
  for (const s of system) {
    if (d === s || d.startsWith(s + sep)) return 'a system folder';
  }
  return undefined;
}
