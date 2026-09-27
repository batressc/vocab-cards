/* Página de tarjetas: filtros, orden, scroll infinito, voz y acciones sobre tarjetas. */
import { $, esc, store, fmtDateTime, toast, ADMIN_TOKEN_KEY } from '../../shared/utils.js';
import { cardHTML, flip, initKnown, known, setAdminUnlocked, KINDS, safeKey } from '../../shared/card.js';
import { observeCards, stopCardViewTracking, track } from '../../shared/telemetry.js';
export { cardHTML, flip };

/* ================= Configuración del cliente ================= */
// Rutas relativas: funciona igual en la raíz del dominio o en un subdirectorio (IIS, proxy).
const API = 'api/vocab';
const DATA_EPOCH_KEY = 'vocab-data-epoch';

const LEVEL_NAMES = { A1:'Principiante', A2:'Básico', B1:'Intermedio', B2:'Intermedio alto', C1:'Avanzado', C2:'Maestría' };
const SORTS = {
  added:  { label:'Fecha de adición', short:'Fecha',     def:'desc', asc:'Más antiguas primero',   desc:'Más recientes primero',  ascS:'más antiguas',  descS:'más recientes' },
  alpha:  { label:'Alfabético',       short:'Alfabético', def:'asc', asc:'A → Z',                  desc:'Z → A',                  ascS:'A → Z',         descS:'Z → A' },
  level:  { label:'Nivel',            short:'Nivel',      def:'asc', asc:'Básico a avanzado',      desc:'Avanzado a básico',      ascS:'A1 → C2',       descS:'C2 → A1' },
  kind:   { label:'Tipo',             short:'Tipo',       def:'asc', asc:'Phrasal verbs primero',  desc:'Estructuras primero',    ascS:'ascendente',    descS:'descendente' },
  length: { label:'Longitud',         short:'Longitud',   def:'asc', asc:'Palabras sueltas primero', desc:'Frases largas primero', ascS:'cortas primero', descS:'largas primero' },
  random: { label:'Aleatorio',        short:'Aleatorio',  def:'asc', asc:'Aleatorio',              desc:'Aleatorio invertido',    ascS:'normal',        descS:'invertido' }
};

/* ================= Utilidades locales ================= */
const newSeed = () => Math.floor(Math.random() * 2147483647);

export async function api(path, options = {}){
  const res = await fetch(`${API}/${path}`, {
    headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
    ...options
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Espera unos segundos antes de volver a recargar.');
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `El servidor respondió con el código ${res.status}.`);
  }
  return res.json();
}

/* ================= Estado ================= */
initKnown(store.get('vocab-known', []));
const exLevels = new Set(store.get('vocab-ex-levels', []));   // niveles desmarcados
const exKinds  = new Set(store.get('vocab-ex-kinds', []));    // tipos desmarcados
let sortState = { by:'added', dir:'desc', seed:0, ...store.get('vocab-sort', {}) };
if (!SORTS[sortState.by]) sortState = { by:'added', dir:'desc', seed:0 };
export let meta = null;
let pageSize = 12;
let adminUnlocked = false;

const feed = { gen:0, skip:0, total:0, shown:0, loading:false, done:false, error:false, ctrl:null, exclude:null };
const grid = $('#grid');

/* ================= Iconos ================= */
const ICON_CARET = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/* ================= Tarjetas ================= */
// cardHTML() y flip() viven en ../../shared/card.js (se re-exportan arriba).

/* ================= Popover compartido ================= */
function wirePopover(root){
  const btn = root.querySelector('.ms-btn'), pop = root.querySelector('.ms-pop');
  const open = v => {
    pop.hidden = !v; btn.setAttribute('aria-expanded', v);
    if (v) pop.querySelector('input:checked, input')?.focus();
  };
  btn.addEventListener('click', () => open(pop.hidden));
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { open(false); btn.focus(); } });
  document.addEventListener('click', e => { if (!root.contains(e.target)) open(false); });
  return open;
}

/* ================= Dropdown de selección múltiple ================= */
// Guarda los valores DESMARCADOS: así los niveles o tipos nuevos que aparezcan
// al recargar los datos quedan seleccionados por defecto.
function multiSelect(root, { label, excluded, storageKey, onChange }){
  let options = [];
  const popId = root.id + '-pop';
  root.innerHTML = `
    <button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false" aria-controls="${popId}">
      <span><span class="ms-label">${esc(label)}:</span> <span class="ms-val"></span></span>${ICON_CARET}
    </button>
    <div class="ms-pop" id="${popId}" role="group" aria-label="${esc(label)}" hidden>
      <div class="ms-actions"><button type="button" data-all>Seleccionar todo</button><button type="button" data-none>Ninguno</button></div>
      <div class="ms-list"></div>
    </div>`;
  const val = root.querySelector('.ms-val'), list = root.querySelector('.ms-list');
  wirePopover(root);

  const selectedValues = () => options.filter(o => !excluded.has(o.value)).map(o => o.value);
  const persist = () => store.set(storageKey, [...excluded]);
  function summary(){
    const sel = selectedValues(), n = sel.length;
    val.textContent = !options.length ? 'Sin datos'
      : n === options.length ? 'Todos'
      : n === 0 ? 'Ninguno'
      : n <= 2 ? options.filter(o => sel.includes(o.value)).map(o => o.short || o.label).join(', ')
      : `${n} de ${options.length}`;
    root.classList.toggle('partial', options.length > 0 && n !== options.length);
  }
  function paint(){
    list.innerHTML = options.length ? options.map(o => `
      <label class="ms-opt" style="--k:${o.color || 'var(--muted)'}">
        <input type="checkbox" value="${esc(o.value)}"${excluded.has(o.value) ? '' : ' checked'}>
        ${o.color ? '<span class="dot"></span>' : ''}
        <span>${esc(o.label)}${o.sub ? ` <span class="sub">${esc(o.sub)}</span>` : ''}</span>
        <span class="n">${o.count}</span>
      </label>`).join('') : '<div class="ms-empty">Aún no hay datos cargados.</div>';
    summary();
  }
  list.addEventListener('change', e => {
    const b = e.target; if (!b.matches('input[type=checkbox]')) return;
    b.checked ? excluded.delete(b.value) : excluded.add(b.value);
    persist(); summary(); onChange();
  });
  root.querySelector('[data-all]').addEventListener('click', () => { options.forEach(o => excluded.delete(o.value)); persist(); paint(); onChange(); });
  root.querySelector('[data-none]').addEventListener('click', () => { options.forEach(o => excluded.add(o.value)); persist(); paint(); onChange(); });

  return {
    setOptions(opts){ options = opts; paint(); },
    reset(){ excluded.clear(); persist(); paint(); },
    // null = sin filtro (todo seleccionado); [] = nada seleccionado.
    query(){ return options.some(o => excluded.has(o.value)) ? selectedValues() : null; }
  };
}

/* ================= Dropdown de orden ================= */
function sortMenu(root, onChange){
  root.innerHTML = `
    <button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false" aria-controls="sort-pop">
      <span><span class="ms-label">Orden:</span> <span class="ms-val"></span></span>${ICON_CARET}
    </button>
    <div class="ms-pop" id="sort-pop" hidden>
      <fieldset class="ms-group"><legend>Ordenar por</legend>
        ${Object.entries(SORTS).map(([k, s]) => `<label class="ms-opt"><input type="radio" name="sort-by" value="${k}"><span>${esc(s.label)}</span></label>`).join('')}
      </fieldset>
      <fieldset class="ms-group"><legend>Dirección</legend>
        <label class="ms-opt"><input type="radio" name="sort-dir" value="asc"><span data-dir="asc"></span></label>
        <label class="ms-opt"><input type="radio" name="sort-dir" value="desc"><span data-dir="desc"></span></label>
      </fieldset>
    </div>`;
  wirePopover(root);
  const save = () => store.set('vocab-sort', sortState);

  function paint(){
    const s = SORTS[sortState.by];
    root.querySelectorAll('input[name=sort-by]').forEach(r => r.checked = r.value === sortState.by);
    root.querySelectorAll('input[name=sort-dir]').forEach(r => r.checked = r.value === sortState.dir);
    root.querySelector('[data-dir=asc]').textContent = s.asc;
    root.querySelector('[data-dir=desc]').textContent = s.desc;
    root.querySelector('.ms-val').textContent = `${s.short}: ${sortState.dir === 'asc' ? s.ascS : s.descS}`;
    root.classList.toggle('partial', !(sortState.by === 'added' && sortState.dir === 'desc'));
  }
  root.addEventListener('change', e => {
    const r = e.target;
    if (r.name === 'sort-by') {
      sortState.by = r.value;
      sortState.dir = SORTS[r.value].def;
      if (r.value === 'random') sortState.seed = newSeed();
    } else if (r.name === 'sort-dir') {
      sortState.dir = r.value;
    } else return;
    save(); paint(); onChange();
  });
  paint();
  return { paint, save };
}

/* ================= Carga diferida (scroll infinito) ================= */
// Otros módulos (p. ej. ai-add.js) reciben la primera página de cada búsqueda.
const firstPageHooks = [];
export const onFirstPage = fn => { firstPageHooks.push(fn); };

function buildQuery(){
  return {
    skip: feed.skip,
    take: pageSize,
    sort: sortState.by,
    dir: sortState.dir,
    seed: sortState.seed || 0,
    q: $('#q').value.trim() || null,
    levels: levelMS.query(),
    kinds: kindMS.query(),
    excludeIds: feed.exclude
  };
}

export function resetFeed(){
  feed.gen++;
  feed.ctrl?.abort();
  Object.assign(feed, {
    skip:0, total:0, shown:0, loading:false, done:false, error:false, ctrl:null,
    // Se toma una foto de las aprendidas al iniciar la consulta para que la paginación sea estable.
    exclude: $('#hideKnown').checked && known.size ? [...known] : null
  });
  stopCardViewTracking();
  grid.innerHTML = '';
  loadMore();
}

async function loadMore(){
  if (feed.loading || feed.done || feed.error) return;
  const gen = feed.gen;
  feed.loading = true;
  feed.ctrl = new AbortController();
  renderEnd();
  try {
    const page = await api('query', { method:'POST', body: JSON.stringify(buildQuery()), signal: feed.ctrl.signal });
    if (gen !== feed.gen) return;
    if (feed.skip === 0) firstPageHooks.forEach(fn => fn(page));
    grid.insertAdjacentHTML('beforeend', page.items.map(cardHTML).join(''));
    observeCards(grid);
    if (feed.skip === 0 && $('#q').value.trim()) track('search', { term:$('#q').value.trim(), resultCount:page.total });
    feed.skip += page.items.length;
    feed.shown += page.items.length;
    feed.total = page.total;
    feed.done = !page.hasMore || page.items.length === 0;
  } catch (err) {
    if (err.name === 'AbortError' || gen !== feed.gen) return;
    feed.error = err.message || 'No se pudo cargar.';
  } finally {
    if (gen === feed.gen) {
      feed.loading = false;
      renderEnd();
      updateStatus();
      // Si la pantalla es alta y el sentinel sigue visible, pide la siguiente página.
      requestAnimationFrame(maybeLoadMore);
    }
  }
}

function maybeLoadMore(){
  if (feed.done || feed.error || feed.loading) return;
  if ($('#sentinel').getBoundingClientRect().top < innerHeight + 800) loadMore();
}
new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) loadMore();
}, { rootMargin:'800px 0px' }).observe($('#sentinel'));

function renderEnd(){
  const end = $('#feedEnd');
  if (feed.loading) {
    end.innerHTML = `<span class="spinner" aria-hidden="true"></span>${feed.shown ? 'Cargando más tarjetas…' : 'Cargando tarjetas…'}`;
  } else if (feed.error) {
    end.innerHTML = `<p>${esc(feed.error)}</p><button type="button" class="btn" data-retry>Reintentar</button>`;
  } else if (feed.total === 0) {
    end.innerHTML = meta && meta.total === 0
      ? '<p>Todavía no hay tarjetas guardadas.</p><a class="btn primary" href="import.html#data">Ir a Administración</a>'
      : '<p>Ninguna tarjeta coincide con estos filtros.</p><button type="button" class="btn" data-clear>Quitar filtros</button>';
  } else if (feed.done) {
    end.innerHTML = `<p>Llegaste al final: ${feed.total} tarjeta${feed.total === 1 ? '' : 's'}.</p>`;
  } else {
    end.innerHTML = '';
  }
}

function updateStatus(){
  $('#status').textContent = feed.total
    ? `Mostrando ${feed.shown} de ${feed.total}. Ya sabes ${known.size}.`
    : `Ya sabes ${known.size}.`;
}

$('#feedEnd').addEventListener('click', e => {
  if (e.target.closest('[data-retry]')) { feed.error = false; loadMore(); }
  if (e.target.closest('[data-clear]')) {
    $('#q').value = ''; $('#hideKnown').checked = false;
    levelMS.reset(); kindMS.reset(); resetFeed();
  }
});

/* ================= Metadatos y recarga ================= */
function orderedLevels(keys){
  const order = Object.keys(LEVEL_NAMES);
  return [...keys].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}
function orderedKinds(keys){
  const order = Object.keys(KINDS);
  return [...keys].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

export function applyMeta(m){
  const previousEpoch = store.get(DATA_EPOCH_KEY, null);
  if ((previousEpoch !== null && previousEpoch !== m.dataEpoch) || (previousEpoch === null && m.dataEpoch > 0)) {
    known.clear();
    store.set('vocab-known', []);
  }
  store.set(DATA_EPOCH_KEY, m.dataEpoch);
  meta = m;
  pageSize = m.pageSize || 12;
  levelMS.setOptions(orderedLevels(Object.keys(m.levels || {})).map(l => ({
    value:l, label:l || 'Sin nivel', short:l || 'Sin nivel', sub:LEVEL_NAMES[l] || '', count:m.levels[l]
  })));
  kindMS.setOptions(orderedKinds(Object.keys(m.kinds || {})).map(k => ({
    value:k, label:KINDS[k]?.plural || k, color:`var(--k-${safeKey(k)}, var(--muted))`, count:m.kinds[k]
  })));

  $('#sourceInfo').textContent = m.total
    ? `${m.total} tarjeta${m.total === 1 ? '' : 's'} guardada${m.total === 1 ? '' : 's'}. Última actualización: ${fmtDateTime(m.lastUpdated)}.`
    : '';
}

/* ================= Operaciones con clave de administración ================= */
export async function authed(path, options = {}, base = API){
  const token = adminUnlocked && store.get(ADMIN_TOKEN_KEY, '');
  if (!token) throw new Error('Desbloquea primero las funciones de administración.');
  const headers = { Accept:'application/json', Authorization:`Bearer ${token}` };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}/${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    lockAdmin();
    throw new Error('La clave no es correcta o cambió. La administración volvió a bloquearse.');
  }
  if (!res.ok) throw new Error(body.error || `El servidor respondió con el código ${res.status}.`);
  return body;
}

export const isAdminUnlocked = () => adminUnlocked;

function setAdminButton(unlocked){
  $('#adminUnlock').setAttribute('aria-pressed', String(unlocked));
  $('#adminUnlock').textContent = unlocked ? 'Administración desbloqueada' : 'Desbloquear administración';
}

function lockAdmin(){
  adminUnlocked = false;
  setAdminUnlocked(false);
  store.set(ADMIN_TOKEN_KEY, '');
  setAdminButton(false);
  resetFeed();
}

async function unlockAdmin(){
  let token = store.get(ADMIN_TOKEN_KEY, '');
  if (!token) token = (prompt('Clave de administración:') || '').trim();
  if (!token) return;
  try {
    const res = await fetch('api/admin/check', { headers:{ Accept:'application/json', Authorization:`Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      store.set(ADMIN_TOKEN_KEY, '');
      toast(body.error || 'No se pudo validar la clave de administración.');
      return;
    }
    store.set(ADMIN_TOKEN_KEY, token);
    adminUnlocked = true;
    setAdminUnlocked(true);
    setAdminButton(true);
    resetFeed();
  } catch {
    toast('No se pudo conectar con el servidor para validar la clave.');
  }
}

// Al abrir la página se revalida el token guardado; no bloquea el render de tarjetas.
async function restoreAdminFromToken(){
  const token = store.get(ADMIN_TOKEN_KEY, '');
  if (!token) return;
  let res;
  try {
    res = await fetch('api/admin/check', { headers:{ Accept:'application/json', Authorization:`Bearer ${token}` } });
  } catch {
    return; // sin conexión: se conserva el token y se mantiene bloqueado
  }
  if (!res.ok) { lockAdmin(); return; }
  adminUnlocked = true;
  setAdminUnlocked(true);
  setAdminButton(true);
}

$('#adminUnlock').addEventListener('click', () => adminUnlocked ? lockAdmin() : unlockAdmin());

async function deleteCard(card){
  const id = card.dataset.id, head = card.querySelector('.head')?.textContent || id;
  if (!confirm(`¿Eliminar “${head}”? Esta acción no se puede deshacer.`)) return;
  try {
    await authed(`entries/${encodeURIComponent(id)}`, { method:'DELETE' });
    stopCardViewTracking(card);
    card.remove();
    feed.shown--; feed.total--; feed.skip = Math.max(0, feed.skip - 1);
    known.delete(id); store.set('vocab-known', [...known]);
    applyMeta(await api('meta'));
    renderEnd(); updateStatus(); maybeLoadMore();
    toast(`Se eliminó “${head}”.`);
  } catch (err) {
    toast(err.message);
  }
}

/* ================= Voz ================= */
const synth = window.speechSynthesis;
let voices = [];
const PREFERRED = /(Google US English|Samantha|Aria|Jenny|Ava|Allison|Guy|Microsoft.*United States)/i;
function loadVoices(){
  if (!synth) return;
  const all = synth.getVoices();
  voices = all.filter(v => /^en[-_]US/i.test(v.lang));
  if (!voices.length) voices = all.filter(v => /^en/i.test(v.lang));
  const saved = store.get('vocab-voice', '');
  $('#voiceSel').innerHTML = '<option value="">Automática (en-US)</option>' +
    voices.map(v => `<option value="${esc(v.voiceURI)}"${v.voiceURI === saved ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
}
function pickVoice(){
  const saved = store.get('vocab-voice', '');
  return voices.find(v => v.voiceURI === saved) || voices.find(v => PREFERRED.test(v.name)) || voices[0];
}
export function speak(text, rate, btn){
  if (!synth) { toast('Este navegador no tiene síntesis de voz.'); return; }
  synth.cancel();
  document.querySelectorAll('.speaking').forEach(b => b.classList.remove('speaking'));
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = rate || 0.95;
  const v = pickVoice(); if (v) u.voice = v;
  if (btn) { btn.classList.add('speaking'); u.onend = u.onerror = () => btn.classList.remove('speaking'); }
  synth.speak(u);
}
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
$('#voiceSel').addEventListener('change', e => store.set('vocab-voice', e.target.value));

/* ================= Interacción con tarjetas ================= */
grid.addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const s = e.target.closest('[data-say]');
  if (s) { track('audio_play', { entryId:card.dataset.id }); speak(s.dataset.say, parseFloat(s.dataset.rate) || 0.95, s); return; }
  if (e.target.closest('[data-del]')) { deleteCard(card); return; }
  const k = e.target.closest('.known');
  if (k) {
    const id = card.dataset.id;
    known.has(id) ? known.delete(id) : known.add(id);
    store.set('vocab-known', [...known]);
    track('known_changed', { entryId:id, value:known.has(id) });
    if ($('#hideKnown').checked && known.has(id)) {
      stopCardViewTracking(card);
      card.remove(); feed.shown--; updateStatus(); maybeLoadMore(); return;
    }
    k.setAttribute('aria-pressed', known.has(id));
    card.classList.toggle('is-known', known.has(id));
    updateStatus(); return;
  }
  if (e.target.closest('[data-flip]') || !e.target.closest('button, a, input, select, label')) {
    track('card_flip', { entryId:card.dataset.id });
    flip(card);
  }
});

/* ================= Controles ================= */
const levelMS = multiSelect($('#levelFilter'), { label:'Nivel', excluded:exLevels, storageKey:'vocab-ex-levels', onChange:resetFeed });
const kindMS  = multiSelect($('#kindFilter'),  { label:'Tipo',  excluded:exKinds,  storageKey:'vocab-ex-kinds',  onChange:resetFeed });
const sortUI  = sortMenu($('#sortMenu'), resetFeed);

let searchTimer;
$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(resetFeed, 250); });
$('#hideKnown').addEventListener('change', resetFeed);
$('#practice').addEventListener('change', e => {
  document.body.classList.toggle('practice', e.target.checked);
  store.set('vocab-practice', e.target.checked);
  track('practice_changed', { value:e.target.checked });
});
$('#shuffle').addEventListener('click', () => {
  sortState = { by:'random', dir:'asc', seed:newSeed() };
  sortUI.save(); sortUI.paint(); resetFeed();
});
if (store.get('vocab-practice', false)) { $('#practice').checked = true; document.body.classList.add('practice'); }

/* ================= Arranque ================= */
(async () => {
  // La validación del token guardado corre en paralelo con los metadatos y no retrasa el render.
  const [m] = await Promise.allSettled([api('meta'), restoreAdminFromToken()]);
  if (m.status === 'fulfilled') applyMeta(m.value);
  else $('#sourceInfo').textContent = `No se pudo conectar con el servidor. ${m.reason?.message || ''}`;
  resetFeed();
})();
