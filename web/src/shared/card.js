/* Tarjeta volteable compartida por la página principal (index.html) y la administración (import.html).
   Sin efectos de arranque: importar este módulo no dispara listeners ni cargas. */

import { esc, fmtDate } from './utils.js';

/* ================= Configuración del cliente ================= */
export const KINDS = {
  phrasal:      { label:'Phrasal verb', plural:'Phrasal verbs' },
  idiom:        { label:'Modismo',      plural:'Modismos' },
  phrase:       { label:'Frase',        plural:'Frases' },
  onomatopoeia: { label:'Onomatopeya',  plural:'Onomatopeyas' },
  word:         { label:'Palabra',      plural:'Palabras' },
  grammar:      { label:'Estructura',   plural:'Estructuras' }
};

/* ================= Estado ================= */
// Misma instancia para app.js e import.js: mutarla persiste entre páginas vía localStorage.
export const known = new Set();
export const initKnown = ids => { known.clear(); for (const id of ids) known.add(id); };

let adminUnlocked = false;
export const setAdminUnlocked = v => { adminUnlocked = v; };

/* ================= Iconos ================= */
const ICON_SPEAK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_SLOW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/></svg>';
const ICON_FLIP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>';
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

/* ================= Utilidades ================= */
export const safeKey = k => /^[a-z0-9-]+$/i.test(k) ? k : 'x';

export function latHTML(s){
  if (!s) return '';
  return s.split('-').map(p => {
    const stressed = p === p.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(p);
    return stressed ? `<b>${esc(p)}</b>` : esc(p);
  }).join('<span class="sep">-</span>');
}
export const sayBtn = (text, label) => `<button type="button" class="icon-btn" data-say="${esc(text)}" aria-label="Escuchar: ${esc(label || text)}">${ICON_SPEAK}</button>`;

/* ================= Tarjeta ================= */
// options.admin === false suprime los controles administrativos (Editar/Eliminar),
// pensado para previsualizaciones y comparativos.
export function cardHTML(d, options = {}){
  const kind = KINDS[d.kind] || { label: d.kind };
  const kKey = safeKey(d.kind);
  const say = d.say || d.head;
  const tags = `<span class="tag kind">${esc(kind.label)}</span>` + (d.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const isKnown = known.has(d.id);
  const contexts = d.contexts || [], forms = d.forms || [], examples = d.examples || [], related = d.related || [];
  const adminControls = options.admin !== false && adminUnlocked;

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
          ${adminControls ? `<span class="admin-card-actions"><a class="edit" href="import.html#entries/${encodeURIComponent(d.id)}">Editar</a><button type="button" class="del" data-del aria-label="Eliminar ${esc(d.head)}">Eliminar</button></span>` : ''}
        </div>
      </section>
    </div>
  </article>`;
}

export function flip(card){
  const flipped = card.classList.toggle('flipped');
  const [front, back] = card.querySelectorAll('.face');
  front.inert = flipped; back.inert = !flipped;
  (flipped ? back : front).querySelector('[data-flip]').focus({ preventScroll:true });
}