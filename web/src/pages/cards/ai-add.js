/* "Crear tarjeta con IA" desde la búsqueda: barra de sugerencia, diálogo,
   generación, vista previa y guardado. */
import { $, esc, store, toast, findAiModel, resolveAiDefaultModel, OPENCODE_SESSION_LIMIT_KEY, AI_CATEGORY_LABELS } from '../../shared/utils.js';
import { meta, api, authed, cardHTML, flip, speak, applyMeta, resetFeed, onFirstPage, isAdminUnlocked } from './app.js';

const ICON_SPARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/></svg>';

const ai = { term:'', result:null, busy:false, selection:null, defaultModel:null };

/* ---------------- Barra bajo la búsqueda ---------------- */
// Recibe la primera página de cada búsqueda (ver onFirstPage en app.js).
function renderAddBar(page){
  const bar = $('#addBar');
  const q = $('#q').value.trim();
  if (!q || page.exact || q.length > 120) { bar.hidden = true; return; }

  const info = meta?.ai || { enabled:false };
  const msg = page.total
    ? `“<b>${esc(q)}</b>” no tiene una tarjeta propia.`
    : `No hay ninguna tarjeta para “<b>${esc(q)}</b>”.`;
  bar.innerHTML = `
    <span class="msg">${msg}</span>
    ${info.enabled && isAdminUnlocked() ? `<button type="button" class="btn primary" data-ai-open>${ICON_SPARK}Crear con IA</button>` : ''}
    <a class="btn" href="import.html#data">Cargar datos</a>
    ${info.enabled ? (isAdminUnlocked() ? '' : '<p class="why">Desbloquea la administración para crearla con IA.</p>') : `<p class="why">Para crearla con IA, configura un proveedor en config.json. ${esc(info.reason || '')}</p>`}`;
  bar.hidden = false;
}

onFirstPage(renderAddBar);

$('#addBar').addEventListener('click', e => {
  if (e.target.closest('[data-ai-open]')) openAi($('#q').value.trim());
});
$('#q').addEventListener('input', () => { if (!$('#q').value.trim()) $('#addBar').hidden = true; });

/* ---------------- Diálogo ---------------- */
const dlg = $('#aiDialog');

function openAi(term){
  const info = meta?.ai || {};
  ai.defaultModel = resolveAiDefaultModel(info);
  ai.selection = ai.defaultModel ? { ...ai.defaultModel } : null;
  ai.result = null;
  $('#aiTerm').value = term;
  $('#aiHint').value = '';
  $('#aiInstructions').value = '';
  $('#aiBody').innerHTML = '';
  $('#aiActions').hidden = true;
  $('#aiModelPicker').hidden = true;
  $('#aiModelToggle').setAttribute('aria-expanded', 'false');
  renderModelPicker();
  dlg.showModal();
  $('#aiTerm').focus();
  $('#aiTerm').select();
}

dlg.addEventListener('click', e => {
  if ((e.target === dlg || e.target.closest('[data-close]')) && !ai.busy) { dlg.close(); return; }
  // Voltear y escuchar dentro de la vista previa
  const card = e.target.closest('.ai-preview .card'); if (!card) return;
  const s = e.target.closest('[data-say]');
  if (s) { speak(s.dataset.say, parseFloat(s.dataset.rate) || 0.95, s); return; }
  if (e.target.closest('[data-flip]') || !e.target.closest('button, a, input')) flip(card);
});
dlg.addEventListener('cancel', e => { if (ai.busy) e.preventDefault(); });

$('#aiForm').addEventListener('submit', e => { e.preventDefault(); generate(); });
$('#aiRetry').addEventListener('click', generate);
$('#aiSave').addEventListener('click', save);

$('#aiModelToggle').addEventListener('click', () => {
  const picker = $('#aiModelPicker');
  picker.hidden = !picker.hidden;
  $('#aiModelToggle').setAttribute('aria-expanded', String(!picker.hidden));
  if (!picker.hidden) picker.querySelector('input:checked')?.focus();
});

$('#aiModelPicker').addEventListener('change', e => {
  const input = e.target.closest('input[name="ai-model"]');
  if (!input) return;
  ai.selection = { provider: input.dataset.provider, model: input.value };
  renderModelSummary();
});

$('#aiModelPicker').addEventListener('click', e => {
  const button = e.target.closest('.ai-provider-toggle');
  if (!button) return;
  const content = document.getElementById(button.getAttribute('aria-controls'));
  content.hidden = !content.hidden;
  button.setAttribute('aria-expanded', String(!content.hidden));
});

function selectedModel(){
  return findAiModel(meta?.ai, ai.selection);
}

function renderModelSummary(){
  const selected = selectedModel();
  const total = (meta?.ai?.providers || []).reduce((sum, provider) => sum + provider.models.length, 0);
  $('#aiModelSummary').textContent = selected
    ? `${selected.provider.label} · ${selected.model.label}${total > 1 ? ' · Cambiar' : ' · Único disponible'}`
    : 'No hay modelos disponibles';
  $('#aiGenerate').disabled = !selected;
}

function renderModelPicker(){
  const star = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>';
  const caret = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const providers = meta?.ai?.providers || [];
  const total = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const help = !total
    ? '<p class="ai-model-empty">No hay modelos disponibles. Revisa el catálogo desde Administración.</p>'
    : total === 1
      ? '<p class="ai-model-help">Solo hay un modelo utilizable. Configura otra clave o proveedor para mostrar alternativas.</p>'
      : '<p class="ai-model-help">Elige un modelo para esta creación. La selección es temporal; cambia el predeterminado en Administración.</p>';
  const freshness = meta?.ai?.stale ? '<p class="ai-model-warning">El catálogo está desactualizado; se muestra el último resultado disponible.</p>' : '';
  const errors = (meta?.ai?.errors || []).map(error => `<p class="ai-model-warning">${esc(error.message)}</p>`).join('');
  $('#aiModelPicker').innerHTML = help + freshness + errors + providers.map((provider, index) => {
    const id = `ai-provider-${provider.id.replace(/[^a-z0-9_-]/gi, '-')}`;
    return `<section class="ai-model-group">
      <h3><button type="button" class="ai-provider-toggle" aria-expanded="${provider.id === ai.selection?.provider || (!ai.selection && index === 0)}" aria-controls="${esc(id)}"><span>${esc(provider.label)}</span>${caret}</button></h3>
      <div id="${esc(id)}"${provider.id === ai.selection?.provider || (!ai.selection && index === 0) ? '' : ' hidden'}>
      ${provider.models.map(model => {
        const selected = provider.id === ai.selection?.provider && model.id === ai.selection?.model;
        const preferred = provider.id === ai.defaultModel?.provider && model.id === ai.defaultModel?.model;
        return `<div class="ai-model-option">
          <label><input type="radio" name="ai-model" value="${esc(model.id)}" data-provider="${esc(provider.id)}"${selected ? ' checked' : ''}> <span><b>${esc(model.label)}</b><small>${esc(provider.label)}${model.group ? ` · ${esc(model.group)}` : ''}</small></span></label>
          <span class="model-category category-${esc(model.category)}">${esc(AI_CATEGORY_LABELS[model.category] || AI_CATEGORY_LABELS.unclassified)}</span>
          <span class="ai-model-default">${preferred ? star : ''}</span>
        </div>`;
      }).join('')}
      ${provider.stale ? '<p class="ai-model-warning">Último catálogo disponible.</p>' : ''}
      </div>
    </section>`;
  }).join('');
  renderModelSummary();
}

function setBusy(v){
  ai.busy = v;
  for (const control of dlg.querySelectorAll('button, input, textarea')) control.disabled = v;
  if (!v) $('#aiGenerate').disabled = !selectedModel();
}

async function generate(){
  const term = $('#aiTerm').value.trim();
  if (!term || ai.busy) return;
  const selected = selectedModel();
  if (!selected) return;
  setBusy(true);
  $('#aiActions').hidden = true;
  $('#aiBody').innerHTML = `<p class="ai-status"><span class="spinner" aria-hidden="true"></span>Generando la tarjeta con ${esc(selected.provider.label)}… suele tardar entre 5 y 30 segundos.</p>`;
  try {
    const opencodeSessionRequestLimit = store.get(OPENCODE_SESSION_LIMIT_KEY);
    const r = await authed('ai/generate', {
      method:'POST',
      body: JSON.stringify({
        term,
        hint: $('#aiHint').value.trim(),
        instructions: $('#aiInstructions').value.trim(),
        mode:'update',
        provider: ai.selection.provider,
        model: ai.selection.model,
        opencodeSessionRequestLimit
      })
    }, 'api/admin');
    ai.result = r;
    renderPreview(r);
  } catch (err) {
    ai.result = null;
    $('#aiBody').innerHTML = `<p class="ai-status err">${esc(err.message)}</p>`;
  } finally {
    setBusy(false);
  }
}

function renderPreview(r){
  const valid = r.items.filter(it => it.entry && ['new', 'update', 'same'].includes(it.status));
  const errors = r.items.filter(it => it.status === 'error');
  let html = '';

  if (!valid.length) {
    html = `<p class="ai-status err">La respuesta de la IA no se pudo convertir en una tarjeta válida${errors[0] ? `: ${esc(errors[0].message)}` : '.'} Prueba generar otra versión.</p>`;
  } else {
    const it = valid[0];
    const status = it.status === 'new' ? 'Tarjeta nueva. Revísala y guárdala si te convence.'
      : it.status === 'update' ? `Ya existe una tarjeta con el id “${esc(it.id)}”: al guardar se reemplazará por esta versión.`
      : 'Ya tienes una tarjeta idéntica guardada.';
    html += `<p class="ai-status">${status}</p>`;
    if (it.message) html += `<p class="ai-warn">Aviso: ${esc(it.message)}</p>`;
    if (valid.length > 1) html += `<p class="ai-warn">La IA devolvió ${valid.length} tarjetas; se guardarán todas.</p>`;
    html += `<div class="ai-preview">${valid.map(v => cardHTML(v.entry, { admin:false })).join('')}</div>`;
  }
  html += `<p class="ai-meta">Generado con ${esc(r.label)} (${esc(r.model)}).</p>`;
  $('#aiBody').innerHTML = html;

  const writable = valid.some(v => v.status !== 'same');
  $('#aiActions').hidden = false;
  $('#aiSave').hidden = !writable;
  if (writable) $('#aiSave').focus(); else $('#aiRetry').focus();
}

async function save(){
  const r = ai.result;
  if (!r || ai.busy) return;
  setBusy(true);
  try {
    const out = await authed('import', {
      method:'POST',
      body: JSON.stringify({ sources:[{ name:r.source, text:r.text }], mode:'update', origin:'ia', generationId:r.generationId })
    }, 'api/admin');
    const saved = out.items.filter(it => it.status === 'new' || it.status === 'update');
    dlg.close();
    toast(saved.length === 1 ? `Se guardó “${saved[0].head}”.` : `Se guardaron ${saved.length} tarjetas.`);
    applyMeta(await api('meta'));
    // Muestra la tarjeta recién creada: busca por su texto.
    if (saved[0]) $('#q').value = saved[0].head;
    resetFeed();
  } catch (err) {
    $('#aiBody').insertAdjacentHTML('afterbegin', `<p class="ai-status err">${esc(err.message)}</p>`);
  } finally {
    setBusy(false);
  }
}
