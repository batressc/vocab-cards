import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { openDatabase } from './db.js';
import { LEVEL_ORDER, KIND_ORDER, fold, slug, normalizeEntry, hydrate } from './entry.js';
import { parseLenientJson, jsonErrorLine, extractJsonBlocks } from './lenient-json.js';

const SORTS = new Set(['added', 'alpha', 'level', 'kind', 'length', 'random']);

/** Hash FNV-1a con mezcla final: orden aleatorio estable para una semilla. */
function mix(seed, id) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D) >>> 0; h ^= h >>> 12;
  return h >>> 0;
}

/**
 * Las entradas se guardan en SQLite y se mantienen en memoria para filtrar y
 * ordenar rápido. Cada escritura se hace dentro de una transacción y luego se
 * refresca la copia en memoria.
 */
export class VocabStore {
  #db; #sql; #transaction;
  #entries = [];
  #byId = new Map();      // id en minúsculas → entrada hidratada
  #stored = new Map();    // id en minúsculas → JSON guardado (para detectar cambios)
  #lastUpdated = null;

  constructor(dbPath) {
    ({ db: this.#db, sql: this.#sql, transaction: this.#transaction } = openDatabase(dbPath));
    this.refresh();
  }

  close() { this.#db.close(); }

  refresh() {
    const rows = this.#sql.all.all();
    this.#entries = rows.map(hydrate);
    this.#byId = new Map(this.#entries.map(e => [e.id.toLowerCase(), e]));
    this.#stored = new Map(rows.map(r => [r.id.toLowerCase(), r.data]));
    this.#lastUpdated = rows.reduce((max, r) => r.updated_at > max ? r.updated_at : max, '') || null;
  }

  get size() { return this.#entries.length; }

  meta(pageSize) {
    const count = key => this.#entries.reduce((acc, e) => (acc[e[key]] = (acc[e[key]] || 0) + 1, acc), {});
    return {
      total: this.#entries.length,
      lastUpdated: this.#lastUpdated,
      pageSize,
      levels: count('level'),
      kinds: count('kind')
    };
  }

  /* -------------------------------------------------------------- consulta */

  query(body = {}, { pageSize = 12, maxPageSize = 100 } = {}) {
    const arr = v => Array.isArray(v) ? v.map(String) : null;           // null = sin filtro
    const skip = Math.max(0, Number.parseInt(body.skip, 10) || 0);
    const take = Math.min(Math.max(Number.parseInt(body.take, 10) || pageSize, 1), maxPageSize);
    const sort = SORTS.has(body.sort) ? body.sort : 'added';
    const d = body.dir === 'asc' ? 1 : -1;
    const seed = Number.parseInt(body.seed, 10) || 0;
    const levels = arr(body.levels), kinds = arr(body.kinds);
    const levelSet = levels && new Set(levels.map(s => s.toUpperCase()));
    const kindSet = kinds && new Set(kinds.map(s => s.toLowerCase()));
    const exclude = new Set((arr(body.excludeIds) || []).map(s => s.toLowerCase()));
    const terms = fold(typeof body.q === 'string' ? body.q.slice(0, 200) : '').split(/\s+/).filter(Boolean);

    const cmp = (x, y) => x < y ? -1 : x > y ? 1 : 0;
    const rank = (order, v) => order.indexOf(v);
    const compare = {
      added:  (a, b) => d * (a.time - b.time) || d * (a.seq - b.seq),
      alpha:  (a, b) => d * cmp(a.sortKey, b.sortKey) || a.seq - b.seq,
      level:  (a, b) => {
        const ra = rank(LEVEL_ORDER, a.level), rb = rank(LEVEL_ORDER, b.level);
        return (ra < 0) - (rb < 0) || d * (ra - rb) || cmp(a.sortKey, b.sortKey);   // sin nivel: al final
      },
      kind:   (a, b) => {
        const ra = rank(KIND_ORDER, a.kind), rb = rank(KIND_ORDER, b.kind);
        return (ra < 0) - (rb < 0) || d * (ra - rb) || cmp(a.kind, b.kind) || cmp(a.sortKey, b.sortKey);
      },
      length: (a, b) => d * (a.words - b.words) || d * (a.head.length - b.head.length) || cmp(a.sortKey, b.sortKey),
      random: (a, b) => d * cmp(mix(seed, a.id), mix(seed, b.id)) || a.seq - b.seq
    }[sort];

    const results = this.#entries
      .filter(e => (!levelSet || levelSet.has(e.level)) &&
                   (!kindSet || kindSet.has(e.kind)) &&
                   !exclude.has(e.id.toLowerCase()) &&
                   terms.every(t => e.search.includes(t)))
      .sort(compare);

    const items = results.slice(skip, skip + take);
    return { total: results.length, skip, items, hasMore: skip + items.length < results.length, exact: this.findExact(body.q) };
  }

  /** Busca una tarjeta cuyo texto sea exactamente el buscado (sin importar filtros, tildes ni signos finales). */
  findExact(q) {
    if (typeof q !== 'string' || !q.trim()) return null;
    const clean = s => fold(s).replace(/^[¿¡"'(\s]+|[?!.…\s]+$/g, '');
    const target = clean(q), id = slug(q);
    const e = this.#entries.find(x => clean(x.head) === target || x.id.toLowerCase() === id);
    return e ? { id: e.id, head: e.head } : null;
  }

  /* ----------------------------------------------------------- importación */

  /**
   * Analiza los textos recibidos sin guardar nada.
   * sources: [{ name, text, defaultAddedAt?, error? }]   mode: 'update' | 'keep'
   * Estados: new, update, same (sin cambios), skip (existe y mode=keep),
   *          duplicate (repetida en el mismo lote; gana la última), error.
   */
  plan(sources, mode, { withEntries = false } = {}) {
    const items = [];
    const inBatch = new Map();

    for (const src of sources) {
      if (src.error) { items.push({ status: 'error', source: src.name, message: src.error }); continue; }
      const blocks = extractJsonBlocks(src.text);
      blocks.forEach((block, b) => {
        const where = blocks.length > 1 ? `${src.name} (bloque ${b + 1})` : src.name;
        let data;
        try { data = parseLenientJson(block); }
        catch (e) { items.push({ status: 'error', source: where, message: `JSON inválido${jsonErrorLine(e, block)}.` }); return; }

        const list = Array.isArray(data) ? data
          : Array.isArray(data?.entries) ? data.entries
          : data && typeof data === 'object' && 'head' in data ? [data]
          : null;
        if (!list) {
          items.push({ status: 'error', source: where, message: 'la raíz debe ser un arreglo, un objeto con "entries" o una sola entrada.' });
          return;
        }
        if (!list.length) items.push({ status: 'error', source: where, message: 'no contiene entradas.' });

        list.forEach((raw, i) => {
          const base = { source: where, index: i + 1 };
          const r = normalizeEntry(raw);
          if (r.error) {
            items.push({ ...base, status: 'error', head: typeof raw?.head === 'string' ? raw.head : '', message: r.error });
            return;
          }
          const key = r.entry.id.toLowerCase();
          const json = JSON.stringify(r.entry);
          const addedAt = r.addedAt || src.defaultAddedAt || null;

          const previous = inBatch.get(key);
          if (previous) {
            previous.status = 'duplicate';
            previous.message = `se repite en ${where}, entrada ${i + 1}; se usa esa versión.`;
          }

          const existing = this.#byId.get(key);
          let status;
          if (!existing) status = 'new';
          else if (this.#stored.get(key) === json && (!r.addedAt || r.addedAt === existing.addedAt)) status = 'same';
          else status = mode === 'keep' ? 'skip' : 'update';

          const item = {
            ...base, status,
            id: r.entry.id, head: r.entry.head, kind: r.entry.kind, level: r.entry.level,
            message: [status === 'skip' ? 'ya existe; se conserva la versión guardada.' : '', ...r.warnings].filter(Boolean).join(' ')
          };
          // Datos internos para apply(); no se envían al navegador.
          Object.defineProperties(item, { json: { value: json }, addedAt: { value: addedAt } });
          if (withEntries) item.entry = { ...r.entry, addedAt: new Date().toISOString(), source: src.name };
          items.push(item);
          inBatch.set(key, item);
        });
      });
    }

    return { items, summary: summarize(items) };
  }

  /** Igual que plan(), pero guarda en una transacción y registra la importación. */
  apply(sources, mode, origin) {
    const result = this.plan(sources, mode);
    const now = new Date().toISOString();

    this.#transaction(() => {
      for (const it of result.items) {
        if (it.status === 'new') {
          this.#sql.insert.run({ id: it.id, data: it.json, addedAt: it.addedAt || now, now, source: it.source });
        } else if (it.status === 'update') {
          this.#sql.update.run({ id: it.id, data: it.json, addedAt: it.addedAt, now, source: it.source });
        }
      }
      const s = result.summary;
      const info = this.#sql.logImport.run({
        createdAt: now, origin, mode,
        sources: [...new Set(sources.map(x => x.name))].join(', ').slice(0, 500),
        inserted: s.new, updated: s.update, unchanged: s.same, skipped: s.skip + s.duplicate, errors: s.error
      });
      result.importId = Number(info.lastInsertRowid);
    });

    this.refresh();
    return result;
  }

  remove(id) {
    const changes = this.#sql.remove.run(String(id)).changes;
    if (changes) this.refresh();
    return changes > 0;
  }

  history(limit = 15) {
    return this.#sql.history.all(limit);
  }

  /** Respaldo completo en el mismo formato que se importa (conserva addedAt). */
  exportAll() {
    const entries = [...this.#entries]
      .sort((a, b) => a.time - b.time || a.seq - b.seq)
      .map(({ updatedAt, source, ...e }) => e);
    return { $schema: '../../schema/vocab-entries.schema.json', exportedAt: new Date().toISOString(), entries };
  }
}

function summarize(items) {
  const s = { new: 0, update: 0, same: 0, skip: 0, duplicate: 0, error: 0 };
  for (const it of items) s[it.status]++;
  return s;
}

/** Lee los .json de la carpeta configurada como fuentes de importación. */
export async function readFolderSources(cfg) {
  const folder = cfg.dataFolder;
  let names;
  try {
    names = await readdir(folder, { recursive: cfg.includeSubfolders });
  } catch (err) {
    return [{ name: cfg.dataFolderSetting, error: err.code === 'ENOENT'
      ? `la carpeta "${cfg.dataFolderSetting}" no existe.`
      : `no se pudo leer la carpeta (${err.code || err.message}).` }];
  }
  const files = names
    .map(n => n.split(sep).join('/'))
    .filter(n => n.toLowerCase().endsWith('.json') && !n.split('/').some(p => p.startsWith('.')))
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  const sources = [];
  for (const name of files) {
    try {
      const info = await stat(join(folder, name));
      if (!info.isFile()) continue;
      if (info.size > cfg.maxImportBytes) {
        sources.push({ name, error: `pesa más de ${Math.round(cfg.maxImportBytes / 1024)} KB; se ignoró.` });
        continue;
      }
      sources.push({ name, text: await readFile(join(folder, name), 'utf8'), defaultAddedAt: info.mtime.toISOString() });
    } catch (err) {
      sources.push({ name, error: `no se pudo leer (${err.code || err.message}).` });
    }
  }
  return sources;
}
