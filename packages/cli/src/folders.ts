import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Folders a bare `figtional serve` must not crawl: filesystem/drive roots, the home folder and
 * system folders, i.e. the places a console tends to open in. Returns why, or undefined if fine.
 */
export function unsafeDefaultFolder(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const { parse, resolve, sep } = platform === 'win32' ? win32 : posix;
  const norm = (p: string) => {
    const r = resolve(p);
    const t = r.length > parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
    return platform === 'win32' ? t.toLowerCase() : t;
  };
  const d = norm(dir);
  if (d === norm(parse(resolve(dir)).root)) return 'the root of a drive or filesystem';
  if (home && d === norm(home)) return 'your home folder';
  const system = [env.WINDIR, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]
    .filter((p): p is string => !!p)
    .map(norm);
  // Folders refused themselves but not their subfolders: the parent of everyone's home folders,
  // and Unix folders whose subfolders are ordinary places (macOS keeps temp folders under
  // /var/folders, Linux under /tmp; designs may live in /opt/…, /Volumes/…, /mnt/…).
  const parents = [norm(resolve(home, '..'))];
  const shallow: string[] = [];
  if (platform !== 'win32') {
    system.push(
      ...[
        '/usr',
        '/etc',
        '/bin',
        '/sbin',
        '/dev',
        '/proc',
        '/sys',
        '/boot',
        '/System',
        '/Library',
        '/private/etc',
      ].map(norm),
    );
    parents.push(...['/Users', '/home'].map(norm));
    shallow.push(
      ...[
        '/var',
        '/tmp',
        '/opt',
        '/private',
        '/private/var',
        '/private/tmp',
        '/Applications',
        '/Volumes',
        '/mnt',
        '/media',
        '/srv',
      ].map(norm),
    );
  }
  if (parents.includes(d)) return 'the folder that holds all user folders';
  if (shallow.includes(d)) return 'a system folder';
  for (const s of system) {
    if (d === s || d.startsWith(s + sep)) return 'a system folder';
  }
  return undefined;
}
