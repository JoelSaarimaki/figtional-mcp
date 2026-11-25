/** `node.query()` / `figma.query()` selectors and their result objects (Figma MCP's extension). */

export function matchesSimple(node: any, sel: string): boolean {
  const m = /^([A-Z_*]+)?(#[\w:;-]+)?((?:\[[^\]]+\])*)((?::[\w-]+(?:\([^)]*\))?)*)$/.exec(sel.trim());
  if (!m) throw new Error(`Invalid selector "${sel}"`);
  const [, type, id, attrs, pseudos] = m;
  if (type && type !== '*' && node.type !== type) return false;
  if (id && node.id !== id.slice(1)) return false;
  for (const a of attrs!.match(/\[[^\]]+\]/g) ?? []) {
    const am = /^\[([\w.*]+)\s*(\*=|\^=|\$=|=)?\s*"?([^"\]]*)"?\]$/.exec(a);
    if (!am) throw new Error(`Invalid attribute selector ${a}`);
    const [, path, op, val] = am;
    const values = getPath(node, path!.split('.'));
    const ok = values.some((v) => {
      if (!op) return v !== undefined && v !== null;
      const s = String(v);
      return op === '='
        ? s === val
        : op === '*='
          ? s.includes(val!)
          : op === '^='
            ? s.startsWith(val!)
            : s.endsWith(val!);
    });
    if (!ok) return false;
  }
  for (const p of pseudos!.match(/:[\w-]+(?:\([^)]*\))?/g) ?? []) {
    const siblings: any[] = node.parent?.children ?? [];
    const i = siblings.findIndex((x) => x.id === node.id);
    if (p === ':first-child' && i !== 0) return false;
    if (p === ':last-child' && i !== siblings.length - 1) return false;
    const nth = /^:nth-child\((\d+)\)$/.exec(p);
    if (nth && i !== Number(nth[1]) - 1) return false;
    const not = /^:not\((.*)\)$/.exec(p);
    if (not && matchesSimple(node, not[1]!)) return false;
  }
  return true;
}
export function getPath(obj: any, parts: string[]): any[] {
  if (!parts.length) return [obj];
  const [head, ...rest] = parts;
  if (obj === null || obj === undefined) return [];
  if (head === '*') return Array.isArray(obj) ? obj.flatMap((x) => getPath(x, rest)) : [];
  let next: any;
  try {
    next = head === 'mainComponent' ? obj.mainComponent : obj[head!];
  } catch {
    return [];
  }
  if (head === 'mainComponent' && rest.length === 0) return [next?.id];
  return getPath(next, rest);
}
export function querySelector(root: any, selector: string): any[] {
  const results = new Map<string, any>();
  for (const part of selector.split(',')) {
    const tokens = part
      .trim()
      .replace(/\s*>\s*/g, ' > ')
      .split(/\s+/)
      .filter(Boolean);
    let current: any[] = [root];
    let combinator: 'desc' | 'child' = 'desc';
    for (const tok of tokens) {
      if (tok === '>') {
        combinator = 'child';
        continue;
      }
      const next: any[] = [];
      for (const c of current) {
        const pool = combinator === 'child' ? (c.children ?? []) : c.findAll();
        for (const n of pool) if (matchesSimple(n, tok)) next.push(n);
      }
      current = next;
      combinator = 'desc';
    }
    for (const n of current) if (n !== root) results.set(n.id, n);
  }
  return [...results.values()];
}
export function makeQueryResult(nodes: any[]) {
  return Object.assign([...nodes], {
    first: () => nodes[0] ?? null,
    last: () => nodes[nodes.length - 1] ?? null,
    toArray: () => [...nodes],
    each: (fn: (n: any, i: number) => void) => (nodes.forEach(fn), undefined),
    values: (keys: string[]) => nodes.map((n) => Object.fromEntries(keys.map((k) => [k, n[k]]))),
    set: (props: Record<string, unknown>) => (nodes.forEach((n) => n.set(props)), makeQueryResult(nodes)),
    query: (sel: string) => makeQueryResult(nodes.flatMap((n) => querySelector(n, sel))),
  });
}
