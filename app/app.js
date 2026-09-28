'use strict';
// Offline-first bridge register for tablets.
// All data lives in IndexedDB on the device; "Sync" pushes local edits to the
// server and pulls everyone else's changes. Works with no connection after the
// first sign-in.

// ------------------------------------------------------------------ fields
// Order and sections follow the "List of Bridges" Excel template.
const FIELDS = [
  { k: 'region_code', label: 'Region', type: 'select', src: 'regions', req: true, sec: 'Identification' },
  { k: 'bridge_no', label: 'Bridge No.', type: 'text', req: true, ph: '12-0001' },
  { k: 'bridge_name', label: 'Bridge name', type: 'text', req: true },
  { k: 'latitude', label: 'Latitude', type: 'num', step: '0.000001', ph: '-6.823400', sec: 'Location' },
  { k: 'longitude', label: 'Longitude', type: 'num', step: '0.000001', ph: '37.661200' },
  { k: 'road_no', label: 'Road No. / Road name', type: 'select', src: 'roads', req: true },
  { k: 'link_name', label: 'Link name', type: 'text', list: 'links', ph: 'e.g. Ngerengere - Mikese' },
  { k: 'chainage_km', label: 'Chainage from start of link (km)', type: 'num', step: '0.001' },
  { k: 'structure_type', label: 'Structure type', type: 'select', src: 'structure_types', sec: 'Bridge type' },
  { k: 'material', label: 'Material', type: 'select', src: 'materials' },
  { k: 'span_count', label: 'Number of spans', type: 'int', sec: 'Dimensions' },
  { k: 'length_m', label: 'Bridge length (m)', type: 'num', step: '0.01' },
  { k: 'width_m', label: 'Width (m)', type: 'num', step: '0.01' },
  { k: 'financier', label: 'Financier', type: 'select', src: 'financiers', sec: 'Construction' },
  { k: 'construction_year', label: 'Year of construction', type: 'int', ph: 'e.g. 2004' },
  { k: 'design_life_years', label: 'Design life (years)', type: 'int' },
  { k: 'construction_cost_tsh_mio', label: 'Construction cost (TSh million)', type: 'num', step: '0.001' },
  { k: 'overall_condition', label: 'Overall condition', type: 'select', src: 'conditions', sec: 'Condition & status' },
  { k: 'last_inspected_on', label: 'Date checked', type: 'date' },
  { k: 'record_status', label: 'Record status', type: 'select', src: 'record_statuses', req: true },
  { k: 'remarks', label: 'Remarks', type: 'textarea', wide: true },
];
const KEYS = FIELDS.map(f => f.k);
const LIST_LIMIT = 300;

// --------------------------------------------------------------- IndexedDB
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('bridge-register', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('bridges', { keyPath: 'id' });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  return {
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    all: store => tx(store, 'readonly', s => s.getAll()),
    put: (store, val, key) => tx(store, 'readwrite', s => { key === undefined ? s.put(val) : s.put(val, key); }),
    putMany: (store, vals) => tx(store, 'readwrite', s => { vals.forEach(v => s.put(v)); }),
    del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
    clear: store => tx(store, 'readwrite', s => { s.clear(); }),
  };
})();
const getMeta = k => idb.get('meta', k);
const setMeta = (k, v) => idb.put('meta', v, k);

// ------------------------------------------------------------------- state
const state = {
  session: null,      // { token, user }
  lookups: null,
  bridges: [],
  online: navigator.onLine,
  syncing: false,
  lastSync: null,
  filter: { q: '', road: '', cond: '', only: '' },
};

const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const canEdit = () => ['inspector', 'admin'].includes(state.session?.user.role);
const isAdmin = () => state.session?.user.role === 'admin';
const pending = () => state.bridges.filter(b => b._dirty).length;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

// --------------------------------------------------------------------- API
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.session) headers.Authorization = 'Bearer ' + state.session.token;
  let res;
  try {
    res = await fetch('api/' + path, { ...opts, headers });
  } catch {
    state.online = false;
    throw new Error('No connection to the server');
  }
  if (res.status === 401 && state.session) {
    // Keep local data; just ask the user to sign in again.
    state.session = null;
    await setMeta('session', null);
    renderLogin();
    throw new Error('Session expired - please sign in again');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
  return res;
}
const apiJson = (path, opts) => api(path, opts).then(r => r.json());

async function deviceId() {
  let id = await getMeta('deviceId');
  if (!id) { id = 'tab-' + uuid().slice(0, 8); await setMeta('deviceId', id); }
  return id;
}

// -------------------------------------------------------------------- sync
async function reloadBridges() {
  state.bridges = await idb.all('bridges');
}

async function push() {
  const dirty = (await idb.all('bridges')).filter(b => b._dirty && !b._conflict);
  const device = await deviceId();
  for (let i = 0; i < dirty.length; i += 100) {
    const chunk = dirty.slice(i, i + 100);
    const byId = new Map(chunk.map(b => [b.id, b]));
    const r = await apiJson('sync/push', {
      method: 'POST',
      body: JSON.stringify({
        device,
        changes: chunk.map(b => ({
          id: b.id, base_version: b._base_version || 0, deleted: !!b.is_deleted,
          data: Object.fromEntries(KEYS.map(k => [k, b[k] ?? null])),
        })),
      }),
    });
    for (const a of r.applied) {
      const cur = await idb.get('bridges', a.id);
      if (!cur) continue;
      if (a.purged) { await idb.del('bridges', a.id); continue; }
      // If the user edited the record while it was uploading, keep it pending.
      const unchanged = cur._rev === byId.get(a.id)._rev;
      await idb.put('bridges', { ...cur, version: a.version, server_seq: a.server_seq, _base_version: a.version, _dirty: unchanged ? 0 : 1, _error: null });
    }
    for (const c of r.conflicts) {
      const cur = await idb.get('bridges', c.id);
      if (cur) await idb.put('bridges', { ...cur, _conflict: c.server, _error: null });
    }
    for (const x of r.rejected) {
      if (!x.id) continue;
      const cur = await idb.get('bridges', x.id);
      if (cur) await idb.put('bridges', { ...cur, _error: x.error });
    }
  }
  return dirty.length;
}

async function pull() {
  let cursor = (await getMeta('cursor')) || 0;
  let more = true, count = 0;
  while (more) {
    const r = await apiJson('sync/pull?since=' + cursor);
    const puts = [];
    for (const s of r.bridges) {
      const local = await idb.get('bridges', s.id);
      if (local && local._dirty) {
        // Changed on the server while we have unsynced edits -> conflict.
        if (s.version > (local._base_version || 0)) puts.push({ ...local, _conflict: s });
      } else {
        puts.push({ ...s, _base_version: s.version, _dirty: 0 });
      }
    }
    await idb.putMany('bridges', puts);
    cursor = r.cursor;
    await setMeta('cursor', cursor);
    more = r.more;
    count += r.bridges.length;
  }
  return count;
}

async function sync({ quiet = false } = {}) {
  if (state.syncing || !state.session) return;
  state.syncing = true;
  renderStatus();
  try {
    await apiJson('ping');
    state.online = true;
    state.lookups = await apiJson('lookups');
    await setMeta('lookups', state.lookups);
    const sent = await push();
    const received = await pull();
    state.lastSync = new Date().toISOString();
    await setMeta('lastSync', state.lastSync);
    await reloadBridges();
    const problems = state.bridges.filter(b => b._conflict || b._error).length;
    if (problems) toast(`Synced, but ${problems} record(s) need attention`, true);
    else if (!quiet || sent || received) toast(`Sync complete - sent ${sent}, received ${received}`);
  } catch (e) {
    if (!quiet) toast(e.message, true);
  } finally {
    state.syncing = false;
    await reloadBridges();
    renderStatus();
    if (currentView === 'list') renderList();
  }
}

// ------------------------------------------------------------------ status
function renderStatus() {
  const el = $('#status');
  document.body.classList.toggle('login-mode', currentView === 'login');
  if (!state.session) { el.innerHTML = ''; return; }
  const n = pending();
  const last = state.lastSync ? new Date(state.lastSync).toLocaleString() : 'never';
  el.innerHTML = `
    <span class="pill ${state.online ? 'on' : 'off'}">${state.online ? 'Online' : 'Offline'}</span>
    <span class="pill" title="Last sync: ${esc(last)}">${n} pending</span>
    <button id="btnSync" ${state.syncing ? 'disabled' : ''}>${state.syncing ? 'Syncing…' : 'Sync now'}</button>
    <button id="btnUser" title="Sign out">${esc(state.session.user.full_name)} ▾</button>`;
  $('#btnSync').onclick = () => sync();
  $('#btnUser').onclick = logout;
}

// ------------------------------------------------------------------- login
let currentView = 'login';

function renderLogin() {
  currentView = 'login';
  renderStatus();
  $('#main').innerHTML = `
    <div class="login-wrap">
      <aside class="login-hero">
        <span class="logo-badge"><img src="tanroads-logo.jpg" alt="TANROADS logo"></span>
        <div>
          <div class="eyebrow">Tanzania National Roads Agency</div>
          <h1>Bridge Register</h1>
          <p>Register, inspect and verify bridges and culverts on trunk and regional roads, even without mobile signal.</p>
        </div>
        <p class="motto">Good roads for national development</p>
        <svg viewBox="0 0 512 512" aria-hidden="true"><path d="M64 300h384v28H64z" fill="#fff"/><path d="M96 300c40-90 120-130 160-130s120 40 160 130" fill="none" stroke="#fff" stroke-width="22"/><path d="M136 300v80M216 300v80M296 300v80M376 300v80" stroke="#fff" stroke-width="20"/></svg>
      </aside>
      <div class="login-side">
        <form class="login-card" id="loginForm">
          <h2>Sign in</h2>
          <p class="muted" style="margin:0 0 22px">Use the account issued by your system administrator. The first sign-in needs a connection; after that the app works offline.</p>
          <label class="fld"><span>Username</span><input name="username" autocomplete="username" required></label>
          <label class="fld"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary">Sign in</button>
        </form>
      </div>
    </div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await apiJson('login', {
        method: 'POST',
        body: JSON.stringify({ username: f.username.value, password: f.password.value, device: await deviceId() }),
      });
      // A different user on this tablet: drop the previous user's synced copy.
      const last = await getMeta('lastUserId');
      if (last && last !== r.user.id && !(await idb.all('bridges')).some(b => b._dirty)) {
        await idb.clear('bridges');
        await setMeta('cursor', 0);
      }
      state.session = r;
      await setMeta('session', r);
      await setMeta('lastUserId', r.user.id);
      f.querySelector('button').disabled = true;
      f.querySelector('button').textContent = 'Downloading bridges…';
      await sync({ quiet: true });
      location.replace('./'); // home page first; "Open the register" leads to the list
    } catch (err) {
      toast(err.message, true);
    }
  };
}

async function logout() {
  const n = pending();
  const msg = n
    ? `${n} change(s) have not been synced. They stay on this tablet, but sign out anyway?`
    : 'Sign out of the bridge register?';
  if (!confirm(msg)) return;
  if (state.online) api('logout', { method: 'POST' }).catch(() => {});
  state.session = null;
  await setMeta('session', null);
  renderLogin();
}

// -------------------------------------------------------------------- list
function roadName(no) {
  return state.lookups?.roads.find(r => r.road_no === no)?.road_name || '';
}

function statusBadges(b) {
  const out = [];
  if (b._conflict) out.push('<span class="badge b-bad">Conflict</span>');
  if (b._error) out.push('<span class="badge b-bad">Rejected</span>');
  if (b._dirty && !b._conflict && !b._error) out.push('<span class="badge b-warn">Not synced</span>');
  if (b.record_status && b.record_status !== 'Active') out.push(`<span class="badge b-info">${esc(b.record_status)}</span>`);
  if (b.verified_at && !b._dirty) out.push('<span class="badge b-ok">Verified</span>');
  return out.join('');
}

function filteredBridges() {
  const { q, road, cond, only } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.bridges
    .filter(b => !b.is_deleted)
    .filter(b => !needle || [b.bridge_no, b.bridge_name, b.link_name].some(v => (v || '').toLowerCase().includes(needle)))
    .filter(b => !road || b.road_no === road)
    .filter(b => !cond || b.overall_condition === cond)
    .filter(b => !only
      || (only === 'pending' && b._dirty)
      || (only === 'problems' && (b._conflict || b._error))
      || (only === 'unverified' && !b.verified_at)
      || (only === 'nogps' && (b.latitude == null || b.longitude == null)))
    .sort((a, b) => (a.road_no || '').localeCompare(b.road_no || '')
      || (a.link_name || '').localeCompare(b.link_name || '')
      || (a.chainage_km ?? 0) - (b.chainage_km ?? 0));
}

function renderList() {
  currentView = 'list';
  renderStatus();
  const L = state.lookups || {};
  const f = state.filter;
  const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  $('#main').innerHTML = `
    <div class="toolbar">
      <input class="grow" id="q" type="search" placeholder="Search bridge no., name or link" value="${esc(f.q)}">
      <select id="fRoad"><option value="">All roads</option>${(L.roads || []).map(r => opt(r.road_no, `${r.road_no} ${r.road_name}`, f.road)).join('')}</select>
      <select id="fCond"><option value="">Any condition</option>${(L.conditions || []).map(c => opt(c, c, f.cond)).join('')}</select>
      <select id="fOnly">
        ${opt('', 'All records', f.only)}${opt('pending', 'Not synced', f.only)}${opt('problems', 'Needs attention', f.only)}
        ${opt('unverified', 'Not verified', f.only)}${opt('nogps', 'Missing GPS', f.only)}
      </select>
      ${canEdit() ? '<button class="primary" id="btnNew">+ New bridge</button>' : ''}
      <button id="btnExport" title="Download the bridge list in template column order">Export CSV</button>
      ${isAdmin() ? '<button id="btnAdmin">Admin</button>' : ''}
    </div>
    <div id="rows"></div>`;
  if ($('#btnAdmin')) $('#btnAdmin').onclick = () => renderAdmin('region');
  $('#q').oninput = e => { f.q = e.target.value; renderRows(); };
  $('#fRoad').onchange = e => { f.road = e.target.value; renderRows(); };
  $('#fCond').onchange = e => { f.cond = e.target.value; renderRows(); };
  $('#fOnly').onchange = e => { f.only = e.target.value; renderRows(); };
  if ($('#btnNew')) $('#btnNew').onclick = () => renderForm(null);
  $('#btnExport').onclick = exportCsv;
  renderRows();
}

function renderRows() {
  const list = filteredBridges();
  const shown = list.slice(0, LIST_LIMIT);
  const num = (v, d) => (v == null ? '' : Number(v).toFixed(d));
  $('#rows').innerHTML = !state.bridges.length
    ? `<div class="card muted">No bridges on this tablet yet. Connect to the internet and press <b>Sync now</b>.</div>`
    : `<p class="muted">${list.length} bridge(s)${list.length > LIST_LIMIT ? ` - showing first ${LIST_LIMIT}, refine the search` : ''}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Bridge No.</th><th>Name</th><th>Road</th><th class="hide-sm">Link</th><th class="num">Ch. (km)</th>
          <th class="hide-sm">Structure type</th><th>Condition</th><th>Status</th></tr></thead>
        <tbody>${shown.map(b => `
          <tr data-id="${esc(b.id)}">
            <td><b>${esc(b.bridge_no)}</b></td><td>${esc(b.bridge_name)}</td>
            <td title="${esc(roadName(b.road_no))}">${esc(b.road_no)}</td><td class="hide-sm">${esc(b.link_name)}</td>
            <td class="num">${num(b.chainage_km, 3)}</td><td class="hide-sm">${esc(b.structure_type)}</td>
            <td>${b.overall_condition ? `<span class="cond cond-${esc(b.overall_condition.toLowerCase())}">${esc(b.overall_condition)}</span>` : ''}</td><td>${statusBadges(b)}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;
  $('#rows').querySelectorAll('tr[data-id]').forEach(tr => {
    tr.onclick = () => renderForm(state.bridges.find(b => b.id === tr.dataset.id));
  });
}

async function exportCsv() {
  try {
    const blob = await (await api('export.csv')).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bridge-list-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast('Export needs a connection: ' + e.message, true);
  }
}

// -------------------------------------------------------------------- form
function options(src, current) {
  const L = state.lookups || {};
  let opts;
  if (src === 'regions') {
    const mine = state.session.user.region_code;
    opts = (L.regions || []).filter(r => !mine || r.code === mine).map(r => ({ value: r.code, label: `${r.code} - ${r.name}` }));
  } else if (src === 'roads') {
    opts = (L.roads || []).map(r => ({ value: r.road_no, label: `${r.road_no} - ${r.road_name} (${r.road_class})` }));
  } else {
    const fallback = src === 'record_statuses' ? ['Active', 'New', 'Closed/Demolished', 'Duplicate'] : [];
    opts = (L[src] || fallback).map(v => ({ value: v, label: v }));
  }
  // Keep a value that is no longer in the list, so saving doesn't silently blank it.
  if (current != null && current !== '' && !opts.some(o => o.value === current)) opts.unshift({ value: current, label: current });
  return opts;
}

function fieldHtml(f, rec) {
  const v = rec[f.k] ?? '';
  const attrs = `id="f_${f.k}" name="${f.k}"${f.req ? ' required' : ''}`;
  let input;
  if (f.type === 'select') {
    input = `<select ${attrs}><option value="">-</option>${options(f.src, v).map(o =>
      `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea ${attrs}>${esc(v)}</textarea>`;
  } else {
    const type = f.type === 'num' || f.type === 'int' ? 'number' : f.type === 'date' ? 'date' : 'text';
    const extra = (f.step ? ` step="${f.step}"` : f.type === 'int' ? ' step="1"' : '')
      + (type === 'number' ? ` inputmode="${f.type === 'int' ? 'numeric' : 'decimal'}"` : '')
      + (f.ph ? ` placeholder="${esc(f.ph)}"` : '') + (f.list ? ` list="${f.list}" autocomplete="off"` : '');
    input = `<input ${attrs} type="${type}" value="${esc(v)}"${extra}>`;
  }
  return `<label class="fld${f.wide ? ' wide' : ''}" data-k="${f.k}"><span>${esc(f.label)}${f.req ? ' *' : ''}</span>${input}</label>`;
}

function linkOptions(roadNo) {
  const links = new Set(state.bridges.filter(b => b.road_no === roadNo && b.link_name).map(b => b.link_name));
  return [...links].sort().map(l => `<option value="${esc(l)}">`).join('');
}

function conflictHtml(b) {
  const s = b._conflict;
  const fmt = v => (v == null || v === '' ? '-' : esc(v));
  const diffs = FIELDS.filter(f => String(b[f.k] ?? '') !== String(s[f.k] ?? ''));
  return `<div class="notice bad">
    <b>Conflict:</b> this bridge was changed on the server${s.updated_at ? ' on ' + esc(new Date(s.updated_at).toLocaleString()) : ''}
    while this tablet had unsynced edits. Choose which version to keep.
    ${s.is_deleted ? '<p><b>The server copy has been deleted.</b></p>' : ''}
    <div class="table-wrap"><table><thead><tr><th>Field</th><th>This tablet</th><th>Server</th></tr></thead>
    <tbody>${diffs.map(f => `<tr><td>${esc(f.label)}</td><td>${fmt(b[f.k])}</td><td>${fmt(s[f.k])}</td></tr>`).join('')}</tbody></table></div>
    <button type="button" id="keepMine">Keep my version</button>
    <button type="button" id="useServer">Use server version</button>
  </div>`;
}

function renderForm(existing, prefill = {}) {
  currentView = 'form';
  renderStatus();
  const rec = existing || {
    record_status: 'New', region_code: state.session.user.region_code || '', ...prefill,
  };
  const editable = canEdit();
  let sections = '', open = false;
  for (const f of FIELDS) {
    if (f.sec) {
      if (open) sections += '</div></fieldset>';
      sections += `<fieldset ${editable ? '' : 'disabled'}><legend>${esc(f.sec)}</legend>`;
      if (f.sec === 'Location') {
        sections += `<p class="hint"><button type="button" id="btnGps">📍 Use tablet GPS</button> <span id="gpsInfo">Stand at the bridge centre for best accuracy.</span></p>`;
      }
      sections += '<div class="grid">';
      open = true;
    }
    sections += fieldHtml(f, rec);
  }
  sections += '</div></fieldset>';

  const meta = existing ? `<p class="muted">
      ${existing.version ? `Server version ${existing.version}` : 'Not yet on the server'}
      ${existing.updated_at ? ` · last changed ${esc(new Date(existing.updated_at).toLocaleString())}` : ''}
      ${existing.verified_at ? ` · verified ${esc(new Date(existing.verified_at).toLocaleDateString())}` : ' · not verified'}
    </p>` : '';

  $('#main').innerHTML = `
    <form id="bridgeForm" novalidate>
      <div class="toolbar"><button type="button" id="btnBack">← Back to list</button>
        <h2 style="margin:0 8px">${existing ? esc(existing.bridge_no + ' ' + existing.bridge_name) : 'New bridge'}</h2></div>
      ${meta}
      ${existing?._conflict ? conflictHtml(existing) : ''}
      ${existing?._error ? `<div class="notice bad"><b>Server rejected this record:</b> ${esc(existing._error)}. Correct it and save again.</div>` : ''}
      ${sections}
      <datalist id="links">${linkOptions(rec.road_no)}</datalist>
      <div class="actions">
        ${editable ? `<button class="primary" type="submit">Save</button>` : ''}
        ${editable && !existing ? `<button type="button" id="btnSaveNext">Save & add next on this road</button>` : ''}
        ${existing && isAdmin() && !existing._dirty && !existing.verified_at ? `<button type="button" id="btnVerify">Mark as verified</button>` : ''}
        ${existing && (isAdmin() || !existing.version) && editable ? `<button type="button" class="danger" id="btnDelete">Delete</button>` : ''}
        <button type="button" id="btnCancel">Cancel</button>
      </div>
    </form>`;

  const form = $('#bridgeForm');
  $('#btnBack').onclick = $('#btnCancel').onclick = () => renderList();
  form.road_no.onchange = () => { $('#links').innerHTML = linkOptions(form.road_no.value); };
  if ($('#btnGps')) $('#btnGps').onclick = () => captureGps(form);
  form.onsubmit = e => { e.preventDefault(); saveForm(form, existing, false); };
  if ($('#btnSaveNext')) $('#btnSaveNext').onclick = () => saveForm(form, existing, true);
  if ($('#btnVerify')) $('#btnVerify').onclick = () => verify(existing);
  if ($('#btnDelete')) $('#btnDelete').onclick = () => removeBridge(existing);
  if (existing?._conflict) {
    $('#keepMine').onclick = () => resolveConflict(existing, 'mine');
    $('#useServer').onclick = () => resolveConflict(existing, 'server');
  }
  window.scrollTo(0, 0);
}

function captureGps(form) {
  const info = $('#gpsInfo');
  if (!navigator.geolocation) { info.textContent = 'GPS not available on this device.'; return; }
  info.textContent = 'Getting position…';
  navigator.geolocation.getCurrentPosition(
    p => {
      form.latitude.value = p.coords.latitude.toFixed(6);
      form.longitude.value = p.coords.longitude.toFixed(6);
      info.textContent = `Captured, accuracy ±${Math.round(p.coords.accuracy)} m`;
    },
    err => { info.textContent = 'Could not get position: ' + err.message; },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

function readForm(form) {
  const out = {};
  for (const f of FIELDS) {
    const raw = form.elements[f.k].value.trim();
    out[f.k] = raw === '' ? null
      : f.type === 'num' ? Number(raw)
      : f.type === 'int' ? parseInt(raw, 10)
      : raw;
  }
  return out;
}

function validate(d, existing) {
  const errs = {};
  for (const f of FIELDS) if (f.req && (d[f.k] == null || d[f.k] === '')) errs[f.k] = 'Required';
  if (d.bridge_no && d.bridge_no !== existing?.bridge_no && !/^\d{2}-\d{4}$/.test(d.bridge_no)) {
    errs.bridge_no = 'Use the format RR-NNNN, e.g. 12-0001';
  }
  if (d.bridge_no && d.record_status !== 'Duplicate' && state.bridges.some(b =>
      b.id !== existing?.id && !b.is_deleted && b.record_status !== 'Duplicate' && b.bridge_no === d.bridge_no)) {
    errs.bridge_no = 'This bridge number is already registered';
  }
  if (d.latitude != null && !(d.latitude >= -12.5 && d.latitude <= -0.5)) errs.latitude = 'Must be between -12.5 and -0.5 (Tanzania)';
  if (d.longitude != null && !(d.longitude >= 29 && d.longitude <= 41)) errs.longitude = 'Must be between 29 and 41 (Tanzania)';
  if ((d.latitude == null) !== (d.longitude == null)) errs[d.latitude == null ? 'latitude' : 'longitude'] = 'Enter both latitude and longitude';
  for (const k of ['span_count', 'length_m', 'width_m', 'design_life_years']) if (d[k] != null && !(d[k] > 0)) errs[k] = 'Must be greater than 0';
  for (const k of ['chainage_km', 'construction_cost_tsh_mio']) if (d[k] != null && !(d[k] >= 0)) errs[k] = 'Cannot be negative';
  if (d.construction_year != null && !(d.construction_year >= 1850 && d.construction_year <= new Date().getFullYear())) {
    errs.construction_year = 'Enter a 4-digit year';
  }
  return errs;
}

async function saveForm(form, existing, addNext) {
  form.querySelectorAll('.fld').forEach(el => { el.classList.remove('invalid'); el.querySelector('.err')?.remove(); });
  const d = readForm(form);
  const errs = validate(d, existing);
  const keys = Object.keys(errs);
  if (keys.length) {
    for (const k of keys) {
      const el = form.querySelector(`.fld[data-k="${k}"]`);
      el.classList.add('invalid');
      el.insertAdjacentHTML('beforeend', `<span class="err">${esc(errs[k])}</span>`);
    }
    form.querySelector(`.fld[data-k="${keys[0]}"]`).scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Please correct the highlighted fields', true);
    return;
  }
  if (d.bridge_no && d.region_code && !d.bridge_no.startsWith(d.region_code + '-')
      && !confirm(`Bridge No. ${d.bridge_no} does not start with the region code ${d.region_code}. Save anyway?`)) return;

  const base = existing || { id: uuid(), version: 0, _base_version: 0, is_deleted: false };
  const rec = { ...base, ...d, _dirty: 1, _rev: (base._rev || 0) + 1, _error: null, _local_updated: new Date().toISOString() };
  await idb.put('bridges', rec);
  await reloadBridges();
  toast(state.online ? 'Saved - syncing…' : 'Saved on tablet - will sync when online');
  if (addNext) {
    renderForm(null, { region_code: d.region_code, road_no: d.road_no, link_name: d.link_name,
      financier: d.financier, record_status: d.record_status });
  } else {
    renderList();
  }
  if (state.online) sync({ quiet: true });
}

async function resolveConflict(b, choice) {
  const s = b._conflict;
  if (choice === 'mine') {
    // Re-base my edits on the server version; next sync overwrites the server.
    await idb.put('bridges', { ...b, _base_version: s.version, _conflict: null, _dirty: 1, _rev: (b._rev || 0) + 1 });
  } else {
    await idb.put('bridges', { ...s, _base_version: s.version, _dirty: 0 });
  }
  await reloadBridges();
  toast(choice === 'mine' ? 'Your version will be sent on the next sync' : 'Server version restored');
  renderList();
  if (state.online && choice === 'mine') sync({ quiet: true });
}

async function removeBridge(b) {
  if (!confirm(`Delete ${b.bridge_no} ${b.bridge_name}? For closed or demolished bridges, set Record status instead.`)) return;
  if (!b.version) {
    await idb.del('bridges', b.id); // never reached the server - just drop it
  } else {
    await idb.put('bridges', { ...b, is_deleted: true, _dirty: 1, _rev: (b._rev || 0) + 1 });
  }
  await reloadBridges();
  renderList();
  if (state.online) sync({ quiet: true });
}

async function verify(b) {
  try {
    await apiJson(`bridges/${b.id}/verify`, { method: 'POST' });
    toast('Marked as verified');
    await sync({ quiet: true });
    renderList();
  } catch (e) {
    toast('Verification needs a connection: ' + e.message, true);
  }
}

// ------------------------------------------------------------------- admin
// Needs a connection: changes go straight to the server, and tablets pick up
// new dropdown values on their next sync.
const ADMIN_TABS = {
  region: { title: 'Regions', key: 'code', lockKey: true, cols: [
    { k: 'code', label: 'Code (2 digits, start of bridge no.)', ph: '12' }, { k: 'name', label: 'Region name', ph: 'MOROGORO' }] },
  road: { title: 'Roads', key: 'road_no', cols: [
    { k: 'road_no', label: 'Road No.', ph: 'T001' }, { k: 'road_name', label: 'Road name' },
    { k: 'road_class', label: 'Class', options: () => ['Trunk', 'Regional'] }] },
  structure_type: { title: 'Structure types', key: 'name', cols: [{ k: 'name', label: 'Name' }, { k: 'sort_order', label: 'Order in list', type: 'number' }] },
  material: { title: 'Materials', key: 'name', cols: [{ k: 'name', label: 'Name' }, { k: 'sort_order', label: 'Order in list', type: 'number' }] },
  financier: { title: 'Financiers', key: 'name', cols: [{ k: 'name', label: 'Name' }, { k: 'sort_order', label: 'Order in list', type: 'number' }] },
  condition_rating: { title: 'Conditions', key: 'name', cols: [{ k: 'name', label: 'Name' }, { k: 'sort_order', label: 'Order in list', type: 'number' }] },
  users: { title: 'Users', key: 'username', cols: [
    { k: 'username', label: 'Username' }, { k: 'full_name', label: 'Full name' },
    { k: 'role', label: 'Role', options: () => ['inspector', 'viewer', 'admin'] },
    { k: 'region_code', label: 'Region (blank = all)', options: () => ['', ...adminData.tables.region.map(r => r.code)] },
    { k: 'active', label: 'Active', type: 'checkbox' },
    { k: 'password', label: 'Password (blank = unchanged)', type: 'password', hidden: true }] },
};
let adminData = null;

async function renderAdmin(tab, editKey) {
  currentView = 'admin';
  renderStatus();
  try {
    adminData = await apiJson('admin/data');
  } catch (e) {
    toast('The admin screen needs a connection: ' + e.message, true);
    return renderList();
  }
  const def = ADMIN_TABS[tab];
  const rows = tab === 'users' ? adminData.users : adminData.tables[tab];
  const editing = editKey != null ? rows.find(r => String(r[def.key]) === String(editKey)) : null;
  const rec = editing || (tab === 'users' ? { active: true, role: 'inspector' } : {});

  const input = c => {
    const v = rec[c.k] ?? '';
    const locked = editing && c.k === def.key && def.lockKey ? ' disabled' : '';
    if (c.options) {
      return `<select name="${c.k}"${locked}>${c.options().map(o =>
        `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o || '(all regions)')}</option>`).join('')}</select>`;
    }
    if (c.type === 'checkbox') return `<input type="checkbox" name="${c.k}"${v ? ' checked' : ''} style="width:28px;min-height:28px">`;
    return `<input name="${c.k}" type="${c.type || 'text'}" value="${c.type === 'password' ? '' : esc(v)}"${locked}
      ${c.ph ? ` placeholder="${esc(c.ph)}"` : ''}${c.type === 'password' ? ' autocomplete="new-password"' : ''}>`;
  };
  const cell = (c, r) => c.type === 'checkbox' ? (r[c.k] ? 'Yes' : '<span class="badge b-bad">Disabled</span>')
    : c.k === 'region_code' ? esc(r[c.k] || 'All') : esc(r[c.k]);
  const visible = def.cols.filter(c => !c.hidden);

  $('#main').innerHTML = `
    <div class="toolbar"><button id="btnBack">← Back to list</button><h2 style="margin:0 8px">Administration</h2></div>
    <div class="toolbar">${Object.entries(ADMIN_TABS).map(([t, d]) =>
      `<button data-tab="${t}"${t === tab ? ' class="primary"' : ''}>${d.title}</button>`).join('')}</div>
    <form class="card" id="adminForm">
      <b>${editing ? `Edit ${esc(editing[def.key])}` : `Add ${def.title.toLowerCase().replace(/s$/, '')}`}</b>
      <div class="grid" style="margin-top:10px">${def.cols.map(c => `<label class="fld"><span>${esc(c.label)}</span>${input(c)}</label>`).join('')}</div>
      <div class="actions" style="position:static">
        <button class="primary">${editing ? 'Save changes' : 'Add'}</button>
        ${editing ? '<button type="button" id="btnNewItem">Cancel edit</button>' : ''}
        ${editing && tab !== 'users' ? '<button type="button" class="danger" id="btnDelItem">Delete</button>' : ''}
      </div>
      ${editing && def.key !== 'code' && tab !== 'users' ? '<p class="hint">Renaming updates every bridge that uses this value.</p>' : ''}
    </form>
    <p class="muted">${rows.length} record(s). Tap a row to edit it.</p>
    <div class="table-wrap"><table>
      <thead><tr>${visible.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr data-key="${esc(r[def.key])}">${visible.map(c => `<td>${cell(c, r)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;

  $('#btnBack').onclick = () => sync({ quiet: true }).then(renderList);
  document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => renderAdmin(b.dataset.tab); });
  document.querySelectorAll('tr[data-key]').forEach(tr => { tr.onclick = () => renderAdmin(tab, tr.dataset.key); });
  if ($('#btnNewItem')) $('#btnNewItem').onclick = () => renderAdmin(tab);
  if ($('#btnDelItem')) $('#btnDelItem').onclick = async () => {
    if (!confirm(`Delete "${editing[def.key]}"?`)) return;
    try {
      await apiJson(`admin/table/${tab}/${encodeURIComponent(editing[def.key])}`, { method: 'DELETE' });
      toast('Deleted');
      renderAdmin(tab);
    } catch (e) { toast(e.message, true); }
  };
  $('#adminForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const row = {};
    for (const c of def.cols) row[c.k] = c.type === 'checkbox' ? f.elements[c.k].checked : f.elements[c.k].value;
    if (editing && def.lockKey) row[def.key] = editing[def.key];
    try {
      await apiJson(tab === 'users' ? 'admin/users' : `admin/table/${tab}`, {
        method: 'POST',
        body: JSON.stringify(tab === 'users'
          ? { old_username: editing ? editing.username : null, row }
          : { old_key: editing ? editing[def.key] : null, row }),
      });
      toast('Saved');
      renderAdmin(tab);
    } catch (err) { toast(err.message, true); }
  };
}

// -------------------------------------------------------------------- boot
async function checkOnline() {
  const was = state.online;
  try { await fetch('api/ping', { cache: 'no-store' }); state.online = true; } catch { state.online = false; }
  if (state.online !== was) renderStatus();
  return state.online;
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Ask the browser not to evict our offline data when storage is low.
  navigator.storage?.persist?.().catch(() => {});

  state.session = await getMeta('session');
  state.lookups = await getMeta('lookups');
  state.lastSync = await getMeta('lastSync');
  await reloadBridges();

  window.addEventListener('online', async () => { if (await checkOnline()) sync({ quiet: true }); });
  window.addEventListener('offline', () => { state.online = false; renderStatus(); });
  setInterval(async () => { if (state.session && await checkOnline()) sync({ quiet: true }); }, 5 * 60 * 1000);

  if (!state.session) return renderLogin();
  renderList();
  if (await checkOnline()) sync({ quiet: true });
}

boot();
