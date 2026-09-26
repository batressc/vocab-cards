/* "Crear tarjeta con IA" desde la búsqueda: barra de sugerencia, diálogo,
   generación, vista previa y guardado. */
import { $, esc, store, toast, OPENCODE_SESSION_LIMIT_KEY } from '../../shared/utils.js';
import { meta, api, authed, cardHTML, flip, speak, applyMeta, resetFeed, onFirstPage } from './app.js';

const ICON_SPARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/></svg>';

const ai = { term:'', result:null, busy:false };

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
    ${info.enabled ? `<button type="button" class="btn primary" data-ai-open>${ICON_SPARK}Crear con IA</button>` : ''}
    <a class="btn" href="import.html">Agregar manualmente</a>
    ${info.enabled ? '' : `<p class="why">Para crearla con IA, configura un proveedor en config.json. ${esc(info.reason || '')}</p>`}`;
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
  ai.result = null;
  $('#aiTerm').value = term;
  $('#aiHint').value = '';
  $('#aiBody').innerHTML = '';
  $('#aiActions').hidden = true;
  dlg.showModal();
  $('#aiTerm').focus();
  $('#aiTerm').select();
}

dlg.addEventListener('click', e => {
  if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
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

function setBusy(v){
  ai.busy = v;
  for (const id of ['aiGenerate', 'aiRetry', 'aiSave', 'aiTerm', 'aiHint']) $(`#${id}`).disabled = v;
}

async function generate(){
  const term = $('#aiTerm').value.trim();
  if (!term || ai.busy) return;
  const info = meta?.ai || {};
  setBusy(true);
  $('#aiActions').hidden = true;
  $('#aiBody').innerHTML = `<p class="ai-status"><span class="spinner" aria-hidden="true"></span>Generando la tarjeta con ${esc(info.label || 'la IA')}… suele tardar entre 5 y 30 segundos.</p>`;
  try {
    const opencodeSessionRequestLimit = store.get(OPENCODE_SESSION_LIMIT_KEY);
    const r = await authed('ai/generate', {
      method:'POST',
      body: JSON.stringify({ term, hint: $('#aiHint').value.trim(), mode:'update', opencodeSessionRequestLimit })
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
    html += `<div class="ai-preview">${valid.map(v => cardHTML(v.entry)).join('')}</div>`;
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
      body: JSON.stringify({ sources:[{ name:r.source, text:r.text }], mode:'update', origin:'ia' })
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
