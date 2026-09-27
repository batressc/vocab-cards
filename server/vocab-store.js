import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { backup } from 'node:sqlite';
import { openDatabase } from './db.js';
import { LEVEL_ORDER, KIND_ORDER, fold, slug, normalizeEntry, hydrate } from './entry.js';
import { parseLenientJson, jsonErrorLine, extractJsonBlocks } from './lenient-json.js';

const SORTS = new Set(['added', 'alpha', 'level', 'kind', 'length', 'random']);
export const AI_MODEL_CATEGORIES = Object.freeze(['unclassified', 'efficient', 'balanced', 'advanced']);
const AI_MODEL_CATEGORY_SET = new Set(AI_MODEL_CATEGORIES);
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const validProviderId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const validModelId = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const modelKey = (provider, model) => `${provider}\u0000${model}`;

export function normalizeGenerationId(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !GENERATION_ID.test(value)) {
    throw Object.assign(new TypeError('El identificador de generación no es válido.'), { status:400, code:'INVALID_GENERATION_ID' });
  }
  return value;
}

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
  #db; #sql; #transaction; #dbPath;
  #backupDatabase; #fileOps;
  #backupRestoreQueue = Promise.resolve();
  #entries = [];
  #byId = new Map();      // id en minúsculas → entrada hidratada
  #stored = new Map();    // id en minúsculas → JSON guardado (para detectar cambios)
  #lastUpdated = null;

  constructor(dbPath, { backupDatabase = backup, fileOps = {} } = {}) {
    this.#dbPath = dbPath;
    this.#backupDatabase = backupDatabase;
    this.#fileOps = { existsSync, renameSync, rmSync, ...fileOps };
    this.#open();
  }

  close() { this.#db.close(); }

  checkHealth() {
    this.#db.prepare('SELECT 1').get();
  }

  #open() {
    ({ db: this.#db, sql: this.#sql, transaction: this.#transaction } = openDatabase(this.#dbPath));
    this.refresh();
  }

  #serializeBackupOperation(operation) {
    const result = this.#backupRestoreQueue.then(operation);
    this.#backupRestoreQueue = result.catch(() => {});
    return result;
  }

  /** Crea un punto consistente aun cuando la conexión siga atendiendo lecturas. */
  backup(path) {
    return this.#serializeBackupOperation(() => this.#backupDatabase(this.#db, path));
  }

  /**
   * Reemplaza una base ya validada. La conexión se cierra antes de tocar el
   * archivo y el original se conserva para volver atrás si no puede reabrirse.
   */
  restoreBackup(path) {
    return this.#serializeBackupOperation(() => this.#restoreBackup(path));
  }

  #restoreBackup(path) {
    const previous = `${this.#dbPath}.restore-previous`;
    const { existsSync, renameSync, rmSync } = this.#fileOps;
    let connectionClosed = false;
    let originalMoved = false;
    let backupMoved = false;
    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.close();
      connectionClosed = true;
      rmSync(previous, { force: true });
      renameSync(this.#dbPath, previous);
      originalMoved = true;
      rmSync(`${this.#dbPath}-wal`, { force: true });
      rmSync(`${this.#dbPath}-shm`, { force: true });
      renameSync(path, this.#dbPath);
      backupMoved = true;
      this.#open();
      connectionClosed = false;
      try { rmSync(previous, { force: true }); } catch {}
    } catch (activationError) {
      if (!connectionClosed) {
        throw new Error('No se pudo preparar la restauración. La base de datos anterior sigue activa.', { cause: activationError });
      }

      try { this.close(); } catch {}
      const rollbackErrors = [];
      if (backupMoved && existsSync(this.#dbPath)) {
        try { rmSync(this.#dbPath, { force: true }); }
        catch (error) { rollbackErrors.push(error); }
      }

      let originalRestored = !originalMoved && existsSync(this.#dbPath);
      if (originalMoved) {
        try {
          renameSync(previous, this.#dbPath);
          originalRestored = true;
        } catch (error) {
          rollbackErrors.push(error);
        }
      }

      if (!originalRestored || !existsSync(this.#dbPath)) {
        const error = new Error('La restauración falló y el rollback no pudo devolver la base de datos anterior a su ubicación. El acceso a datos queda cerrado para evitar crear una base vacía.', {
          cause: new AggregateError([activationError, ...rollbackErrors], 'Falló la activación y el rollback del respaldo.')
        });
        error.code = 'RESTORE_ROLLBACK_FAILED';
        throw error;
      }

      try {
        this.#open();
      } catch (rollbackError) {
        const error = new Error('La restauración falló y no se pudo reabrir la base de datos anterior confirmada. El acceso a datos queda cerrado.', {
          cause: new AggregateError([activationError, ...rollbackErrors, rollbackError], 'Falló la activación o reapertura del respaldo anterior.')
        });
        error.code = 'RESTORE_ROLLBACK_FAILED';
        throw error;
      }
      throw new Error('No se pudo activar el respaldo. La base de datos anterior sigue activa.', { cause: activationError });
    }
  }

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
      kinds: count('kind'),
      dataEpoch: this.#sql.appState.get().data_epoch
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

  /** Devuelve la tarjeta vigente por id; la copia evita mutar el caché interno. */
  get(id) {
    const entry = this.#byId.get(String(id).toLowerCase());
    return entry ? structuredClone(entry) : null;
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
  apply(sources, mode, origin, { generationId } = {}) {
    generationId = normalizeGenerationId(generationId);
    const result = this.plan(sources, mode);
    const now = new Date().toISOString();

    this.#transaction(() => {
      const s = result.summary;
      if (generationId) this.#consumeGeneration(generationId, 'create', s.new + s.update, now);
      for (const it of result.items) {
        if (it.status === 'new') {
          this.#sql.insert.run({ id: it.id, data: it.json, addedAt: it.addedAt || now, now, source: it.source });
        } else if (it.status === 'update') {
          this.#sql.update.run({ id: it.id, data: it.json, addedAt: it.addedAt, now, source: it.source });
        }
      }
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
    let changes = 0;
    this.#transaction(() => {
      changes = this.#sql.remove.run(String(id)).changes;
      if (changes) this.#sql.insertAudit.run({
        createdAt:new Date().toISOString(), action:'entry.deleted', detail:JSON.stringify({ id:String(id).slice(0, 120) })
      });
    });
    if (changes) this.refresh();
    return changes > 0;
  }

  /** Reemplaza exactamente una tarjeta y permite cambiar su id sin crear duplicados. */
  replace(originalId, raw, source = 'Edición con IA', { generationId } = {}) {
    generationId = normalizeGenerationId(generationId);
    const originalKey = String(originalId).toLowerCase();
    const current = this.#byId.get(originalKey);
    if (!current) throw Object.assign(new Error('La tarjeta que quieres editar ya no existe.'), { status: 404, code: 'ENTRY_NOT_FOUND' });
    const normalized = normalizeEntry(raw);
    if (normalized.error) throw Object.assign(new Error(`La tarjeta generada no es válida: ${normalized.error}`), { status: 400, code: 'INVALID_ENTRY' });

    const nextKey = normalized.entry.id.toLowerCase();
    if (nextKey !== originalKey && this.#byId.has(nextKey)) {
      throw Object.assign(new Error(`Ya existe otra tarjeta con el id “${normalized.entry.id}”. Cambia el término y vuelve a generar.`), { status: 409, code: 'ENTRY_ID_COLLISION' });
    }

    const now = new Date().toISOString();
    try {
      this.#transaction(() => {
        if (generationId) this.#consumeGeneration(generationId, 'edit', 1, now);
        const result = this.#sql.replaceById.run({
          originalId: current.id,
          nextId: normalized.entry.id,
          data: JSON.stringify(normalized.entry),
          now,
          source: String(source || 'Edición con IA').slice(0, 500)
        });
        if (result.changes !== 1) throw Object.assign(new Error('La tarjeta cambió mientras se guardaba. Recarga e inténtalo de nuevo.'), { status: 409, code: 'ENTRY_CHANGED' });
        this.#sql.insertAudit.run({
          createdAt:now, action:'entry.replaced', detail:JSON.stringify({ previousId:current.id, id:normalized.entry.id, generationId:generationId || null })
        });
      });
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(err.message)) throw Object.assign(new Error(`Ya existe otra tarjeta con el id “${normalized.entry.id}”. Cambia el término y vuelve a generar.`), { status: 409, code: 'ENTRY_ID_COLLISION' });
      throw err;
    }
    this.refresh();
    return { entry: this.get(normalized.entry.id), previousId: current.id, warnings: normalized.warnings };
  }

  #consumeGeneration(id, operation, savedCount, savedAt) {
    const result = this.#sql.markGenerationSaved.run({ id, operation, savedCount, savedAt });
    if (result.changes === 1) return;

    const generation = this.#sql.generationCorrelation.get(id);
    if (!generation) {
      throw Object.assign(new Error('La generación indicada no existe.'), { status:400, code:'GENERATION_NOT_FOUND' });
    }
    if (generation.operation !== operation) {
      throw Object.assign(new Error('La generación indicada no corresponde a este tipo de guardado.'), {
        status:400, code:'GENERATION_OPERATION_MISMATCH'
      });
    }
    if (generation.saved_count !== 0 || generation.saved_at !== null) {
      throw Object.assign(new Error('La generación indicada ya fue consumida y no puede reutilizarse.'), {
        status:400, code:'GENERATION_ALREADY_CONSUMED'
      });
    }
    throw Object.assign(new Error('La generación no produjo cambios para guardar; no se consumió.'), {
      status:400, code:'GENERATION_WITHOUT_CHANGES'
    });
  }

  history(limit = 15) {
    return this.#sql.history.all(limit);
  }

  /* ------------------------------------------------ métricas y mantenimiento */

  shouldSeedWhenEmpty() {
    return !this.#sql.appState.get().suppress_seed_when_empty;
  }

  recordUsage(batch) {
    const createdAt = new Date().toISOString();
    let accepted = 0;
    this.#transaction(() => {
      for (const event of batch.events) {
        const result = this.#sql.insertUsage.run({
          createdAt, clientId:batch.clientId, sessionId:batch.sessionId, type:event.type,
          entryId:event.entryId, term:event.term, resultCount:event.resultCount, value:event.value
        });
        accepted += Number(result.changes);
        if (event.type === 'known_changed') this.#sql.upsertLearning.run({
          clientId:batch.clientId, entryId:event.entryId, value:event.value, createdAt
        });
      }
    });
    return { accepted };
  }

  recordAiGeneration(generation) {
    this.#sql.insertGeneration.run(generation);
  }

  maintenanceSummary() {
    const count = table => this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const state = this.#sql.appState.get();
    return {
      cards:count('entries'), imports:count('imports'), audit:count('admin_audit'),
      usageEvents:count('usage_events'), learningStates:count('learning_state'), aiGenerations:count('ai_generations'),
      aiPreferences:count('ai_model_preferences'), dataEpoch:state.data_epoch,
      seedSuppressed:Boolean(state.suppress_seed_when_empty)
    };
  }

  clearMaintenance(scope) {
    const allowed = new Set(['cards', 'audit', 'metrics', 'all']);
    if (!allowed.has(scope)) throw new TypeError('El alcance de limpieza no es válido.');
    const before = this.maintenanceSummary();
    const marker = scope === 'all' ? 'system.reset' : scope === 'audit' ? 'audit.cleared' : `maintenance.${scope}.cleared`;
    const cardStateChanges = (scope === 'cards' || scope === 'all') && (before.cards > 0 || !before.seedSuppressed);
    const auditChanges = (scope === 'audit' || scope === 'all') && (before.imports > 0 || before.audit > 1 || Boolean(
      this.#db.prepare('SELECT 1 FROM admin_audit WHERE action <> ? LIMIT 1').get(marker)
    ));
    const metricChanges = (scope === 'metrics' || scope === 'all') && (before.usageEvents > 0 || before.learningStates > 0 || before.aiGenerations > 0);
    const aiStateChanges = scope === 'all' && (before.aiPreferences > 0 || Boolean(this.#sql.aiDefault.get().default_provider));
    const changed = cardStateChanges || auditChanges || metricChanges || aiStateChanges;
    if (!changed) return { scope, changed:false, removed:this.#removedCounts('', before), summary:before };

    const now = new Date().toISOString();
    this.#transaction(() => {
      if (scope === 'cards' || scope === 'all') {
        this.#db.exec('DELETE FROM entries');
        if (cardStateChanges) this.#db.prepare('UPDATE app_state SET suppress_seed_when_empty = 1, data_epoch = data_epoch + 1 WHERE id = 1').run();
      }
      if (scope === 'audit' || scope === 'all') this.#db.exec('DELETE FROM imports; DELETE FROM admin_audit');
      if (scope === 'metrics' || scope === 'all') this.#db.exec('DELETE FROM usage_events; DELETE FROM learning_state; DELETE FROM ai_generations');
      if (scope === 'all') {
        this.#db.exec('DELETE FROM ai_model_preferences');
        this.#sql.updateAiDefault.run({ provider:null, model:null });
      }
      this.#sql.insertAudit.run({
        createdAt:now,
        action:marker,
        detail:JSON.stringify({ scope, removed:this.#removedCounts(scope, before) })
      });
    });
    if (scope === 'cards' || scope === 'all') this.refresh();
    return { scope, changed:true, removed:this.#removedCounts(scope, before), summary:this.maintenanceSummary() };
  }

  #removedCounts(scope, before) {
    return {
      cards:scope === 'cards' || scope === 'all' ? before.cards : 0,
      imports:scope === 'audit' || scope === 'all' ? before.imports : 0,
      audit:scope === 'audit' || scope === 'all' ? before.audit : 0,
      usageEvents:scope === 'metrics' || scope === 'all' ? before.usageEvents : 0,
      learningStates:scope === 'metrics' || scope === 'all' ? before.learningStates : 0,
      aiGenerations:scope === 'metrics' || scope === 'all' ? before.aiGenerations : 0,
      aiPreferences:scope === 'all' ? before.aiPreferences : 0
    };
  }

  statistics(range = '30d') {
    const days = { '7d':7, '30d':30, '90d':90, all:null }[range];
    if (days === undefined) throw new TypeError('El periodo solicitado no es válido.');
    const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
    const params = { since };
    const one = sql => this.#db.prepare(sql).get(params);
    const all = sql => this.#db.prepare(sql).all(params);
    const usage = one(`SELECT COUNT(*) events, COUNT(DISTINCT client_id) clients, COUNT(DISTINCT session_id) sessions,
      SUM(event_type='card_view') card_views, SUM(event_type='card_flip') flips, SUM(event_type='audio_play') audio_plays,
      SUM(event_type='search') searches, SUM(event_type='search' AND result_count=0) no_result_searches,
      SUM(event_type='known_changed') known_changes, SUM(event_type='practice_changed') practice_changes
      FROM usage_events WHERE (@since IS NULL OR created_at >= @since)`);
    const generation = one(`SELECT COUNT(*) generations, SUM(outcome='success') successful, SUM(outcome='invalid') invalid,
      SUM(outcome='provider_error') provider_errors, COALESCE(SUM(saved_count),0) saved_cards,
      ROUND(AVG(duration_ms)) average_duration_ms
      FROM ai_generations WHERE (@since IS NULL OR created_at >= @since)`);
    return {
      range, since, usage, generation,
      daily:all(`SELECT substr(created_at,1,10) day, COUNT(*) generations, SUM(outcome='success') successful, COALESCE(SUM(saved_count),0) saved
        FROM ai_generations WHERE (@since IS NULL OR created_at >= @since) GROUP BY day ORDER BY day`),
      usageDaily:all(`SELECT substr(created_at,1,10) day, SUM(event_type='card_view') views, SUM(event_type='card_flip') flips,
        SUM(event_type='audio_play') audios, SUM(event_type='search') searches
        FROM usage_events WHERE (@since IS NULL OR created_at >= @since) GROUP BY day ORDER BY day`),
      providers:all(`SELECT provider, model, COUNT(*) generations, SUM(outcome='success') successful, COALESCE(SUM(saved_count),0) saved,
        ROUND(AVG(duration_ms)) average_duration_ms FROM ai_generations WHERE (@since IS NULL OR created_at >= @since)
        GROUP BY provider, model ORDER BY generations DESC, provider, model LIMIT 25`),
      consumed:all(`SELECT entry_id, SUM(event_type='card_view') views,
        SUM(event_type IN ('card_flip','audio_play','known_changed')) interactions, COUNT(DISTINCT client_id) clients FROM usage_events
        WHERE entry_id IS NOT NULL AND (@since IS NULL OR created_at >= @since)
        GROUP BY entry_id ORDER BY views DESC, interactions DESC, entry_id LIMIT 25`),
      searches:all(`SELECT term, COUNT(*) searches, SUM(result_count=0) no_results FROM usage_events
        WHERE event_type='search' AND (@since IS NULL OR created_at >= @since) GROUP BY term ORDER BY searches DESC, term LIMIT 25`),
      generatedTerms:all(`SELECT term, operation, COUNT(*) generations, SUM(outcome='success') successful, COALESCE(SUM(saved_count),0) saved
        FROM ai_generations WHERE (@since IS NULL OR created_at >= @since) GROUP BY term, operation ORDER BY generations DESC, term LIMIT 25`),
      learning:{ known:one('SELECT COUNT(*) known FROM learning_state WHERE known=1 AND (@since IS NULL OR updated_at >= @since)').known }
    };
  }

  /* ------------------------------------------------------- curación de IA */

  aiPreferences() {
    const models = new Map(this.#sql.aiPreferences.all().map(row => [modelKey(row.provider, row.model), {
      visible: Boolean(row.visible), category: row.category
    }]));
    const saved = this.#sql.aiDefault.get();
    return {
      models,
      default: saved?.default_provider ? { provider: saved.default_provider, model: saved.default_model } : null
    };
  }

  /** Aplica preferencias persistidas sin modificar el snapshot completo descubierto. */
  projectAiCatalog(snapshot, { admin = false } = {}) {
    const preferences = this.aiPreferences();
    const allProviders = (snapshot?.providers || []).map(provider => ({
      ...provider,
      models: provider.models.map(model => {
        const preference = preferences.models.get(modelKey(provider.id, model.id));
        return { ...model, visible: preference?.visible ?? true, category: preference?.category ?? 'unclassified' };
      })
    }));
    const providers = allProviders.flatMap(provider => {
      const models = provider.models.filter(model => model.visible);
      return models.length ? [{ ...provider, models }] : [];
    });
    const savedDefault = preferences.default;
    const hasSavedDefault = providers.some(provider => provider.id === savedDefault?.provider && provider.models.some(model => model.id === savedDefault.model));
    const first = providers.find(provider => provider.models.length);
    const resolvedDefault = hasSavedDefault ? savedDefault : first ? { provider: first.id, model: first.models[0].id } : null;
    return {
      ...snapshot,
      providers,
      default: resolvedDefault,
      ...(admin ? { allProviders, persistedDefault: savedDefault, defaultFallback: Boolean(savedDefault && !hasSavedDefault && resolvedDefault) } : {})
    };
  }

  /** Guarda solo IDs del snapshot completo actual y conserva overrides de modelos ausentes. */
  saveAiCuration(snapshot, input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.models)) throw new TypeError('La curación debe incluir el catálogo completo de modelos.');
    const catalog = new Set();
    for (const provider of snapshot?.providers || []) {
      for (const model of provider.models || []) catalog.add(modelKey(provider.id, model.id));
    }
    const updates = new Map();
    for (const item of input.models) {
      if (!validProviderId(item?.provider) || !validModelId(item?.model)) throw new TypeError('La curación contiene un identificador de modelo no válido.');
      const key = modelKey(item.provider, item.model);
      if (!catalog.has(key)) throw new TypeError(`El modelo "${item.model}" no pertenece al catálogo completo actual.`);
      if (updates.has(key)) throw new TypeError(`El modelo "${item.model}" está repetido en la curación.`);
      if (typeof item.visible !== 'boolean') throw new TypeError(`La visibilidad de "${item.model}" debe ser verdadera o falsa.`);
      if (!AI_MODEL_CATEGORY_SET.has(item.category)) throw new TypeError(`La categoría de "${item.model}" no es válida.`);
      updates.set(key, item);
    }
    if (updates.size !== catalog.size) throw new TypeError('La curación debe incluir una vez cada modelo del catálogo completo actual.');

    const visible = [...updates.values()].filter(item => item.visible);
    const nextDefault = input.default;
    if (!visible.length) {
      if (nextDefault !== null) throw new TypeError('Sin modelos visibles, el modelo predeterminado debe quedar vacío.');
    } else {
      if (!validProviderId(nextDefault?.provider) || !validModelId(nextDefault?.model)) throw new TypeError('Selecciona un modelo predeterminado visible.');
      if (!updates.get(modelKey(nextDefault.provider, nextDefault.model))?.visible) throw new TypeError('El modelo predeterminado debe estar visible en el catálogo actual.');
    }

    this.#transaction(() => {
      for (const item of updates.values()) this.#sql.upsertAiPreference.run({
        provider: item.provider, model: item.model, visible: item.visible ? 1 : 0, category: item.category
      });
      this.#sql.updateAiDefault.run({ provider: nextDefault?.provider ?? null, model: nextDefault?.model ?? null });
      this.#sql.insertAudit.run({
        createdAt:new Date().toISOString(), action:'ai.curation.updated',
        detail:JSON.stringify({ models:updates.size, visible:visible.length, default:nextDefault || null })
      });
    });
    return this.projectAiCatalog(snapshot, { admin: true });
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
