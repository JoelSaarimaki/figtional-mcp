import { FigArchive, guidToString as g } from '../packages/fig-format/dist/index.js';
const nodes = FigArchive.open(process.argv[2]).decodeCanvas().message.nodeChanges;
const byId = new Map(nodes.map((n) => [g(n.guid), n]));
const short = (v) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `<${x.length}B>` : typeof x === 'bigint' ? String(x) : ['derivedTextData', 'fillGeometry', 'strokeGeometry', 'glyphs'].includes(k) ? '…' : x));
const styles = nodes.filter((n) => n.styleType && n.styleType !== 'NONE');
const byType = {};
for (const s of styles) (byType[s.styleType] ??= []).push(s);
for (const [t, list] of Object.entries(byType)) {
  const s = list.find((x) => !x.sourceLibraryKey) ?? list[0];
  const parent = byId.get(g(s.parentIndex.guid)); const gp = parent && byId.get(g(parent.parentIndex?.guid ?? s.guid));
  console.log(`\n${t}: ${list.length} (${list.filter((x) => x.sourceLibraryKey).length} library) e.g. ${g(s.guid)} type=${s.type} name=${s.name}`);
  console.log('  parent:', parent?.type, parent?.name, '| grandparent:', gp?.type, gp?.name, '| position', JSON.stringify(s.parentIndex.position));
  console.log('  keys:', Object.keys(s).join(','));
  console.log('  data:', short(Object.fromEntries(Object.entries(s).filter(([k]) => !['guid', 'parentIndex'].includes(k)))).slice(0, 900));
}
const refs = {};
for (const n of nodes) for (const k of ['styleIdForFill', 'styleIdForStrokeFill', 'styleIdForText', 'styleIdForEffect', 'styleIdForGrid']) if (n[k]) { const f = `${k}:${Object.keys(n[k]).join('+')}`; refs[f] = (refs[f] ?? 0) + 1; }
console.log('\nrefs', refs);
