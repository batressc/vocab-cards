/* Validación y normalización de una entrada de vocabulario. */

export const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export const KIND_ORDER = ['phrasal', 'idiom', 'phrase', 'onomatopoeia', 'word', 'grammar'];

/** Minúsculas, sin tildes y con apóstrofo recto: para buscar y ordenar. */
export const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '.');

export const slug = s => fold(s).replace(/'/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

const str = v => typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
const strList = v => Array.isArray(v) ? v.map(str).filter(Boolean) : [];

/** Acepta { en, es } y el formato antiguo [en, es]. */
function pair(v) {
  if (Array.isArray(v)) return v[0] ? { en: str(v[0]), es: str(v[1]) } : null;
  if (v && typeof v === 'object' && v.en) return { en: str(v.en), es: str(v.es) };
  return null;
}
function context(v) {
  if (Array.isArray(v)) return v[0] ? { title: str(v[0]), text: str(v[1]) } : null;
  if (v && typeof v === 'object' && (v.title || v.text)) return { title: str(v.title), text: str(v.text) };
  return null;
}

/**
 * Convierte un objeto recibido (archivo, texto pegado) en la forma canónica que
 * se guarda en la base de datos. Devuelve { entry, warnings } o { error }.
 * No incluye addedAt ni source: esos datos viven en columnas propias.
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'no es un objeto.' };
  const head = str(raw.head);
  if (!head) return { error: 'falta el campo "head".' };

  const warnings = [];
  const entry = {
    id: str(raw.id) ? slug(raw.id) || str(raw.id) : slug(head),
    kind: (str(raw.kind) || 'word').toLowerCase(),
    head,
    say: str(raw.say) || head,
    tags: strList(raw.tags),
    level: str(raw.level).toUpperCase(),
    ipa: str(raw.ipa),
    lat: str(raw.lat),
    meaning: str(raw.meaning),
    ex: pair(raw.ex),
    contexts: (Array.isArray(raw.contexts) ? raw.contexts : []).map(context).filter(Boolean),
    formsLabel: str(raw.formsLabel),
    forms: strList(raw.forms),
    examples: (Array.isArray(raw.examples) ? raw.examples : []).map(pair).filter(Boolean),
    note: str(raw.note),
    related: strList(raw.related)
  };

  if (!entry.id) return { error: 'no se pudo generar un "id" válido.' };
  if (!entry.meaning) warnings.push('no tiene significado ("meaning").');
  if (!KIND_ORDER.includes(entry.kind)) warnings.push(`tipo "${entry.kind}" desconocido; se mostrará en gris.`);
  if (entry.level && !LEVEL_ORDER.includes(entry.level)) warnings.push(`nivel "${entry.level}" no es A1–C2.`);
  if (!entry.ipa) warnings.push('no tiene pronunciación IPA.');

  let addedAt = null;
  if (raw.addedAt) {
    const t = Date.parse(raw.addedAt);
    if (Number.isNaN(t)) warnings.push('la fecha "addedAt" no es válida; se usará la fecha actual.');
    else addedAt = new Date(t).toISOString();
  }
  return { entry, addedAt, warnings };
}

/**
 * Construye la entrada que usa el servidor en memoria a partir de una fila de
 * la base de datos. Los campos internos no son enumerables: no viajan al navegador.
 */
export function hydrate(row) {
  const e = { ...JSON.parse(row.data), addedAt: row.added_at, updatedAt: row.updated_at, source: row.source || '' };
  Object.defineProperties(e, {
    seq:     { value: row.seq },
    time:    { value: Date.parse(row.added_at) || 0 },
    sortKey: { value: fold(e.head).replace(/^[¿¡"'(\s]+/, '') },
    words:   { value: e.head.split(/\s+/).filter(Boolean).length },
    search:  { value: fold([e.head, e.say, e.meaning, e.kind, e.level, e.note, ...e.tags, ...e.forms, ...e.related].join(' ')) }
  });
  return e;
}
