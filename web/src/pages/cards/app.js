/* Página de tarjetas: filtros, orden, scroll infinito, voz y acciones sobre tarjetas. */
import { $, esc, store, fmtDate, fmtDateTime, toast, ADMIN_TOKEN_KEY } from '../../shared/utils.js';

/* ================= Configuración del cliente ================= */
// Rutas relativas: funciona igual en la raíz del dominio o en un subdirectorio (IIS, proxy).
const API = 'api/vocab';

const KINDS = {
  phrasal:      { label:'Phrasal verb', plural:'Phrasal verbs' },
  idiom:        { label:'Modismo',      plural:'Modismos' },
  phrase:       { label:'Frase',        plural:'Frases' },
  onomatopoeia: { label:'Onomatopeya',  plural:'Onomatopeyas' },
  word:         { label:'Palabra',      plural:'Palabras' },
  grammar:      { label:'Estructura',   plural:'Estructuras' }
};
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
const safeKey = k => /^[a-z0-9-]+$/i.test(k) ? k : 'x';
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
let known = new Set(store.get('vocab-known', []));
const exLevels = new Set(store.get('vocab-ex-levels', []));   // niveles desmarcados
const exKinds  = new Set(store.get('vocab-ex-kinds', []));    // tipos desmarcados
let sortState = { by:'added', dir:'desc', seed:0, ...store.get('vocab-sort', {}) };
if (!SORTS[sortState.by]) sortState = { by:'added', dir:'desc', seed:0 };
export let meta = null;
let pageSize = 12;

const feed = { gen:0, skip:0, total:0, shown:0, loading:false, done:false, error:false, ctrl:null, exclude:null };
const grid = $('#grid');

/* ================= Iconos ================= */
const ICON_SPEAK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_SLOW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/></svg>';
const ICON_FLIP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>';
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
const ICON_CARET = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/* ================= Tarjetas ================= */
function latHTML(s){
  if (!s) return '';
  return s.split('-').map(p => {
    const stressed = p === p.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(p);
    return stressed ? `<b>${esc(p)}</b>` : esc(p);
  }).join('<span class="sep">-</span>');
}
const sayBtn = (text, label) => `<button type="button" class="icon-btn" data-say="${esc(text)}" aria-label="Escuchar: ${esc(label || text)}">${ICON_SPEAK}</button>`;

export function cardHTML(d){
  const kind = KINDS[d.kind] || { label: d.kind };
  const kKey = safeKey(d.kind);
  const say = d.say || d.head;
  const tags = `<span class="tag kind">${esc(kind.label)}</span>` + (d.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const isKnown = known.has(d.id);
  const contexts = d.contexts || [], forms = d.forms || [], examples = d.examples || [], related = d.related || [];

  return `
  <article class="card${isKnown ? ' is-known' : ''}" data-id="${esc(d.id)}" style="--k:var(--k-${kKey}, var(--muted))">
    <div class="inner">
      <section class="face front" aria-label="${esc(d.head)}">
        <div class="meta">${tags}${d.level ? `<span class="level" title="Nivel MCER">${esc(d.level)}</span>` : ''}
          <button type="button" class="known" aria-pressed="${isKnown}" aria-label="Marcar ${esc(d.head)} como aprendida" title="Ya la sé"${d.level ? '' : ' style="margin-left:auto"'}>${ICON_CHECK}</button>
        </div>
        <h2 class="head">${esc(d.head)}</h2>
        ${d.ipa || d.lat ? `<dl class="pron">
          ${d.ipa ? `<dt>EE. UU.</dt><dd class="ipa">${esc(d.ipa)}</dd>` : ''}
          ${d.lat ? `<dt>Latino</dt><dd class="lat">${latHTML(d.lat)}</dd>` : ''}
        </dl>` : ''}
        <div class="audio">
          <button type="button" class="play" data-say="${esc(say)}">${ICON_SPEAK}Escuchar</button>
          <button type="button" class="play" data-say="${esc(say)}" data-rate="0.55">${ICON_SLOW}Lento</button>
        </div>
        <p class="meaning">${esc(d.meaning)}</p>
        ${d.ex ? `<div class="ex">${sayBtn(d.ex.en, 'ejemplo')}<p><span class="en">${esc(d.ex.en)}</span><span class="es">${esc(d.ex.es)}</span></p></div>` : ''}
        <button type="button" class="flip" data-flip>${ICON_FLIP}Contextos y más ejemplos</button>
      </section>

      <section class="face back" aria-label="Detalles de ${esc(d.head)}" inert>
        <div class="meta"><span class="tag kind">${esc(kind.label)}</span>
          <h2 class="head">${esc(d.head)}</h2>${sayBtn(say, d.head)}
        </div>
        <p class="meaning">${esc(d.meaning)}</p>
        ${contexts.length ? `<div class="sec"><h3>${contexts.length > 1 ? 'Contextos de uso' : 'Contexto de uso'}</h3>
          <ul class="ctx">${contexts.map(c => `<li><b>${esc(c.title)}:</b> ${esc(c.text)}</li>`).join('')}</ul></div>` : ''}
        ${forms.length ? `<div class="sec"><h3>${esc(d.formsLabel || 'Formas')}</h3>
          <ul class="forms">${forms.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
        ${examples.length ? `<div class="sec"><h3>Otros ejemplos</h3>
          <ul class="exs">${examples.map(e => `<li>${sayBtn(e.en, 'ejemplo')}<p><span class="en">${esc(e.en)}</span><span class="es">${esc(e.es)}</span></p></li>`).join('')}</ul></div>` : ''}
        ${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}
        ${related.length ? `<p class="rel">Relacionadas: <span>${related.map(esc).join(', ')}</span></p>` : ''}
        ${d.addedAt ? `<p class="added">Agregada el ${esc(fmtDate(d.addedAt))}${d.source ? `, en ${esc(d.source)}` : ''}</p>` : ''}
        <div class="back-actions">
          <button type="button" class="flip" data-flip>${ICON_FLIP}Volver</button>
          <button type="button" class="del" data-del aria-label="Eliminar ${esc(d.head)}">Eliminar</button>
        </div>
      </section>
    </div>
  </article>`;
}

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
  let token = store.get(ADMIN_TOKEN_KEY, '');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token) {
      token = (prompt('Clave de administración para modificar tarjetas:') || '').trim();
      if (!token) throw new Error('Se necesita la clave de administración.');
    }
    const headers = { Accept:'application/json', Authorization:`Bearer ${token}` };
    if (options.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}/${path}`, { ...options, headers });
    if (res.status === 401) { store.set(ADMIN_TOKEN_KEY, ''); token = ''; continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `El servidor respondió con el código ${res.status}.`);
    store.set(ADMIN_TOKEN_KEY, token);
    return body;
  }
  throw new Error('La clave de administración no es correcta.');
}

async function deleteCard(card){
  const id = card.dataset.id, head = card.querySelector('.head')?.textContent || id;
  if (!confirm(`¿Eliminar “${head}”? Esta acción no se puede deshacer.`)) return;
  try {
    await authed(`entries/${encodeURIComponent(id)}`, { method:'DELETE' });
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
export function flip(card){
  const flipped = card.classList.toggle('flipped');
  const [front, back] = card.querySelectorAll('.face');
  front.inert = flipped; back.inert = !flipped;
  (flipped ? back : front).querySelector('[data-flip]').focus({ preventScroll:true });
}
grid.addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const s = e.target.closest('[data-say]');
  if (s) { speak(s.dataset.say, parseFloat(s.dataset.rate) || 0.95, s); return; }
  if (e.target.closest('[data-del]')) { deleteCard(card); return; }
  const k = e.target.closest('.known');
  if (k) {
    const id = card.dataset.id;
    known.has(id) ? known.delete(id) : known.add(id);
    store.set('vocab-known', [...known]);
    if ($('#hideKnown').checked && known.has(id)) {
      card.remove(); feed.shown--; updateStatus(); maybeLoadMore(); return;
    }
    k.setAttribute('aria-pressed', known.has(id));
    card.classList.toggle('is-known', known.has(id));
    updateStatus(); return;
  }
  if (e.target.closest('[data-flip]') || !e.target.closest('button, a, input, select, label')) flip(card);
});

/* ================= Controles ================= */
const levelMS = multiSelect($('#levelFilter'), { label:'Nivel', excluded:exLevels, storageKey:'vocab-ex-levels', onChange:resetFeed });
const kindMS  = multiSelect($('#kindFilter'),  { label:'Tipo',  excluded:exKinds,  storageKey:'vocab-ex-kinds',  onChange:resetFeed });
const sortUI  = sortMenu($('#sortMenu'), resetFeed);

let searchTimer;
$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(resetFeed, 250); });
$('#hideKnown').addEventListener('change', resetFeed);
$('#practice').addEventListener('change', e => { document.body.classList.toggle('practice', e.target.checked); store.set('vocab-practice', e.target.checked); });
$('#shuffle').addEventListener('click', () => {
  sortState = { by:'random', dir:'asc', seed:newSeed() };
  sortUI.save(); sortUI.paint(); resetFeed();
});
if (store.get('vocab-practice', false)) { $('#practice').checked = true; document.body.classList.add('practice'); }

/* ================= Arranque ================= */
(async () => {
  try { applyMeta(await api('meta')); }
  catch (err) { $('#sourceInfo').textContent = `No se pudo conectar con el servidor. ${err.message || ''}`; }
  resetFeed();
})();
