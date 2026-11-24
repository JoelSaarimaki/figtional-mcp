/**
 * Fractional indices for `parentIndex.position`. Figma uses printable ASCII strings that sort
 * by code unit ("!" is the lowest seen, "~" the highest). We generate keys in the same alphabet.
 */
const MIN = 0x21; // '!'
const MAX = 0x7e; // '~'

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A key strictly between `a` and `b` (undefined = open end), or undefined when no such key
 * exists in the alphabet (e.g. before "!"); then the caller should renumber the siblings.
 */
export function keyBetween(a: string | undefined, b: string | undefined): string | undefined {
  const lower = a ?? '';
  if (b !== undefined && lower >= b)
    throw new Error(`keyBetween: ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
  let prefix = '';
  let upper = b;
  for (let i = 0; i < 64; i++) {
    const ca = i < lower.length ? lower.charCodeAt(i) : MIN - 1;
    let cb: number;
    if (upper === undefined) cb = MAX + 1;
    else if (i < upper.length) cb = upper.charCodeAt(i);
    else return undefined; // prefix equals `upper`; every extension sorts after it
    if (cb - ca > 1) return prefix + String.fromCharCode(Math.floor((ca + cb) / 2));
    if (ca < MIN) {
      // `lower` has ended and upper's digit is the minimum: follow upper.
      prefix += String.fromCharCode(cb);
      continue;
    }
    prefix += String.fromCharCode(ca);
    if (ca < cb) upper = undefined; // below upper from here on
  }
  return undefined;
}

/** `n` increasing keys, evenly spread over the alphabet (for renumbering a sibling list). */
export function spreadKeys(n: number): string[] {
  const base = MAX - MIN + 1;
  let digits = 1;
  while (base ** digits < n + 1) digits++;
  const keys: string[] = [];
  const total = base ** digits;
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * total) / (n + 1));
    let s = '';
    for (let d = 0; d < digits; d++) {
      s = String.fromCharCode(MIN + (v % base)) + s;
      v = Math.floor(v / base);
    }
    keys.push(s.replace(/!+$/, '') || '!');
  }
  return keys;
}
