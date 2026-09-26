/* Pantalla "Agregar tarjetas": texto pegado, archivos o carpeta del servidor.
   Flujo: Revisar (dryRun) → tabla de resultados → Guardar. */

import { $, esc, store, fmtDateTime, plural, toast, ADMIN_TOKEN_KEY, OPENCODE_SESSION_LIMIT_KEY } from '../../shared/utils.js';

const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

const STATUS = {
  new:       'Nueva',
  update:    'Se actualiza',
  same:      'Sin cambios',
  skip:      'Se omite',
  duplicate: 'Repetida',
  error:     'Error'
};
const KIND_LABEL = { phrasal:'Phrasal verb', idiom:'Modismo', phrase:'Frase', onomatopoeia:'Onomatopeya', word:'Palabra', grammar:'Estructura' };

/* ================= Estado ================= */
const state = {
  token: store.get(ADMIN_TOKEN_KEY, ''),
  info: null,               // respuesta de /api/admin/check
  tab: 'text',
  files: [],                // [{ file, text?, error? }]
  review: null,             // último resultado de revisión
  reviewKey: null,          // firma del contenido revisado
  busy: false
};

/* ================= API ================= */
async function adminApi(path, options = {}){
  const res = await fetch(`api/admin/${path}`, {
    ...options,
    headers: { 'Content-Type':'application/json', Accept:'application/json', Authorization:`Bearer ${state.token}` }
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout('La clave no es correcta o cambió. Escríbela de nuevo.'); throw new Error(body.error || 'Clave incorrecta.'); }
  if (!res.ok) throw new Error(body.error || `El servidor respondió con el código ${res.status}.`);
  return body;
}

/* ================= Acceso ================= */
async function login(token){
  state.token = token;
  const input = $('#token');
  try {
    state.info = await adminApi('check');
    store.set(ADMIN_TOKEN_KEY, token);
    input.removeAttribute('aria-invalid');
    showSession();
    loadHistory();
  } catch (err) {
    input.setAttribute('aria-invalid', 'true');
    $('#authMsg').textContent = err.message;
    input.focus();
  }
}

function showSession(){
  $('#authPanel').hidden = true;
  $('#session').hidden = false;
  $('#importPanel').hidden = false;
  $('#extraPanel').hidden = false;
  $('#sessionText').textContent = `Sesión de administración activa. ${plural(state.info.total, 'tarjeta guardada', 'tarjetas guardadas')}.`;
  $('#folderName').textContent = state.info.dataFolder;
  $('#limitHint').textContent = `Hasta ${fmtSize(state.info.maxImportBytes)} por archivo.`;
  renderAiSettings();
}

function renderAiSettings(){
  const panel = $('#aiSettingsPanel');
  const limits = state.info.opencodeSessionLimit;
  panel.hidden = state.info.ai?.provider !== 'opencode-go';
  if (panel.hidden) return;
  const input = $('#opencodeSessionLimit');
  input.min = limits.min;
  input.max = limits.max;
  input.value = store.get(OPENCODE_SESSION_LIMIT_KEY, limits.default);
  $('#aiSettingsHint').textContent = `Las solicitudes 1–N comparten una sesión; la N+1 inicia otra. Valor permitido: ${limits.min}–${limits.max}.`;
}

$('#aiSettingsForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#opencodeSessionLimit');
  const value = Number(input.value);
  if (!Number.isSafeInteger(value) || value < Number(input.min) || value > Number(input.max)) {
    input.setAttribute('aria-invalid', 'true');
    $('#aiSettingsHint').textContent = `Escribe un número entero entre ${input.min} y ${input.max}.`;
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  store.set(OPENCODE_SESSION_LIMIT_KEY, value);
  $('#aiSettingsHint').textContent = `Configuración guardada en este navegador: ${value} solicitudes por sesión.`;
  toast('Configuración de OpenCode Go guardada.');
});

function logout(message){
  state.token = ''; state.info = null;
  store.set(ADMIN_TOKEN_KEY, '');
  $('#authPanel').hidden = false;
  $('#session').hidden = true;
  $('#importPanel').hidden = true;
  $('#resultPanel').hidden = true;
  $('#extraPanel').hidden = true;
  $('#aiSettingsPanel').hidden = true;
  if (message) $('#authMsg').textContent = message;
  $('#token').value = '';
  $('#token').focus();
}

$('#authForm').addEventListener('submit', e => {
  e.preventDefault();
  const t = $('#token').value.trim();
  if (t) login(t);
});
$('#logout').addEventListener('click', () => logout());

/* ================= Pestañas ================= */
const TABS = ['text', 'files', 'folder'];
function selectTab(name, focus){
  state.tab = name;
  for (const t of TABS) {
    const tab = $(`#tab-${t}`), pane = $(`#pane-${t}`), on = t === name;
    tab.setAttribute('aria-selected', on);
    tab.tabIndex = on ? 0 : -1;
    pane.hidden = !on;
    if (on && focus) tab.focus();
  }
  invalidate();
}
document.querySelector('.tabs').addEventListener('click', e => {
  const tab = e.target.closest('[role=tab]'); if (tab) selectTab(tab.id.replace('tab-', ''));
});
document.querySelector('.tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const i = TABS.indexOf(state.tab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
  selectTab(TABS[next], true);
});

/* ================= Texto pegado ================= */
$('#jsonText').addEventListener('input', () => {
  const n = $('#jsonText').value.length;
  $('#textInfo').textContent = n ? `${n.toLocaleString('es')} caracteres.` : 'Acepta un arreglo de entradas, un objeto con "entries" o una sola entrada.';
  invalidate();
});

/* ================= Archivos ================= */
async function addFiles(list){
  const max = state.info?.maxImportBytes ?? 5 * 1024 * 1024;
  for (const file of list) {
    if (state.files.some(f => f.file.name === file.name && f.file.size === file.size)) continue;
    const item = { file };
    if (!/\.json$/i.test(file.name)) item.error = 'no es un archivo .json';
    else if (file.size > max) item.error = `pesa más de ${fmtSize(max)}`;
    else item.text = await file.text();
    state.files.push(item);
  }
  renderFiles(); invalidate();
}
function renderFiles(){
  $('#fileList').innerHTML = state.files.map((f, i) => `
    <li>
      <span>${esc(f.file.name)}</span>
      ${f.error ? `<span class="bad">${esc(f.error)}</span>` : ''}
      <span class="size">${fmtSize(f.file.size)}</span>
      <button type="button" data-remove="${i}" aria-label="Quitar ${esc(f.file.name)}">✕</button>
    </li>`).join('');
}
$('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
$('#fileList').addEventListener('click', e => {
  const b = e.target.closest('[data-remove]'); if (!b) return;
  state.files.splice(Number(b.dataset.remove), 1); renderFiles(); invalidate();
});
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));

/* ================= Revisión y guardado ================= */
const mode = () => document.querySelector('input[name=mode]:checked').value;
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', invalidate));

function payload(dryRun){
  if (state.tab === 'folder') return { path:'import-folder', body:{ mode:mode(), dryRun } };
  if (state.tab === 'text') {
    const text = $('#jsonText').value;
    if (!text.trim()) throw new Error('Pega el contenido JSON antes de revisar.');
    return { path:'import', body:{ sources:[{ name:'Texto pegado', text }], mode:mode(), dryRun, origin:'texto' } };
  }
  const ok = state.files.filter(f => !f.error);
  if (!ok.length) throw new Error('Agrega al menos un archivo .json válido.');
  return { path:'import', body:{ sources: ok.map(f => ({ name:f.file.name, text:f.text })), mode:mode(), dryRun, origin:'archivo' } };
}
const signature = () => {
  try { const p = payload(true); return JSON.stringify([p.path, p.body.mode, p.body.sources?.map(s => [s.name, s.text.length, s.text.slice(0, 200), s.text.slice(-200)])]); }
  catch { return null; }
};

function invalidate(){
  if (state.review && signature() !== state.reviewKey) {
    state.reviewKey = null;
    const note = $('#summary .stale');
    if (!note && !$('#resultPanel').hidden) $('#summary').insertAdjacentHTML('afterbegin', '<p class="stale">El contenido cambió desde la última revisión. Vuelve a revisar antes de guardar.</p>');
  }
  updateActions();
}

function updateActions(){
  const s = state.review?.summary;
  const writes = s ? s.new + s.update : 0;
  const fresh = state.reviewKey && state.reviewKey === signature();
  const save = $('#saveBtn');
  save.disabled = state.busy || !fresh || !writes;
  save.textContent = fresh && writes ? `Guardar ${plural(writes, 'tarjeta', 'tarjetas')}` : 'Guardar';
  $('#reviewBtn').disabled = state.busy;
  $('#actionHint').textContent = state.busy ? 'Procesando…'
    : !fresh ? 'Revisa el contenido para poder guardarlo.'
    : !writes ? 'No hay tarjetas nuevas ni cambios para guardar.'
    : '';
}

async function run(dryRun){
  let p;
  try { p = payload(dryRun); } catch (err) { toast(err.message); return; }
  const key = signature();
  state.busy = true; updateActions();
  try {
    const result = await adminApi(p.path, { method:'POST', body: JSON.stringify(p.body) });
    if (dryRun) {
      state.review = result; state.reviewKey = key;
      renderResult(result, false);
    } else {
      state.review = null; state.reviewKey = null;
      renderResult(result, true);
      clearInputs();
      state.info = await adminApi('check'); showSession();
      loadHistory();
      const s = result.summary;
      toast(`Guardado: ${plural(s.new, 'nueva', 'nuevas')} y ${plural(s.update, 'actualizada', 'actualizadas')}.`);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false; updateActions();
  }
}
$('#reviewBtn').addEventListener('click', () => run(true));
$('#saveBtn').addEventListener('click', () => run(false));

function clearInputs(){
  $('#jsonText').value = '';
  $('#textInfo').textContent = 'Acepta un arreglo de entradas, un objeto con "entries" o una sola entrada.';
  state.files = []; renderFiles();
}

function renderResult(result, saved){
  const s = result.summary, items = result.items || [];
  $('#resultPanel').hidden = false;
  $('#resultTitle').textContent = saved ? 'Importación guardada' : 'Revisión';

  const pills = [
    ['new', 'Nuevas'], ['update', saved ? 'Actualizadas' : 'Se actualizan'], ['same', 'Sin cambios'],
    ['skip', 'Omitidas'], ['duplicate', 'Repetidas'], ['error', 'Errores']
  ].filter(([k]) => s[k]).map(([k, label]) => `<span class="pill">${label}: <b>${s[k]}</b></span>`).join('');

  $('#summary').innerHTML =
    (saved ? `<div class="done"><span>Se guardaron ${plural(s.new, 'tarjeta nueva', 'tarjetas nuevas')} y ${plural(s.update, 'actualización', 'actualizaciones')}.</span><a class="btn primary" href="./">Ver tarjetas</a></div>` : '') +
    (result.empty ? '<p class="hint">La carpeta no contiene archivos .json.</p>' : '') +
    (pills || '<span class="pill">No se encontró contenido.</span>');

  // Errores primero, luego nuevas y actualizaciones; el resto al final.
  const weight = { error:0, duplicate:1, new:2, update:3, skip:4, same:5 };
  const rows = [...items].sort((a, b) => weight[a.status] - weight[b.status]);
  $('#resultRows').innerHTML = rows.length ? rows.map(it => `
    <tr class="${it.status === 'error' ? 'row-error' : ''}">
      <td><span class="st st-${esc(it.status)}">${esc(STATUS[it.status] || it.status)}</span></td>
      <td class="head-cell">${esc(it.head || '—')}</td>
      <td class="muted">${esc(it.id || '')}</td>
      <td>${esc(KIND_LABEL[it.kind] || it.kind || '')}</td>
      <td>${esc(it.level || '')}</td>
      <td class="muted">${esc(it.source || '')}${it.index ? `, n.º ${it.index}` : ''}</td>
      <td>${esc(it.message || '')}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">Sin elementos.</td></tr>';

  $('#resultPanel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start' });
}

/* ================= Historial ================= */
const ORIGIN = { texto:'Texto pegado', archivo:'Archivos', carpeta:'Carpeta del servidor', ia:'Creada con IA' };
async function loadHistory(){
  try {
    const rows = await adminApi('imports');
    $('#historyRows').innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td>${esc(fmtDateTime(r.created_at))}</td>
        <td><span title="${esc(r.sources)}">${esc(ORIGIN[r.origin] || r.origin)}</span><br><span class="muted">${esc(r.sources)}</span></td>
        <td class="num">${r.inserted}</td><td class="num">${r.updated}</td><td class="num">${r.unchanged}</td>
        <td class="num">${r.skipped}</td><td class="num">${r.errors}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">Todavía no hay importaciones.</td></tr>';
  } catch { /* el error ya se mostró */ }
}

/* ================= Arranque ================= */
if (state.token) login(state.token); else $('#token').focus();
updateActions();
