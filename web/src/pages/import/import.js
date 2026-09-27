/* Administración: configuración de IA y carga de datos.
   Flujo de carga: Revisar (dryRun) → tabla de resultados → Guardar. */

import {
  $, esc, store, fmtDateTime, plural, toast, findAiModel, resolveAiDefaultModel,
  ADMIN_TOKEN_KEY, OPENCODE_SESSION_LIMIT_KEY, AI_CATEGORY_LABELS
} from '../../shared/utils.js';
import { cardHTML, flip, initKnown } from '../../shared/card.js';

const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

// Las tarjetas del editor muestran el estado de "ya la sé" de la página principal.
initKnown(store.get('vocab-known', []));

const STATUS = {
  new:       'Nueva',
  update:    'Se actualiza',
  same:      'Sin cambios',
  skip:      'Se omite',
  duplicate: 'Repetida',
  error:     'Error'
};
const KIND_LABEL = { phrasal:'Phrasal verb', idiom:'Modismo', phrase:'Frase', onomatopoeia:'Onomatopeya', word:'Palabra', grammar:'Estructura' };
const hashEntryId = () => location.hash.startsWith('#entries/') ? decodeURIComponent(location.hash.slice(9)) : '';

/* ================= Estado ================= */
const state = {
  token: store.get(ADMIN_TOKEN_KEY, ''),
  info: null,               // respuesta de /api/admin/check
  adminTab: location.hash === '#data' ? 'data' : location.hash === '#statistics' ? 'statistics' : hashEntryId() ? 'entries' : 'ai',
  tab: 'text',
  files: [],                // [{ file, text?, error? }]
  review: null,             // último resultado de revisión
  reviewKey: null,          // firma del contenido revisado
  busy: false,
  aiDraft: new Map(),
  aiFilters: { default:'', catalog:'' },
  aiExpanded: { default:null, catalog:null },
  entries: { skip:0, take:12, total:0, q:'', selectedId:hashEntryId(), selected:null, preview:null, loading:false }
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
  $('#adminWorkspace').hidden = false;
  $('#sessionText').textContent = `Sesión de administración activa. ${plural(state.info.total, 'tarjeta guardada', 'tarjetas guardadas')}.`;
  $('#folderName').textContent = state.info.dataFolder;
  $('#limitHint').textContent = `Hasta ${fmtSize(state.info.maxImportBytes)} por archivo.`;
  resetAiDraft();
    renderAiDefaultSettings();
    selectAdminTab(state.adminTab);
    if (state.adminTab === 'entries') loadEntries().then(() => state.entries.selectedId && openEntry(state.entries.selectedId));
}

const MODEL_STAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>';
const CARET = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const modelKey = (provider, model) => `${provider}\u0000${model}`;

function resetAiDraft(){
  state.aiDraft = new Map((state.info.ai?.allProviders || []).flatMap(provider => provider.models.map(model => [
    modelKey(provider.id, model.id), { provider:provider.id, model:model.id, visible:model.visible, category:model.category }
  ])));
}

function accordion(provider, content, prefix, expanded = true){
  const id = `${prefix}-${provider.id.replace(/[^a-z0-9_-]/gi, '-')}`;
  return `<section class="provider-card" data-provider="${esc(provider.id)}">
    <h3><button type="button" class="provider-toggle" aria-expanded="${expanded}" aria-controls="${esc(id)}">
      <span>${esc(provider.label)}</span>${CARET}
    </button></h3>
    <div class="provider-content" id="${esc(id)}"${expanded ? '' : ' hidden'}>${content}</div>
  </section>`;
}

const categoryBadge = category => `<span class="model-category category-${esc(category)}">${esc(AI_CATEGORY_LABELS[category] || AI_CATEGORY_LABELS.unclassified)}</span>`;

function reconcileExpanded(section, providers, initiallyExpanded){
  if (state.aiExpanded[section] === null) state.aiExpanded[section] = new Set(initiallyExpanded);
  else state.aiExpanded[section] = new Set([...state.aiExpanded[section]].filter(id => providers.some(provider => provider.id === id)));
}

function modelSearchText(provider, model){
  return [provider.label, provider.id, model.label, model.id, model.group || ''].join(' ').toLocaleLowerCase('es');
}

function applyModelFilter(section){
  const input = $(`#ai${section === 'default' ? 'Default' : 'Catalog'}Filter`);
  const list = $(`#ai${section === 'default' ? 'Default' : 'Catalog'}Models`);
  const query = input.value.trim().toLocaleLowerCase('es');
  state.aiFilters[section] = input.value;
  for (const card of list.querySelectorAll('.provider-card')) {
    let matches = 0;
    for (const row of card.querySelectorAll('[data-model-search]')) {
      const match = !query || row.dataset.modelSearch.includes(query);
      row.hidden = !match;
      if (match) matches++;
    }
    const empty = card.querySelector('[data-filter-empty]');
    if (empty) empty.hidden = !query || matches > 0;
  }
}

function updateExpandAll(section){
  const name = section === 'default' ? 'Default' : 'Catalog';
  const buttons = [...$(`#ai${name}Models`).querySelectorAll('.provider-toggle')];
  const control = $(`#ai${name}ExpandAll`);
  const allExpanded = buttons.length > 0 && buttons.every(button => button.getAttribute('aria-expanded') === 'true');
  control.disabled = !buttons.length;
  control.setAttribute('aria-expanded', String(allExpanded));
  control.textContent = allExpanded ? 'Contraer todos' : 'Expandir todos';
}

function toggleAllAccordions(section){
  const name = section === 'default' ? 'Default' : 'Catalog';
  const buttons = [...$(`#ai${name}Models`).querySelectorAll('.provider-toggle')];
  const expand = !buttons.length || !buttons.every(button => button.getAttribute('aria-expanded') === 'true');
  state.aiExpanded[section] = new Set();
  for (const button of buttons) {
    const content = document.getElementById(button.getAttribute('aria-controls'));
    const provider = button.closest('.provider-card').dataset.provider;
    content.hidden = !expand;
    button.setAttribute('aria-expanded', String(expand));
    if (expand) state.aiExpanded[section].add(provider);
  }
  updateExpandAll(section);
}

function renderAiDefaultSettings(){
  const panel = $('#aiDefaultPanel');
  const info = state.info.ai || {};
  const preferred = resolveAiDefaultModel(info);
  const current = findAiModel(info, preferred);
  const providers = Array.isArray(info.providers) ? info.providers : [];
  reconcileExpanded('default', providers, preferred ? [preferred.provider] : []);
  panel.hidden = false;
  const fetched = info.fetchedAt ? fmtDateTime(info.fetchedAt) : '';
  $('#aiCatalogStatus').textContent = info.stale
    ? `Catálogo desactualizado${fetched ? `; último resultado disponible: ${fetched}` : ''}.`
    : fetched ? `Catálogo actualizado: ${fetched}.` : 'El catálogo todavía no se ha actualizado.';
  $('#aiCatalogStatus').classList.toggle('stale', Boolean(info.stale));
  $('#aiCatalogErrors').innerHTML = (info.errors || []).map(error => `<p>${esc(error.message)}</p>`).join('');
  $('#aiDefaultCurrent').textContent = current
    ? `Predeterminado global: ${current.provider.label} · ${current.model.label}`
    : 'No hay un modelo predeterminado disponible.';
  if (info.defaultFallback) $('#aiDefaultCurrent').textContent += ' El valor guardado no está disponible; se usa este modelo como alternativa sin modificarlo.';
  $('#aiDefaultModels').innerHTML = providers.length ? providers.map(provider => accordion(provider, `
      <fieldset class="model-default-group">
        <legend class="sr-only">Modelos visibles de ${esc(provider.label)}</legend>
         ${provider.models.map(model => {
        const active = provider.id === preferred?.provider && model.id === preferred?.model;
        return `<label class="model-default-option" data-model-search="${esc(modelSearchText(provider, model))}">
          <input type="radio" name="default-model" value="${esc(model.id)}" data-provider="${esc(provider.id)}"${active ? ' checked' : ''}>
          <span><b>${esc(model.label)}</b><small>${esc(provider.label)}${model.group ? ` · ${esc(model.group)}` : ''}</small></span>
          ${categoryBadge(model.category)}
          <span class="model-default-star${active ? ' active' : ''}" title="${active ? 'Predeterminado actual' : 'No es el predeterminado'}">${MODEL_STAR}<span class="sr-only">${active ? 'Predeterminado actual' : ''}</span></span>
        </label>`;
        }).join('') || '<p class="model-empty">Este proveedor no devolvió modelos utilizables.</p>'}
        <p class="model-empty filter-empty" data-filter-empty aria-live="polite" hidden>No hay modelos que coincidan con el filtro en este proveedor.</p>
        ${provider.stale ? '<p class="provider-stale">Se muestra el último catálogo disponible.</p>' : ''}
      </fieldset>
      ${providerSettings(provider.id)}
    `, 'default-provider', state.aiExpanded.default.has(provider.id))).join('') : '<p class="model-empty">No hay modelos visibles. Activa al menos uno en Catálogo completo para habilitar la creación con IA.</p>';
  $('#aiDefaultSave').disabled = !preferred;
  $('#aiDefaultFilter').value = state.aiFilters.default;
  applyModelFilter('default');
  updateExpandAll('default');
  renderFullCatalog();
  renderAiSettings();
}

function renderFullCatalog(){
  const providers = state.info.ai?.allProviders || [];
  reconcileExpanded('catalog', providers, []);
  $('#aiCatalogModels').innerHTML = providers.length ? providers.map(provider => accordion(provider, `
    <div class="provider-actions"><button class="btn provider-select-all" type="button" data-provider-select-all="${esc(provider.id)}"></button></div>
    <div class="catalog-models">${provider.models.map(model => {
      const draft = state.aiDraft.get(modelKey(provider.id, model.id)) || model;
      return `<div class="catalog-model-row" data-model-search="${esc(modelSearchText(provider, model))}">
        <label class="catalog-visible"><input type="checkbox" data-curation-visible data-provider="${esc(provider.id)}" value="${esc(model.id)}"${draft.visible ? ' checked' : ''}> <span><b>${esc(model.label)}</b><small>${esc(provider.label)}${model.group ? ` · ${esc(model.group)}` : ''}</small></span></label>
        <label class="catalog-category"><span class="sr-only">Categoría de ${esc(model.label)}</span><select data-curation-category data-provider="${esc(provider.id)}" data-model="${esc(model.id)}">${Object.entries(AI_CATEGORY_LABELS).map(([value, label]) => `<option value="${value}"${draft.category === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      </div>`;
    }).join('')}</div>
    <p class="model-empty filter-empty" data-filter-empty aria-live="polite" hidden>No hay modelos que coincidan con el filtro en este proveedor.</p>
    ${provider.stale ? '<p class="provider-stale">Se muestra el último catálogo disponible.</p>' : ''}
  `, 'catalog-provider', state.aiExpanded.catalog.has(provider.id))).join('') : '<p class="model-empty">No se descubrieron modelos. Actualiza el catálogo o revisa la configuración de proveedores.</p>';
  $('#aiCatalogSave').disabled = !providers.length;
  $('#aiCatalogFilter').value = state.aiFilters.catalog;
  applyModelFilter('catalog');
  for (const provider of providers) updateProviderSelectionButton(provider.id);
  updateExpandAll('catalog');
}

function providerSettings(providerId){
  if (providerId !== 'opencode-go') {
    return '<p class="provider-note">Las credenciales y conexiones de este proveedor se administran de forma segura en el servidor.</p>';
  }
  return `<div class="provider-settings">
    <h4>Ajustes de OpenCode Go</h4>
    <div class="settings-form">
      <label for="opencodeSessionLimit">Solicitudes por sesión</label>
      <input id="opencodeSessionLimit" type="number" inputmode="numeric" required>
      <button class="btn" id="aiSettingsSave" type="button">Guardar configuración</button>
    </div>
    <p class="hint" id="aiSettingsHint"></p>
  </div>`;
}

$('#aiModelsRefresh').addEventListener('click', async () => {
  const button = $('#aiModelsRefresh');
  button.disabled = true;
  button.textContent = 'Actualizando…';
  $('#aiCatalogStatus').textContent = 'Consultando los catálogos oficiales…';
  try {
    state.info.ai = await adminApi('ai/models/refresh', { method: 'POST', body: '{}' });
    resetAiDraft();
    renderAiDefaultSettings();
    toast(state.info.ai.stale ? 'Catálogo actualizado parcialmente.' : 'Catálogo de modelos actualizado.');
  } catch (err) {
    $('#aiCatalogStatus').textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Actualizar modelos';
  }
});

function curationPayload(defaultModel, draft = true){
  const models = draft
    ? [...state.aiDraft.values()]
    : (state.info.ai?.allProviders || []).flatMap(provider => provider.models.map(model => ({
      provider:provider.id, model:model.id, visible:model.visible, category:model.category
    })));
  return { models, default:defaultModel };
}

async function saveCuration(defaultModel, hint, draft = true){
  const result = await adminApi('ai/curation', { method:'PUT', body:JSON.stringify(curationPayload(defaultModel, draft)) });
  state.info.ai = result;
  resetAiDraft();
  renderAiDefaultSettings();
  $(hint).textContent = 'Configuración global guardada en el servidor.';
}

$('#aiDefaultForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.querySelector('input[name="default-model"]:checked');
  const next = input && { provider: input.dataset.provider, model: input.value };
  if (!findAiModel(state.info.ai, next)) {
    $('#aiDefaultHint').textContent = 'Selecciona un modelo disponible antes de guardar.';
    return;
  }
  try {
    await saveCuration(next, '#aiDefaultHint', false);
    document.querySelector('input[name="default-model"]:checked')?.focus();
    toast('Modelo predeterminado global guardado.');
  } catch (err) { $('#aiDefaultHint').textContent = err.message; }
});

$('#aiCatalogForm').addEventListener('change', e => {
  const visible = e.target.closest('[data-curation-visible]');
  const category = e.target.closest('[data-curation-category]');
  const provider = (visible || category)?.dataset.provider;
  const model = visible?.value || category?.dataset.model;
  const draft = state.aiDraft.get(modelKey(provider, model));
  if (!draft) return;
  if (visible) draft.visible = visible.checked;
  if (category) draft.category = category.value;
  if (visible) updateProviderSelectionButton(provider);
  $('#aiCatalogHint').textContent = 'Hay cambios sin guardar. La vista principal se actualizará al guardar.';
});

function updateProviderSelectionButton(providerId){
  const provider = (state.info.ai?.allProviders || []).find(item => item.id === providerId);
  const button = [...document.querySelectorAll('[data-provider-select-all]')].find(item => item.dataset.providerSelectAll === providerId);
  if (!provider || !button) return;
  const allVisible = provider.models.length > 0 && provider.models.every(model => state.aiDraft.get(modelKey(providerId, model.id))?.visible);
  button.textContent = allVisible ? 'Desmarcar todos' : 'Marcar todos';
  button.setAttribute('aria-label', `${allVisible ? 'Desmarcar' : 'Marcar'} todos los modelos de ${provider.label}`);
  button.setAttribute('aria-pressed', String(allVisible));
  button.disabled = !provider.models.length;
}

$('#aiCatalogForm').addEventListener('click', e => {
  const button = e.target.closest('[data-provider-select-all]');
  if (!button) return;
  const provider = (state.info.ai?.allProviders || []).find(item => item.id === button.dataset.providerSelectAll);
  if (!provider) return;
  const mark = !provider.models.every(model => state.aiDraft.get(modelKey(provider.id, model.id))?.visible);
  for (const model of provider.models) state.aiDraft.get(modelKey(provider.id, model.id)).visible = mark;
  for (const input of $('#aiCatalogModels').querySelectorAll('[data-curation-visible]')) {
    if (input.dataset.provider === provider.id) input.checked = mark;
  }
  updateProviderSelectionButton(provider.id);
  $('#aiCatalogHint').textContent = 'Hay cambios sin guardar. La vista principal se actualizará al guardar.';
});

$('#aiCatalogForm').addEventListener('submit', async e => {
  e.preventDefault();
  const visible = [...state.aiDraft.values()].filter(model => model.visible);
  let preferred = resolveAiDefaultModel(state.info.ai);
  if (!visible.some(model => model.provider === preferred?.provider && model.model === preferred?.model)) preferred = visible[0] ? { provider:visible[0].provider, model:visible[0].model } : null;
  try {
    await saveCuration(preferred, '#aiCatalogHint');
    toast(visible.length ? 'Catálogo global guardado.' : 'Catálogo guardado; la creación con IA quedó deshabilitada.');
  } catch (err) { $('#aiCatalogHint').textContent = err.message; }
});

document.querySelector('#admin-pane-ai').addEventListener('click', e => {
  const button = e.target.closest('.provider-toggle');
  if (!button) return;
  const content = document.getElementById(button.getAttribute('aria-controls'));
  content.hidden = !content.hidden;
  button.setAttribute('aria-expanded', String(!content.hidden));
  const section = button.closest('#aiDefaultPanel') ? 'default' : 'catalog';
  const provider = button.closest('.provider-card').dataset.provider;
  if (content.hidden) state.aiExpanded[section].delete(provider);
  else state.aiExpanded[section].add(provider);
  updateExpandAll(section);
});

$('#aiDefaultFilter').addEventListener('input', () => applyModelFilter('default'));
$('#aiCatalogFilter').addEventListener('input', () => applyModelFilter('catalog'));
$('#aiDefaultExpandAll').addEventListener('click', () => toggleAllAccordions('default'));
$('#aiCatalogExpandAll').addEventListener('click', () => toggleAllAccordions('catalog'));

function renderAiSettings(){
  const input = $('#opencodeSessionLimit');
  if (!input) return;
  const limits = state.info.opencodeSessionLimit;
  input.min = limits.min;
  input.max = limits.max;
  input.value = store.get(OPENCODE_SESSION_LIMIT_KEY, limits.default);
  $('#aiSettingsHint').textContent = `Las solicitudes 1–N comparten una sesión; la N+1 inicia otra. Valor permitido: ${limits.min}–${limits.max}.`;
}

$('#aiDefaultModels').addEventListener('click', e => {
  if (!e.target.closest('#aiSettingsSave')) return;
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
  $('#adminWorkspace').hidden = true;
  $('#resultPanel').hidden = true;
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
const ADMIN_TABS = ['ai', 'entries', 'data', 'statistics'];
function selectAdminTab(name, focus = false){
  state.adminTab = ADMIN_TABS.includes(name) ? name : 'ai';
  for (const tabName of ADMIN_TABS) {
    const tab = $(`#admin-tab-${tabName}`), pane = $(`#admin-pane-${tabName}`), on = tabName === state.adminTab;
    tab.setAttribute('aria-selected', on);
    tab.tabIndex = on ? 0 : -1;
    pane.hidden = !on;
    if (on && focus) tab.focus();
  }
  const hash = state.adminTab === 'data' ? '#data'
    : state.adminTab === 'entries' ? (state.entries.selectedId ? `#entries/${encodeURIComponent(state.entries.selectedId)}` : '#entries')
    : state.adminTab === 'statistics' ? '#statistics'
    : '#ai';
  history.replaceState(null, '', hash);
  if (state.adminTab === 'entries' && state.info && !state.entries.loading) loadEntries();
  if (state.adminTab === 'statistics' && state.info) loadStatistics();
}

document.querySelector('.admin-tabs').addEventListener('click', e => {
  const tab = e.target.closest('[role=tab]');
  if (tab) selectAdminTab(tab.id.replace('admin-tab-', ''));
});
document.querySelector('.admin-tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const i = ADMIN_TABS.indexOf(state.adminTab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? ADMIN_TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ADMIN_TABS.length) % ADMIN_TABS.length;
  selectAdminTab(ADMIN_TABS[next], true);
});

/* ================= Gestión de tarjetas ================= */
async function queryEntries(){
  const res = await fetch('api/vocab/query', {
    method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json' },
    body:JSON.stringify({ q:state.entries.q || null, skip:state.entries.skip, take:state.entries.take, sort:'alpha', dir:'asc' })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'No se pudieron cargar las tarjetas.');
  return body;
}

async function loadEntries(){
  if (state.entries.loading || state.adminTab !== 'entries') return;
  state.entries.loading = true;
  $('#entryGrid').innerHTML = '<p class="muted">Cargando tarjetas…</p>';
  try {
    const page = await queryEntries();
    state.entries.total = page.total;
    $('#entryCount').textContent = plural(page.total, 'tarjeta encontrada', 'tarjetas encontradas');
    $('#entryGrid').innerHTML = page.items.length ? page.items.map(item => `
      <button type="button" class="entry-tile${item.id === state.entries.selectedId ? ' selected' : ''}" data-entry-id="${esc(item.id)}">
        <strong>${esc(item.head)}</strong><span>${esc(item.meaning || 'Sin significado')}</span>
        <small>${esc(KIND_LABEL[item.kind] || item.kind)}${item.level ? ` · ${esc(item.level)}` : ''} · ${esc(item.id)}</small>
      </button>`).join('') : '<p class="muted">No hay tarjetas que coincidan con la búsqueda.</p>';
    const first = page.total ? state.entries.skip + 1 : 0;
    const last = state.entries.skip + page.items.length;
    $('#entryPage').textContent = page.total ? `${first}–${last} de ${page.total}` : 'Sin resultados';
    $('#entryPrev').disabled = state.entries.skip === 0;
    $('#entryNext').disabled = !page.hasMore;
  } catch (err) {
    $('#entryGrid').innerHTML = `<p class="bad">${esc(err.message)}</p>`;
  } finally { state.entries.loading = false; }
}

function renderEntryModels(reset = false){
  const providers = state.info.ai?.providers || [];
  const fallback = resolveAiDefaultModel(state.info.ai);
  const current = reset ? fallback : { provider:$('#entryProvider').value, model:$('#entryModel').value };
  const providerId = providers.some(item => item.id === current?.provider) ? current.provider : fallback?.provider || providers[0]?.id || '';
  $('#entryProvider').innerHTML = providers.map(provider => `<option value="${esc(provider.id)}"${provider.id === providerId ? ' selected' : ''}>${esc(provider.label)}</option>`).join('');
  const provider = providers.find(item => item.id === providerId);
  const modelId = provider?.models.some(item => item.id === current?.model) ? current.model : (providerId === fallback?.provider ? fallback.model : provider?.models[0]?.id);
  $('#entryModel').innerHTML = (provider?.models || []).map(model => `<option value="${esc(model.id)}"${model.id === modelId ? ' selected' : ''}>${esc(model.label)}${model.group ? ` · ${esc(model.group)}` : ''}</option>`).join('');
  $('#entryGenerate').disabled = !provider || !modelId;
}

async function openEntry(id){
  if (state.busy) return;
  try {
    const entry = await adminApi(`entries/${encodeURIComponent(id)}`);
    state.entries.selectedId = entry.id;
    state.entries.selected = entry;
    state.entries.preview = null;
    $('#entryEditor').hidden = false;
    $('#entryEditorCurrent').textContent = `${entry.head} · ${entry.id}`;
    $('#entryInstructions').value = '';
    renderEntryComparison();
    renderEntryModels(true);
    selectAdminTab('entries');
    loadEntries();
    $('#entryInstructions').focus();
  } catch (err) { toast(err.message); }
}

$('#entryGrid').addEventListener('click', e => {
  const button = e.target.closest('[data-entry-id]');
  if (button) openEntry(button.dataset.entryId);
});
$('#entryProvider').addEventListener('change', () => renderEntryModels());

let entrySearchTimer;
$('#entrySearch').addEventListener('input', e => {
  clearTimeout(entrySearchTimer);
  entrySearchTimer = setTimeout(() => { state.entries.q = e.target.value.trim(); state.entries.skip = 0; loadEntries(); }, 250);
});
$('#entryPrev').addEventListener('click', () => { state.entries.skip = Math.max(0, state.entries.skip - state.entries.take); loadEntries(); });
$('#entryNext').addEventListener('click', () => { state.entries.skip += state.entries.take; loadEntries(); });

/* ================= Previsualizaciones de tarjeta ================= */
// Las tarjetas del editor (actual y nueva versión) se voltean y se escuchan aquí.
const previewSynth = window.speechSynthesis;
function speakPreview(text, rate, btn){
  if (!previewSynth) { toast('Este navegador no tiene síntesis de voz.'); return; }
  previewSynth.cancel();
  document.querySelectorAll('.speaking').forEach(b => b.classList.remove('speaking'));
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = rate || 0.95;
  if (btn) { btn.classList.add('speaking'); u.onend = u.onerror = () => btn.classList.remove('speaking'); }
  previewSynth.speak(u);
}

$('#entryPreview').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const s = e.target.closest('[data-say]');
  if (s) { speakPreview(s.dataset.say, parseFloat(s.dataset.rate) || 0.95, s); return; }
  if (e.target.closest('[data-flip]') || !e.target.closest('button, a, input, select, label')) flip(card);
});

function setEntryBusy(busy){
  state.busy = busy;
  for (const control of $('#entryEditor').querySelectorAll('.entry-editor-head button, .entry-edit-form button, .entry-edit-form textarea, .entry-edit-form select, #entryPreviewActions button')) control.disabled = busy;
  if (!busy) renderEntryModels();
}

function emptyEntryPreviewHTML(){
  return `<div class="entry-preview-empty">
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/></svg>
    <strong>La nueva versión aparecerá aquí</strong>
    <span>Genera una vista previa para compararla con la tarjeta actual.</span>
  </div>`;
}

function renderEntryComparison(){
  const current = state.entries.selected;
  if (!current) return;
  const candidate = state.entries.preview?.entry;
  $('#entryPreview').innerHTML = `<div class="compare-grid">
    <section class="compare-col" aria-labelledby="entryCurrentTitle">
      <h3 id="entryCurrentTitle">Actual</h3>
      ${cardHTML(current, { admin:false })}
    </section>
    <section class="compare-col" aria-labelledby="entryCandidateTitle">
      <h3 id="entryCandidateTitle">Nueva versión</h3>
      <div class="entry-preview-surface" id="entryCandidateSurface" aria-busy="false">
        <div class="entry-preview-content" id="entryCandidateContent">${candidate ? cardHTML(candidate, { admin:false }) : emptyEntryPreviewHTML()}</div>
        <div class="entry-preview-loader" id="entryCandidateLoader" role="status" aria-live="polite" aria-atomic="true" hidden>
          <span class="spinner" aria-hidden="true"></span><span>Generando la nueva versión…</span>
        </div>
      </div>
    </section>
  </div>
  <p class="entry-preview-status" id="entryPreviewStatus" role="status" aria-live="polite" aria-atomic="true"></p>
  <p class="hint" id="entryPreviewMeta"></p>`;
  $('#entryPreviewActions').hidden = !candidate;
}

function setEntryPreviewLoading(loading){
  const surface = $('#entryCandidateSurface');
  surface.classList.toggle('is-loading', loading);
  surface.setAttribute('aria-busy', String(loading));
  $('#entryCandidateLoader').hidden = !loading;
}

async function generateEntryEdit(){
  if (!state.entries.selected || state.busy) return;
  setEntryBusy(true);
  $('#entryPreviewStatus').classList.remove('bad');
  $('#entryPreviewStatus').textContent = '';
  setEntryPreviewLoading(true);
  try {
    const result = await adminApi('ai/edit', { method:'POST', body:JSON.stringify({
      entryId:state.entries.selected.id,
      instructions:$('#entryInstructions').value.trim(),
      provider:$('#entryProvider').value,
      model:$('#entryModel').value,
      opencodeSessionRequestLimit:store.get(OPENCODE_SESSION_LIMIT_KEY)
    }) });
    const candidate = result.items[0].entry;
    state.entries.preview = { entry:candidate, source:result.source, generationId:result.generationId };
    $('#entryCandidateContent').innerHTML = cardHTML(candidate, { admin:false });
    setEntryPreviewLoading(false);
    $('#entryPreviewStatus').textContent = 'La nueva versión está lista para revisar.';
    $('#entryPreviewMeta').textContent = `Generado con ${result.label} (${result.model}).`;
    $('#entryPreviewActions').hidden = false;
    $('#entrySave').focus();
  } catch (err) {
    setEntryPreviewLoading(false);
    const status = $('#entryPreviewStatus');
    status.classList.add('bad');
    status.textContent = err.message;
  } finally { setEntryBusy(false); }
}

$('#entryEditForm').addEventListener('submit', e => { e.preventDefault(); generateEntryEdit(); });
$('#entryRetry').addEventListener('click', generateEntryEdit);

$('#entrySave').addEventListener('click', async () => {
  const preview = state.entries.preview;
  const current = state.entries.selected;
  if (!preview || !current || state.busy) return;
  setEntryBusy(true);
  try {
    const result = await adminApi(`entries/${encodeURIComponent(current.id)}`, {
      method:'PUT', body:JSON.stringify({ entry:preview.entry, source:preview.source, generationId:preview.generationId })
    });
    if (result.previousId !== result.entry.id) {
      const known = new Set(store.get('vocab-known', []));
      if (known.delete(result.previousId)) known.add(result.entry.id);
      store.set('vocab-known', [...known]);
    }
    state.entries.selectedId = result.entry.id;
    state.entries.selected = result.entry;
    state.entries.preview = null;
    $('#entryEditorCurrent').textContent = `${result.entry.head} · ${result.entry.id}`;
    renderEntryComparison();
    $('#entryPreviewStatus').textContent = 'Los cambios se guardaron correctamente.';
    selectAdminTab('entries');
    await loadEntries();
    toast(`Se guardó “${result.entry.head}”.`);
  } catch (err) { toast(err.message); }
  finally { setEntryBusy(false); }
});

$('#entryDelete').addEventListener('click', async () => {
  const current = state.entries.selected;
  if (!current || !confirm(`¿Eliminar “${current.head}”? Esta acción no se puede deshacer.`)) return;
  setEntryBusy(true);
  try {
    await adminApi(`entries/${encodeURIComponent(current.id)}`, { method:'DELETE' });
    const known = new Set(store.get('vocab-known', [])); known.delete(current.id); store.set('vocab-known', [...known]);
    state.entries.selectedId = ''; state.entries.selected = null; state.entries.preview = null;
    $('#entryEditor').hidden = true;
    selectAdminTab('entries');
    await loadEntries();
    toast(`Se eliminó “${current.head}”.`);
  } catch (err) { toast(err.message); }
  finally { setEntryBusy(false); }
});

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

/* ================= Estadísticas y mantenimiento ================= */
const n = value => Number(value || 0).toLocaleString('es');
const emptyRow = columns => `<tr><td colspan="${columns}" class="muted">Sin datos en este periodo.</td></tr>`;

async function loadStatistics(){
  const status = $('#statisticsStatus');
  status.textContent = 'Cargando estadísticas…';
  try {
    const [stats, maintenance] = await Promise.all([
      adminApi(`statistics?range=${encodeURIComponent($('#statisticsRange').value)}`),
      adminApi('maintenance/summary')
    ]);
    renderStatistics(stats);
    renderMaintenance(maintenance);
    status.textContent = stats.since ? `Datos desde ${fmtDateTime(stats.since)}.` : 'Todo el historial disponible.';
  } catch (err) { status.textContent = err.message; }
}

function renderStatistics(stats){
  const usage = stats.usage || {}, generation = stats.generation || {};
  const conversion = generation.generations ? Math.round(Number(generation.saved_cards || 0) * 100 / Number(generation.generations)) : 0;
  const kpis = [
    ['Tarjetas vistas', usage.card_views], ['Interacciones', Number(usage.flips || 0) + Number(usage.audio_plays || 0)],
    ['Búsquedas', usage.searches], ['Sin resultados', usage.no_result_searches],
    ['Generaciones IA', generation.generations], ['Conversión a guardado', `${conversion}%`],
    ['Tarjetas generadas y guardadas', generation.saved_cards], ['Aprendidas activas', stats.learning?.known]
  ];
  $('#statisticsKpis').innerHTML = kpis.map(([label, value]) => `<article><strong>${typeof value === 'string' ? esc(value) : n(value)}</strong><span>${esc(label)}</span></article>`).join('');

  const max = Math.max(1, ...(stats.daily || []).map(row => Number(row.generations)));
  $('#generationChart').innerHTML = (stats.daily || []).length ? stats.daily.map(row => `
    <div class="chart-day" title="${esc(row.day)}: ${n(row.generations)} generaciones, ${n(row.saved)} guardadas">
      <span style="height:${Math.max(4, Number(row.generations) * 100 / max)}%"></span><small>${esc(row.day.slice(5))}</small>
    </div>`).join('') : '<p class="muted">Todavía no hay generaciones en este periodo.</p>';

  $('#providerStats').innerHTML = stats.providers.length ? stats.providers.map(row => `<tr><td><b>${esc(row.provider)}</b><br><span class="muted">${esc(row.model)}</span></td><td class="num">${n(row.generations)}</td><td class="num">${n(row.successful)}</td><td class="num">${n(row.saved)}</td><td class="num">${row.average_duration_ms === null ? '—' : `${n(row.average_duration_ms)} ms`}</td></tr>`).join('') : emptyRow(5);
  $('#consumedStats').innerHTML = stats.consumed.length ? stats.consumed.map(row => `<tr><td>${esc(row.entry_id)}</td><td class="num">${n(row.views)}</td><td class="num">${n(row.interactions)}</td><td class="num">${n(row.clients)}</td></tr>`).join('') : emptyRow(4);
  $('#searchStats').innerHTML = stats.searches.length ? stats.searches.map(row => `<tr><td>${esc(row.term)}</td><td class="num">${n(row.searches)}</td><td class="num">${n(row.no_results)}</td></tr>`).join('') : emptyRow(3);
  $('#generatedStats').innerHTML = stats.generatedTerms.length ? stats.generatedTerms.map(row => `<tr><td>${esc(row.term)}</td><td>${row.operation === 'edit' ? 'Edición' : 'Creación'}</td><td class="num">${n(row.generations)}</td><td class="num">${n(row.saved)}</td></tr>`).join('') : emptyRow(4);
}

const MAINTENANCE = {
  cards:{ title:'Eliminar tarjetas', phrase:'ELIMINAR TARJETAS', text:'Borra todas las tarjetas, incrementa la versión de datos e impide que los ejemplos reaparezcan al reiniciar. Conserva métricas, auditoría y configuración de IA.' },
  audit:{ title:'Limpiar auditoría', phrase:'LIMPIAR AUDITORÍA', text:'Borra el historial de importaciones y la auditoría administrativa. Después crea una única marca audit.cleared. Conserva tarjetas y métricas.' },
  metrics:{ title:'Limpiar métricas', phrase:'LIMPIAR MÉTRICAS', text:'Borra eventos de uso, estados de aprendizaje y generaciones IA. Conserva tarjetas y auditoría. No puede borrar localStorage de navegadores desconectados.' },
  all:{ title:'Reiniciar todo', phrase:'REINICIAR TODO', text:'Borra tarjetas, auditoría y métricas; reinicia la curación y el modelo predeterminado de IA. Inhibe el seed y deja una única marca system.reset. No borra SQLite, config.json, .env ni data/seed.' }
};

function renderMaintenance(summary){
  $('#maintenanceStatus').textContent = `Estado actual: ${n(summary.cards)} tarjetas, ${n(summary.imports)} importaciones, ${n(summary.usageEvents)} eventos y ${n(summary.aiGenerations)} generaciones IA. Epoch ${n(summary.dataEpoch)}.`;
  $('#dangerList').innerHTML = Object.entries(MAINTENANCE).map(([scope, item]) => `<article>
    <div><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p></div>
    <button type="button" class="btn danger" data-maintenance="${scope}">${esc(item.title)}</button>
  </article>`).join('');
}

let maintenanceScope = null;
$('#dangerList').addEventListener('click', e => {
  const button = e.target.closest('[data-maintenance]');
  if (!button) return;
  maintenanceScope = button.dataset.maintenance;
  const item = MAINTENANCE[maintenanceScope];
  $('#maintenanceDialogTitle').textContent = item.title;
  $('#maintenanceDialogText').textContent = item.text;
  $('#maintenancePhrase').textContent = item.phrase;
  $('#maintenanceConfirmation').value = '';
  $('#maintenanceConfirm').disabled = true;
  $('#maintenanceDialogStatus').textContent = '';
  $('#maintenanceDialog').showModal();
  $('#maintenanceConfirmation').focus();
});

$('#maintenanceConfirmation').addEventListener('input', e => {
  $('#maintenanceConfirm').disabled = e.target.value !== MAINTENANCE[maintenanceScope]?.phrase;
});

$('#maintenanceForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') { $('#maintenanceDialog').close(); return; }
  const item = MAINTENANCE[maintenanceScope];
  if (!item || $('#maintenanceConfirmation').value !== item.phrase) return;
  $('#maintenanceConfirm').disabled = true;
  $('#maintenanceDialogStatus').textContent = 'Ejecutando limpieza…';
  try {
    const result = await adminApi('maintenance/clear', {
      method:'POST', body:JSON.stringify({ scope:maintenanceScope, confirmation:item.phrase })
    });
    if (maintenanceScope === 'cards' || maintenanceScope === 'all') store.set('vocab-known', []);
    if (maintenanceScope === 'all') store.set(OPENCODE_SESSION_LIMIT_KEY, state.info.opencodeSessionLimit.default);
    $('#maintenanceDialog').close();
    state.info = await adminApi('check');
    showSession();
    renderMaintenance(result.summary);
    await loadStatistics();
    toast(`${item.title}: operación completada.`);
  } catch (err) {
    $('#maintenanceDialogStatus').textContent = err.message;
    $('#maintenanceConfirm').disabled = false;
  }
});

$('#statisticsRange').addEventListener('change', loadStatistics);

/* ================= Arranque ================= */
if (state.token) login(state.token); else $('#token').focus();
updateActions();
