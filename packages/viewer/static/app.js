// Figtional viewer client: read-only, Figma-like view of local .fig files.
// Plain ES modules, no build step. All data comes from the local Figtional server.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat())
    if (c !== undefined && c !== null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
};

async function api(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`/api/${path}${q ? '?' + q : ''}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const state = {
  files: [],
  file: null, // key
  info: null, // /api/file
  page: null, // /api/page
  version: '',
  zoom: 1,
  panX: 0,
  panY: 0,
  selected: null, // /api/node result
  showProto: false,
  proto: null,
};

const canvas = $('canvas');
const world = $('world');
const status = (msg) => ($('status').textContent = msg || '');

// ---------------------------------------------------------------- URL state
function readUrl() {
  const p = new URLSearchParams(location.search);
  return {
    file: p.get('file'),
    page: p.get('page'),
    node: p.get('node-id'),
    proto: p.get('proto') === '1',
    present: p.get('present') === '1',
  };
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.file) p.set('file', state.file);
  if (state.page) p.set('page', state.page.id);
  if (state.selected) p.set('node-id', state.selected.id.replace(/:/g, '-'));
  if (state.showProto) p.set('proto', '1');
  history.replaceState(null, '', `?${p}`);
}

// ---------------------------------------------------------------- loading
async function init() {
  state.files = await api('files');
  const fs = $('file-select');
  fs.replaceChildren(...state.files.map((f) => el('option', { value: f.key }, f.name)));
  fs.hidden = state.files.length < 2;
  if (!state.files.length) {
    status('No .fig files in this session.');
    return;
  }
  const u = readUrl();
  const key = state.files.some((f) => f.key === u.file) ? u.file : state.files[0].key;
  if (u.proto) {
    state.showProto = true;
    $('proto-toggle').checked = true;
  }
  await openFile(key, u.page, u.node);
  if (u.present) await openPresent();
  setInterval(checkVersion, 2000);
}

async function openFile(key, pageId, nodeId) {
  state.file = key;
  $('file-select').value = key;
  state.info = await api('file', { file: key });
  state.version = state.info.version;
  document.title = `${state.info.name} · Figtional`;
  const ps = $('page-select');
  ps.replaceChildren(
    ...state.info.pages.map((p) =>
      el('option', { value: p.id, disabled: p.divider || undefined }, p.divider ? '────────' : p.name),
    ),
  );
  renderFileInfo();
  const page =
    state.info.pages.find((p) => p.id === pageId && !p.divider) ?? state.info.pages.find((p) => !p.divider);
  await openPage(page.id, nodeId);
}

async function openPage(pageId, nodeId) {
  status('Loading page…');
  state.page = await api('page', { file: state.file, page: pageId });
  $('page-select').value = pageId;
  state.selected = null;
  state.proto = null;
  buildWorld();
  await buildLayers();
  zoomToFit(state.page.items.map((i) => i.bounds));
  if (state.showProto) await loadProto();
  $('present-btn').hidden = !(state.page.flows.length || state.page.items.length);
  status('');
  if (nodeId) await select(nodeId.replace(/-/g, ':'), { reveal: true });
  else renderInspect();
  writeUrl();
}

async function checkVersion() {
  if (!state.file || document.hidden) return;
  try {
    const { version } = await api('version', { file: state.file });
    if (version !== state.version) {
      status('File changed on disk, reloading…');
      const sel = state.selected?.id;
      await openFile(state.file, state.page?.id, sel);
    }
  } catch {
    /* file may be mid-write; try again later */
  }
}

// ---------------------------------------------------------------- canvas
let items = []; // { data, item, img, label, loadedScale }

function buildWorld() {
  world.replaceChildren();
  canvas.style.background = state.page.background;
  items = state.page.items.map((data) => {
    const b = data.bounds;
    const img = el('img', { alt: '', draggable: 'false', decoding: 'async' });
    const item = el(
      'div',
      { class: 'item', style: { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` } },
      img,
    );
    const label = data.labelled ? el('div', { class: 'label' }, data.name) : null;
    world.append(item);
    if (label) world.append(label);
    return { data, item, img, label, loadedScale: 0 };
  });
  world.append(el('div', { id: 'sel', class: 'sel', hidden: true }, el('div', { class: 'dims' })));
}

function applyTransform() {
  world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  $('zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
  for (const it of items) {
    if (!it.label) continue;
    const f = it.data.frame;
    it.label.style.left = `${f.x}px`;
    it.label.style.top = `${f.y - 18 / state.zoom}px`;
    it.label.style.transform = `scale(${1 / state.zoom})`;
  }
  updateSelectionBox();
  scheduleImages();
  if (state.showProto) scheduleProto();
}

let protoTimer = 0;
function scheduleProto() {
  clearTimeout(protoTimer);
  protoTimer = setTimeout(drawProto, 100);
}

let imgTimer = 0;
function scheduleImages() {
  clearTimeout(imgTimer);
  imgTimer = setTimeout(loadVisibleImages, 120);
}

function loadVisibleImages() {
  const r = canvas.getBoundingClientRect();
  const view = {
    x0: -state.panX / state.zoom,
    y0: -state.panY / state.zoom,
    x1: (r.width - state.panX) / state.zoom,
    y1: (r.height - state.panY) / state.zoom,
  };
  const margin = 200 / state.zoom;
  const want = Math.pow(2, Math.ceil(Math.log2(Math.max(0.03, state.zoom * devicePixelRatio))));
  for (const it of items) {
    const b = it.data.bounds;
    const visible =
      b.x < view.x1 + margin &&
      b.x + b.w > view.x0 - margin &&
      b.y < view.y1 + margin &&
      b.y + b.h > view.y0 - margin;
    if (!visible) continue;
    const scale = Math.min(want, 4, 8192 / Math.max(b.w, b.h, 1));
    if (Math.abs(scale - it.loadedScale) < 1e-6 && it.img.dataset.v === state.version) continue;
    it.loadedScale = scale;
    it.img.dataset.v = state.version;
    it.img.src = `/api/render?${new URLSearchParams({ file: state.file, node: it.data.id, scale: String(scale), v: state.version })}`;
  }
}

function zoomToFit(rects, padding = 40) {
  if (!rects.length) return;
  const x0 = Math.min(...rects.map((b) => b.x));
  const y0 = Math.min(...rects.map((b) => b.y));
  const x1 = Math.max(...rects.map((b) => b.x + b.w));
  const y1 = Math.max(...rects.map((b) => b.y + b.h));
  const r = canvas.getBoundingClientRect();
  const z = Math.min(
    (r.width - padding * 2) / Math.max(1, x1 - x0),
    (r.height - padding * 2) / Math.max(1, y1 - y0),
    4,
  );
  state.zoom = Math.max(0.01, z);
  state.panX = (r.width - (x1 - x0) * state.zoom) / 2 - x0 * state.zoom;
  state.panY = (r.height - (y1 - y0) * state.zoom) / 2 - y0 * state.zoom;
  applyTransform();
}

function zoomAt(factor, cx, cy) {
  const z = Math.min(256, Math.max(0.01, state.zoom * factor));
  const wx = (cx - state.panX) / state.zoom;
  const wy = (cy - state.panY) / state.zoom;
  state.zoom = z;
  state.panX = cx - wx * z;
  state.panY = cy - wy * z;
  applyTransform();
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else {
      state.panX -= e.shiftKey ? e.deltaY : e.deltaX;
      state.panY -= e.shiftKey ? 0 : e.deltaY;
      applyTransform();
    }
  },
  { passive: false },
);

let drag = null;

/** Ends a drag however the pointer went away (release, cancel, lost capture, window blur). */
function endDrag() {
  if (drag && canvas.hasPointerCapture?.(drag.pointerId)) {
    try {
      canvas.releasePointerCapture(drag.pointerId);
    } catch {
      /* already released */
    }
  }
  drag = null;
  canvas.classList.remove('panning');
}

canvas.addEventListener('pointerdown', (e) => {
  // Left or middle button only; no native text selection, image drag or browser hover tools.
  if (e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  canvas.focus({ preventScroll: true });
  endDrag();
  drag = {
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    panX: state.panX,
    panY: state.panY,
    moved: false,
  };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', () => {
  // A click (no movement) still needs its pointerup; only clear moved drags here.
  if (drag?.moved) endDrag();
});
window.addEventListener('blur', endDrag);
canvas.addEventListener('dragstart', (e) => e.preventDefault());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  // A release we never saw (e.g. outside the window): no buttons are held any more.
  if (e.buttons === 0) {
    endDrag();
    return;
  }
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  canvas.classList.add('panning');
  state.panX = drag.panX + dx;
  state.panY = drag.panY + dy;
  applyTransform();
});
canvas.addEventListener('pointerup', async (e) => {
  const d = drag;
  endDrag();
  if (!d || d.moved || e.button !== 0) return;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left - state.panX) / state.zoom;
  const y = (e.clientY - r.top - state.panY) / state.zoom;
  const hit = await api('hit', {
    file: state.file,
    page: state.page.id,
    x,
    y,
    deep: e.ctrlKey || e.metaKey ? '1' : '0',
  });
  if (hit.id) await select(hit.id, { reveal: true });
  else clearSelection();
});

canvas.addEventListener('keydown', (e) => {
  const r = canvas.getBoundingClientRect();
  if (e.key === '+' || e.key === '=') zoomAt(1.25, r.width / 2, r.height / 2);
  else if (e.key === '-') zoomAt(0.8, r.width / 2, r.height / 2);
  else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1'))
    zoomToFit(state.page.items.map((i) => i.bounds));
  else if (e.key === '@' || (e.shiftKey && e.code === 'Digit2')) {
    if (state.selected) zoomToFit([state.selected.bounds], 80);
  } else if (e.key === 'Escape') clearSelection();
  else return;
  e.preventDefault();
});
window.addEventListener('resize', () => applyTransform());

$('zoom-in').onclick = () => {
  const r = canvas.getBoundingClientRect();
  zoomAt(1.25, r.width / 2, r.height / 2);
};
$('zoom-out').onclick = () => {
  const r = canvas.getBoundingClientRect();
  zoomAt(0.8, r.width / 2, r.height / 2);
};
$('zoom-label').onclick = () => zoomToFit(state.page.items.map((i) => i.bounds));
$('file-select').onchange = (e) => openFile(e.target.value);
$('page-select').onchange = (e) => openPage(e.target.value);

// ---------------------------------------------------------------- selection
async function select(id, { reveal = false } = {}) {
  try {
    state.selected = await api('node', { file: state.file, node: id });
  } catch (err) {
    status(String(err.message || err));
    return;
  }
  if (reveal) await revealInLayers(state.selected);
  markSelectedRow();
  updateSelectionBox();
  for (const it of items) it.label?.classList.toggle('selected', it.data.id === state.selected.id);
  renderInspect();
  writeUrl();
}

function clearSelection() {
  state.selected = null;
  markSelectedRow();
  updateSelectionBox();
  renderInspect();
  writeUrl();
}

function updateSelectionBox() {
  const box = $('sel');
  if (!box) return;
  const s = state.selected;
  if (!s || !state.page || s.page !== state.page.name) {
    box.hidden = true;
    return;
  }
  const b = s.bounds;
  box.hidden = false;
  Object.assign(box.style, {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
    borderWidth: `${1 / state.zoom}px`,
  });
  const dims = box.firstChild;
  dims.textContent = `${round(s.width)} × ${round(s.height)}`;
  dims.style.transform = `translate(-50%, ${4 / state.zoom}px) scale(${1 / state.zoom})`;
}

const round = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- layers panel
const ICONS = {
  FRAME: '#',
  GROUP: '▢',
  SECTION: '§',
  COMPONENT: '❖',
  COMPONENT_SET: '❖',
  INSTANCE: '◇',
  TEXT: 'T',
  RECTANGLE: '□',
  ELLIPSE: '○',
  LINE: '／',
  VECTOR: '✎',
  BOOLEAN_OPERATION: '◑',
  REGULAR_POLYGON: '△',
  STAR: '☆',
  BRUSH: '✎',
};
const rowsById = new Map();

async function buildLayers() {
  rowsById.clear();
  const root = $('layers');
  root.replaceChildren();
  const kids = await api('children', { file: state.file, node: state.page.id });
  root.append(...kids.map((k) => layerRow(k, 0)));
}

function layerRow(n, depth) {
  const isComp = ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(n.type);
  const caret = el('span', { class: 'caret' }, n.hasChildren ? '▶' : '');
  const row = el(
    'div',
    {
      class: `row${n.visible ? '' : ' hidden-node'}${isComp ? ' component' : ''}`,
      role: 'treeitem',
      style: { paddingLeft: `${4 + depth * 12}px` },
    },
    caret,
    el('span', { class: 'icon' }, ICONS[n.type] ?? '•'),
    el('span', { class: 'name', title: `${n.name} (${n.type}, ${n.id})` }, n.name || ' '),
  );
  const wrap = el('div', {}, row);
  const kids = el('div', { hidden: true });
  wrap.append(kids);
  const entry = { n, row, kids, depth, loaded: false, caret };
  rowsById.set(n.id, entry);
  caret.onclick = (e) => {
    e.stopPropagation();
    toggle(entry);
  };
  row.onclick = () => select(n.id);
  row.ondblclick = () => {
    select(n.id).then(() => state.selected && zoomToFit([state.selected.bounds], 80));
  };
  return wrap;
}

async function toggle(entry, open) {
  const want = open ?? entry.kids.hidden;
  if (want && !entry.loaded) {
    entry.loaded = true;
    const kids = await api('children', { file: state.file, node: entry.n.id });
    entry.kids.append(...kids.map((k) => layerRow(k, entry.depth + 1)));
  }
  entry.kids.hidden = !want;
  if (entry.n.hasChildren) entry.caret.textContent = want ? '▼' : '▶';
}

async function revealInLayers(node) {
  for (const id of node.path) {
    const entry = rowsById.get(id);
    if (entry) await toggle(entry, true);
  }
}

function markSelectedRow() {
  for (const { row } of rowsById.values()) row.classList.remove('selected');
  const entry = state.selected && rowsById.get(state.selected.id);
  if (entry) {
    entry.row.classList.add('selected');
    entry.row.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------- inspect panel
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('inspect').hidden = b.dataset.tab !== 'design';
    $('fileinfo').hidden = b.dataset.tab !== 'file';
  };
});

const section = (title, ...rows) => {
  const content = rows.flat().filter(Boolean);
  return content.length ? el('div', { class: 'section' }, el('h3', {}, title), ...content) : null;
};
const kv = (pairs) => {
  const items = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
  return items.length
    ? el(
        'div',
        { class: 'kv' },
        ...items.flatMap(([k, v]) => [el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)]),
      )
    : null;
};
const paintRow = (p) =>
  el(
    'div',
    { style: { opacity: p.visible ? 1 : 0.45, margin: '2px 0' } },
    p.type === 'SOLID'
      ? el('span', { class: 'swatch', style: { background: p.value } })
      : el('span', { class: 'tag' }, p.type.replace('GRADIENT_', '').toLowerCase()),
    p.type === 'SOLID' ? p.value : p.type === 'IMAGE' ? `image · ${p.scaleMode}` : p.value,
    p.opacity !== undefined ? el('span', { class: 'tag' }, `${Math.round(p.opacity * 100)}%`) : null,
    p.variable ? el('div', { class: 'var' }, `◆ ${p.variable}`) : null,
  );

function renderInspect() {
  const box = $('inspect');
  const s = state.selected;
  if (!s) {
    box.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        'Select a layer on the canvas or in the layers panel. Ctrl/Cmd-click selects the deepest layer; double-click a layer row to zoom to it.',
      ),
    );
    return;
  }
  const parts = [
    el(
      'div',
      { class: 'section' },
      el(
        'div',
        { class: 'title-row' },
        el('span', {}, ICONS[s.type] ?? '•'),
        s.name,
        el('span', { class: 'id' }, s.id),
      ),
      el(
        'div',
        { class: 'k', style: { color: 'var(--muted)', marginTop: '2px' } },
        s.type + (s.visible ? '' : ' · hidden'),
      ),
    ),
    section(
      'Position & size',
      kv([
        ['X', round(s.x)],
        ['Y', round(s.y)],
        ['W', round(s.width)],
        ['H', round(s.height)],
        ['Rotation', s.rotation ? `${s.rotation}°` : ''],
        ['Absolute', `${round(s.absoluteX)}, ${round(s.absoluteY)}`],
      ]),
    ),
    s.layout
      ? section(
          'Auto layout',
          kv(Object.entries(s.layout).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])),
        )
      : null,
    s.layoutChild
      ? section(
          'Layout (in parent)',
          kv(
            Object.entries(s.layoutChild).map(([k, v]) => [
              k,
              typeof v === 'object' ? JSON.stringify(v) : String(v),
            ]),
          ),
        )
      : null,
    section(
      'Appearance',
      kv([
        ['Opacity', s.opacity !== undefined ? `${Math.round(s.opacity * 100)}%` : ''],
        ['Corner radius', Array.isArray(s.cornerRadius) ? s.cornerRadius.join(', ') : s.cornerRadius],
        ['Blend', s.blendMode],
        ['Clip content', s.clipsContent === undefined ? '' : String(s.clipsContent)],
      ]),
    ),
    s.text
      ? section(
          'Text',
          kv(
            Object.entries(s.text)
              .filter(([k]) => k !== 'characters')
              .map(([k, v]) => [k, v === undefined ? '' : String(v)]),
          ),
          el('div', { class: 'v', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, s.text.characters),
        )
      : null,
    section('Fill', s.fills.map(paintRow)),
    section(
      'Stroke',
      s.strokes.map(paintRow),
      s.strokes.length
        ? kv([
            ['Weight', s.strokeWeight],
            ['Align', s.strokeAlign],
          ])
        : null,
    ),
    section(
      'Effects',
      s.effects.map((e) => el('div', {}, e)),
    ),
    s.component ? section('Component', renderComponent(s.component)) : null,
    section('Styles', kv(Object.entries(s.styles))),
    section('Variables', kv(Object.entries(s.boundVariables))),
    s.prototype
      ? section(
          'Prototype',
          s.prototype.map((p) =>
            el(
              'div',
              {},
              `${p.trigger} → ${p.action}${p.destination ? ` "${p.destination}"` : ''}${p.transition ? ` (${p.transition})` : ''}`,
            ),
          ),
        )
      : null,
  ];
  box.replaceChildren(...parts.filter(Boolean));
}

function renderComponent(c) {
  const rows = [];
  if (c.mainComponent) rows.push(['Main component', c.mainComponent.name]);
  if (c.componentSet) rows.push(['Component set', c.componentSet.name]);
  if (c.missing) rows.push(['Main component', 'missing (shown as placeholder)']);
  if (c.fromLibrary) rows.push(['Source', 'library']);
  if (c.key) rows.push(['Key', c.key]);
  if (c.description) rows.push(['Description', c.description]);
  const props = c.properties
    ? Array.isArray(c.properties)
      ? c.properties.map((p) => [p.name, p.type])
      : Object.entries(c.properties).map(([k, v]) => [k, String(v)])
    : [];
  return [kv(rows), props.length ? el('div', { style: { marginTop: '6px' } }, kv(props)) : null];
}

function renderFileInfo() {
  const i = state.info;
  const counts = Object.entries(i.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  const parts = [
    section(
      'File',
      kv([
        ['Name', i.name],
        ['Key', i.key],
        ['Exported', i.meta.exported_at ?? '?'],
        ['Format', `${i.format.magic} v${i.format.version}`],
        ['Schema', `${i.format.schemaDefinitions} definitions`],
        ['Images', i.images],
      ]),
    ),
    section(
      'Pages',
      i.pages.filter((p) => !p.divider).map((p) => el('div', {}, p.name)),
    ),
    section('Nodes', el('div', { class: 'v' }, counts)),
    ...i.collections.map((c) =>
      section(
        `Variables: ${c.name}`,
        el(
          'table',
          { class: 'vars' },
          el('tr', {}, el('th', {}, 'Name'), ...c.modes.map((m) => el('th', {}, m))),
          ...c.variables
            .slice(0, 300)
            .map((v) =>
              el(
                'tr',
                {},
                el('td', {}, v.name),
                ...c.modes.map((m) =>
                  el(
                    'td',
                    {},
                    v.type === 'COLOR' && v.values[m]?.startsWith('#')
                      ? [el('span', { class: 'swatch', style: { background: v.values[m] } }), v.values[m]]
                      : v.values[m],
                  ),
                ),
              ),
            ),
        ),
      ),
    ),
    section(
      'Styles',
      i.styles
        .slice(0, 400)
        .map((s) =>
          el(
            'div',
            {},
            s.type === 'FILL' && s.value.startsWith('#')
              ? el('span', { class: 'swatch', style: { background: s.value } })
              : el('span', { class: 'tag' }, s.type),
            ` ${s.name}`,
          ),
        ),
    ),
  ];
  $('fileinfo').replaceChildren(...parts.filter(Boolean));
}

// ---------------------------------------------------------------- prototype connections
$('proto-toggle').onchange = async (e) => {
  state.showProto = e.target.checked;
  if (state.showProto) await loadProto();
  drawProto();
};

async function loadProto() {
  state.proto = await api('prototype', { file: state.file, page: state.page.id });
  drawProto();
}

function drawProto() {
  world.querySelector('.proto-layer')?.remove();
  if (!state.showProto || !state.proto) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'proto-layer');
  svg.setAttribute('width', '1');
  svg.setAttribute('height', '1');
  const frames = new Map(state.page.items.map((i) => [i.id, i.frame]));
  const sw = 2 / state.zoom;
  for (const l of state.proto.links) {
    const to = l.destinationId && frames.get(l.destinationId);
    const from = l.box;
    const path = document.createElementNS(NS, 'path');
    const sx = from.x + from.w;
    const sy = from.y + from.h / 2;
    let d;
    if (to) {
      const tx = to.x;
      const ty = to.y + Math.min(40, to.h / 2);
      const mx = (sx + tx) / 2;
      d = `M${sx} ${sy} C${mx} ${sy} ${mx} ${ty} ${tx} ${ty}`;
    } else d = `M${sx} ${sy} h${30}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#0d99ff');
    path.setAttribute('stroke-width', String(sw));
    svg.append(path);
    const dot = document.createElementNS(NS, 'rect');
    dot.setAttribute('x', String(from.x));
    dot.setAttribute('y', String(from.y));
    dot.setAttribute('width', String(from.w));
    dot.setAttribute('height', String(from.h));
    dot.setAttribute('fill', 'rgba(13,153,255,0.08)');
    dot.setAttribute('stroke', '#0d99ff');
    dot.setAttribute('stroke-width', String(sw / 2));
    svg.append(dot);
  }
  world.append(svg);
}

// ---------------------------------------------------------------- present mode
const present = { history: [], overlays: [], flows: [], frameCache: new Map() };

$('present-btn').onclick = () => openPresent();
$('present-close').onclick = () => closePresent();
$('present-back').onclick = () => presentBack();
$('present-restart').onclick = () => startFlow($('flow-select').value);
$('hotspot-toggle').onchange = (e) => $('present').classList.toggle('show-hotspots', e.target.checked);
$('flow-select').onchange = (e) => startFlow(e.target.value);
document.addEventListener('keydown', (e) => {
  if ($('present').hidden) return;
  if (e.key === 'Escape') closePresent();
  else if (e.key === 'Backspace') presentBack();
  else if (e.key === 'r' || e.key === 'R') startFlow($('flow-select').value);
});

async function openPresent() {
  const proto =
    state.proto ?? (state.proto = await api('prototype', { file: state.file, page: state.page.id }));
  present.flows = proto.flows.length
    ? proto.flows
    : state.page.items.filter((i) => i.type === 'FRAME').map((i) => ({ name: i.name, startNodeId: i.id }));
  if (!present.flows.length) return;
  $('flow-select').replaceChildren(
    ...present.flows.map((f) => el('option', { value: f.startNodeId }, f.name)),
  );
  $('present').hidden = false;
  const start =
    state.selected && present.flows.some((f) => f.startNodeId === state.selected.id)
      ? state.selected.id
      : present.flows[0].startNodeId;
  $('flow-select').value = start;
  await startFlow(start);
}

function closePresent() {
  $('present').hidden = true;
  $('present-stage').replaceChildren();
}

async function frameInfo(id) {
  if (!present.frameCache.has(id))
    present.frameCache.set(id, await api('frame', { file: state.file, node: id }));
  return present.frameCache.get(id);
}

async function startFlow(id) {
  present.history = [];
  present.overlays = [];
  await showScreen(id);
}

async function presentBack() {
  if (present.overlays.length) {
    present.overlays.pop();
    await drawPresent();
  } else if (present.history.length > 1) {
    present.history.pop();
    await drawPresent();
  }
}

async function showScreen(id) {
  present.history.push(id);
  present.overlays = [];
  await drawPresent();
}

function screenEl(f, { scale, scroll }) {
  const img = el('img', {
    src: `/api/render?${new URLSearchParams({ file: state.file, node: f.id, scale: String(Math.min(4, devicePixelRatio * scale)), v: state.version })}`,
    style: {
      width: `${f.render.w * scale}px`,
      height: `${f.render.h * scale}px`,
      marginLeft: `${(f.render.x - f.frame.x) * scale}px`,
      marginTop: `${(f.render.y - f.frame.y) * scale}px`,
    },
    draggable: 'false',
  });
  const content = el('div', { class: 'content' }, img);
  for (const h of f.hotspots) {
    if (h.trigger !== 'ON_CLICK' && h.trigger !== 'ON_PRESS') continue;
    content.append(
      el('div', {
        class: 'hotspot',
        title: `${h.action}${h.transition ? ` (${h.transition})` : ''}`,
        style: {
          left: `${h.x * scale}px`,
          top: `${h.y * scale}px`,
          width: `${h.w * scale}px`,
          height: `${h.h * scale}px`,
        },
        onclick: (e) => {
          e.stopPropagation();
          runAction(h);
        },
      }),
    );
  }
  const vw = scroll ? Math.min(f.width, f.viewW ?? f.width) : f.width;
  const vh = scroll ? Math.min(f.height, f.viewH ?? f.height) : f.height;
  return el(
    'div',
    {
      class: 'screen',
      style: { width: `${vw * scale}px`, height: `${vh * scale}px`, overflow: scroll ? 'auto' : 'hidden' },
    },
    content,
  );
}

async function drawPresent() {
  const stage = $('present-stage');
  const id = present.history[present.history.length - 1];
  const f = await frameInfo(id);
  const device = state.proto?.device;
  const viewW = device?.width ?? f.width;
  const viewH = device?.height ?? Math.min(f.height, stage.clientHeight - 40);
  const scale = Math.min(1, (stage.clientWidth - 40) / viewW, (stage.clientHeight - 40) / viewH);
  const scr = screenEl({ ...f, viewW, viewH }, { scale, scroll: true });
  $('present-title').textContent = f.name;
  const layers = [scr];
  const wrap = el('div', { style: { position: 'relative' } }, ...layers);
  for (const oid of present.overlays) {
    const o = await frameInfo(oid);
    wrap.append(el('div', { class: 'overlay-backdrop', onclick: () => presentBack() }));
    const ov = screenEl(o, { scale, scroll: false });
    ov.classList.add('overlay');
    const W = viewW * scale;
    const H = viewH * scale;
    const w = o.width * scale;
    const h = o.height * scale;
    const pos = o.overlayPosition;
    const left = pos.endsWith('LEFT') ? 0 : pos.endsWith('RIGHT') ? W - w : (W - w) / 2;
    const top = pos.startsWith('TOP') ? 0 : pos.startsWith('BOTTOM') ? H - h : (H - h) / 2;
    Object.assign(ov.style, { left: `${left}px`, top: `${top}px` });
    wrap.append(ov);
  }
  stage.replaceChildren(wrap);
}

async function runAction(h) {
  switch (h.action) {
    case 'NAVIGATE':
      if (h.destinationId) await showScreen(h.destinationId);
      break;
    case 'OPEN_OVERLAY':
    case 'SWAP_OVERLAY':
      if (h.action === 'SWAP_OVERLAY') present.overlays.pop();
      if (h.destinationId) {
        present.overlays.push(h.destinationId);
        await drawPresent();
      }
      break;
    case 'CLOSE':
      present.overlays.pop();
      await drawPresent();
      break;
    case 'BACK':
      await presentBack();
      break;
    default:
      status(`${h.action} is not supported in the viewer`);
  }
}

init().catch((e) => status(`Error: ${e.message}`));
