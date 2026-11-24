import { type NodeChange, guidToString } from '@figtional/fig-format';
import { type FigDocument, isInternalPage, styleInfo, variableInfo } from '@figtional/fig-model';

export interface SearchQuery {
  entity: 'component' | 'variable' | 'style';
  query: string;
}

/** Library a node comes from: the file itself, or an embedded copy of a library asset. */
function libraryOf(n: NodeChange, fileName: string): { name: string; key: string } {
  if (n.sourceLibraryKey) return { name: libraryName(n.sourceLibraryKey), key: n.sourceLibraryKey };
  return { name: fileName, key: 'local' };
}

/** .fig exports don't store library names, only keys; give them a stable, readable label. */
export function libraryName(libraryKey: string): string {
  return `Library ${libraryKey.replace(/^lk-/, '').slice(0, 8)}`;
}

/** 0 = no match; higher is better. One intent per query; no OR semantics. */
function score(name: string, description: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  const leaf = n.split('/').pop()!.trim();
  if (leaf === q || n === q) return 100;
  if (leaf.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.every((t) => n.includes(t))) return 40;
  if (tokens.every((t) => description.toLowerCase().includes(t))) return 20;
  return 0;
}

/** Variant components inside a component set are found through the set. */
function isVariant(doc: FigDocument, n: NodeChange): boolean {
  const parent = n.parentIndex ? doc.nodes.get(guidToString(n.parentIndex.guid)) : undefined;
  return !!parent?.isStateGroup;
}

function isUserFacing(doc: FigDocument, n: NodeChange): boolean {
  // Embedded library copies live on the internal page; they are still searchable (that's how
  // Figma's library search sees them), but internal helper nodes without keys are not.
  let p: NodeChange | undefined = n;
  while (p?.parentIndex) {
    p = doc.nodes.get(guidToString(p.parentIndex.guid));
    if (p && isInternalPage(p)) return !!(n.key || n.componentKey || n.sourceLibraryKey);
  }
  return true;
}

export function searchDesignSystem(doc: FigDocument, fileName: string, queries: SearchQuery[], limit = 20) {
  const results: any[] = [];
  for (const q of queries) {
    if (q.entity === 'component') {
      const candidates: NodeChange[] = [];
      for (const n of doc.nodes.values()) {
        if (n.type === 'SYMBOL' && !isVariant(doc, n) && isUserFacing(doc, n)) candidates.push(n);
        else if (n.type === 'FRAME' && n.isStateGroup && isUserFacing(doc, n)) candidates.push(n);
      }
      // Exports can embed several copies (versions) of one library asset: one result per key.
      dedupeByKey(candidates, (n) => n.componentKey ?? n.key);
      const components = rank(candidates, q.query, (n) => [n.name ?? '', n.description ?? ''], limit).map(
        (n) => {
          const lib = libraryOf(n, fileName);
          const isSet = n.type === 'FRAME';
          const out: any = {
            name: n.name,
            libraryName: lib.name,
            assetType: isSet ? 'component_set' : 'component',
            nodeId: guidToString(n.guid),
            description: n.description ?? '',
          };
          out[isSet ? 'componentSetKey' : 'componentKey'] = n.componentKey ?? n.key ?? guidToString(n.guid);
          return out;
        },
      );
      results.push({ entity: 'component', query: q.query, components });
    } else if (q.entity === 'variable') {
      const variables = rank(
        dedupeByKey([...doc.variables], (n) => n.key),
        q.query,
        (n) => [n.name ?? '', n.description ?? ''],
        limit,
      ).map((v) => {
        const info = variableInfo(doc, v);
        const set = info.collectionId ? doc.nodes.get(info.collectionId) : undefined;
        return {
          name: info.name,
          variableType: info.resolvedType,
          variableSetKey: set?.key ?? info.collectionId,
          key: v.key ?? info.id,
          scopes: info.scopes ?? ['ALL_SCOPES'],
          variableCollectionName: info.collectionName ?? '',
        };
      });
      results.push({ entity: 'variable', query: q.query, variables });
    } else if (q.entity === 'style') {
      const styles = rank(
        dedupeByKey([...doc.styles], (n) => n.key),
        q.query,
        (n) => [n.name ?? '', n.styleDescription ?? ''],
        limit,
      ).map((s) => {
        const info = styleInfo(s);
        return { name: info.name, styleType: info.styleType, key: info.key ?? info.id };
      });
      results.push({ entity: 'style', query: q.query, styles });
    }
  }
  return { results };
}

/** Removes later items whose key was already seen (items without a key are kept). In place. */
function dedupeByKey<T>(items: T[], key: (t: T) => string | undefined): T[] {
  const seen = new Set<string>();
  let w = 0;
  for (const it of items) {
    const k = key(it);
    if (k !== undefined) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    items[w++] = it;
  }
  items.length = w;
  return items;
}

function rank<T>(items: T[], query: string, text: (t: T) => [string, string], limit: number): T[] {
  return items
    .map((it) => ({ it, s: score(...text(it), query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || text(a.it)[0].localeCompare(text(b.it)[0]))
    .slice(0, limit)
    .map((x) => x.it);
}

/** Libraries whose assets are embedded in the file (get_libraries). */
export function embeddedLibraries(doc: FigDocument) {
  const libs = new Map<string, { components: number; styles: number; variables: number }>();
  for (const n of doc.nodes.values()) {
    if (!n.sourceLibraryKey) continue;
    let l = libs.get(n.sourceLibraryKey);
    if (!l) libs.set(n.sourceLibraryKey, (l = { components: 0, styles: 0, variables: 0 }));
    if (n.type === 'SYMBOL') l.components++;
    else if (n.type === 'VARIABLE') l.variables++;
    else if (n.styleType && n.styleType !== 'NONE') l.styles++;
  }
  return [...libs].map(([libraryKey, c]) => ({
    name: libraryName(libraryKey),
    libraryKey,
    description: `Embedded in this export: ${c.components} components, ${c.styles} styles, ${c.variables} variables. (.fig exports do not store library names.)`,
    source: 'team' as const,
  }));
}
