import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VocabStore } from '../vocab-store.js';
import { DATABASE_SCHEMA_VERSION, validateBackupDatabase } from '../db.js';
import { tempStore, entry, source } from './helpers.js';

const aiSnapshot = (models = ['a', 'b']) => ({
  providers: [{ id:'openai', label:'OpenAI', stale:false, models:models.map(id => ({ id, label:id.toUpperCase(), protocol:'responses' })) }],
  default:{ provider:'openai', model:models[0] }, stale:false, errors:[]
});

test('migra una base versión 2 sin alterar sus tarjetas', t => {
  const { store, path, cleanup } = tempStore();
  store.apply([source([entry('legacy')])], 'update', 'texto');
  store.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE app_state; DROP TABLE usage_events; DROP TABLE learning_state; DROP TABLE ai_generations; DROP TABLE admin_audit; PRAGMA user_version = 2');
  db.close();
  const migrated = new VocabStore(path);
  t.after(() => { migrated.close(); cleanup(); });
  assert.equal(migrated.get('legacy').head, 'legacy');
  assert.equal(migrated.meta(12).dataEpoch, 0);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
  check.close();
});

test('plan no guarda nada; apply guarda y registra la importación', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const plan = store.plan([source([entry('give up'), entry('run into')])], 'update');
  assert.equal(plan.summary.new, 2);
  assert.equal(store.size, 0);
  const applied = store.apply([source([entry('give up'), entry('run into')])], 'update', 'texto');
  assert.equal(store.size, 2);
  assert.equal(store.history()[0].inserted, 2);
  assert.ok(applied.importId > 0);
});

test('detecta sin cambios, actualizaciones, omisiones y duplicados', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('give up')])], 'update', 'texto');
  assert.equal(store.plan([source([entry('give up')])], 'update').summary.same, 1);
  const changed = [entry('give up', { meaning: 'Otro significado' })];
  assert.equal(store.plan([source(changed)], 'update').summary.update, 1);
  assert.equal(store.plan([source(changed)], 'keep').summary.skip, 1);
  const dup = store.plan([source([entry('x'), entry('x', { meaning: 'segunda' })])], 'update');
  assert.equal(dup.summary.duplicate, 1);
  assert.equal(dup.summary.new, 1);
});

test('reemplazar conserva la fecha de adición original', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('give up', { addedAt: '2026-01-01T00:00:00Z' })])], 'update', 'texto');
  store.apply([source([entry('give up', { meaning: 'nuevo' })])], 'update', 'texto');
  const item = store.query({ q: 'give up' }).items[0];
  assert.equal(item.meaning, 'nuevo');
  assert.equal(item.addedAt, '2026-01-01T00:00:00.000Z');
});

test('una transacción fallida no deja cambios a medias', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('a')])], 'update', 'texto');
  const before = store.size;
  assert.throws(() => store.apply([source([entry('b')])], 'update', null));   // origin NOT NULL → falla el registro
  assert.equal(store.size, before);
});

test('query filtra, ordena y pagina; findExact ignora mayúsculas y signos', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([
    entry('beta', { level: 'B1', addedAt: '2026-01-02T00:00:00Z' }),
    entry('alpha', { level: 'A2', addedAt: '2026-01-03T00:00:00Z' }),
    entry('How’s it going?', { kind: 'phrase', level: 'A2', addedAt: '2026-01-01T00:00:00Z' })
  ])], 'update', 'texto');

  assert.deepEqual(store.query({ sort: 'added', dir: 'desc' }).items.map(e => e.head), ['alpha', 'beta', 'How’s it going?']);
  assert.deepEqual(store.query({ sort: 'alpha', dir: 'asc' }).items.map(e => e.head), ['alpha', 'beta', 'How’s it going?']);
  assert.equal(store.query({ levels: ['B1'] }).total, 1);
  assert.equal(store.query({ kinds: [] }).total, 0);

  const page = store.query({ take: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);

  const a = store.query({ sort: 'random', seed: 7 }).items.map(e => e.id);
  const b = store.query({ sort: 'random', seed: 7 }).items.map(e => e.id);
  assert.deepEqual(a, b, 'el orden aleatorio es estable para la misma semilla');

  assert.equal(store.query({ q: "how's it going" }).exact?.id, 'hows-it-going');
  assert.equal(store.query({ q: 'alp' }).exact, null);
});

test('eliminar y exportar', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('a'), entry('b')])], 'update', 'texto');
  assert.equal(store.remove('a'), true);
  assert.equal(store.remove('no-existe'), false);
  const exp = store.exportAll();
  assert.deepEqual(exp.entries.map(e => e.id), ['b']);
  assert.ok(exp.entries[0].addedAt);
  assert.equal(exp.entries[0].source, undefined);
});

test('un respaldo SQLite restaura todo el estado y refresca la caché', async t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('antes')])], 'update', 'texto');
  store.recordUsage({
    clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    events:[{ type:'search', entryId:null, term:'antes', resultCount:1, value:null }]
  });
  const stagingDir = mkdtempSync(join(dirname(path), '.restore-test-'));
  const backupPath = join(stagingDir, 'snapshot.sqlite');
  await store.backup(backupPath);
  store.apply([source([entry('despues')])], 'update', 'texto');

  assert.deepEqual(validateBackupDatabase(backupPath), { version:DATABASE_SCHEMA_VERSION });
  await store.restoreBackup(backupPath);

  assert.equal(store.get('antes').head, 'antes');
  assert.equal(store.get('despues'), null, 'la caché se reconstruye desde el respaldo activado');
  assert.equal(store.statistics('all').usage.searches, 1, 'restaura también datos que no son tarjetas');
});

test('un archivo SQLite inválido se rechaza antes de tocar el estado activo', t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('vigente')])], 'update', 'texto');
  const invalidPath = `${path}.invalid.sqlite`;
  writeFileSync(invalidPath, 'no es sqlite');

  assert.throws(() => validateBackupDatabase(invalidPath), /respaldo SQLite válido/);
  assert.equal(store.get('vigente').head, 'vigente');
  assert.equal(store.size, 1);
});

test('un fallo al activar el respaldo reabre la base anterior', async t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('vigente')])], 'update', 'texto');

  await assert.rejects(store.restoreBackup(`${path}.no-existe`), /base de datos anterior sigue activa/);
  assert.equal(store.get('vigente').head, 'vigente');
  store.apply([source([entry('posterior')])], 'update', 'texto');
  assert.equal(store.get('posterior').head, 'posterior', 'la conexión restaurada admite nuevas escrituras');
});

test('backup y restore se serializan y la cola continúa después de un rechazo', async t => {
  let releaseBackup;
  let failFirst = true;
  const events = [];
  const gate = new Promise(resolve => { releaseBackup = resolve; });
  const { store, path, cleanup } = tempStore({
    backupDatabase: async (db, target) => {
      events.push('backup:start');
      if (failFirst) {
        failFirst = false;
        throw new Error('fallo inyectado');
      }
      await gate;
      await sqliteBackup(db, target);
      events.push('backup:end');
    },
    fileOps:{
      renameSync(...args) {
        events.push('restore:rename');
        return renameSync(...args);
      }
    }
  });
  t.after(cleanup);
  store.apply([source([entry('vigente')])], 'update', 'texto');

  await assert.rejects(store.backup(`${path}.failed`), /fallo inyectado/);
  const backupPath = `${path}.snapshot`;
  const backupPromise = store.backup(backupPath);
  const restorePromise = store.restoreBackup(backupPath);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['backup:start', 'backup:start'], 'restore espera aunque una operación anterior haya rechazado');

  releaseBackup();
  await backupPromise;
  await restorePromise;
  assert.deepEqual(events.slice(-3), ['backup:end', 'restore:rename', 'restore:rename']);
  assert.equal(store.get('vigente').head, 'vigente');
});

test('un rollback incompleto no reabre ni crea una base vacía', async t => {
  let renameCount = 0;
  const { store, path, cleanup } = tempStore({
    fileOps:{
      renameSync(sourcePath, targetPath) {
        renameCount++;
        if (renameCount > 1) throw Object.assign(new Error(`rename inyectado ${renameCount}`), { code:'EACCES' });
        return renameSync(sourcePath, targetPath);
      }
    }
  });
  t.after(cleanup);
  store.apply([source([entry('vigente')])], 'update', 'texto');
  const candidate = `${path}.candidate`;
  writeFileSync(candidate, 'candidato');

  await assert.rejects(store.restoreBackup(candidate), error => {
    assert.equal(error.code, 'RESTORE_ROLLBACK_FAILED');
    assert.match(error.message, /evitar crear una base vacía/);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2, 'conserva los fallos de activación y rollback');
    return true;
  });
  assert.equal(existsSync(path), false, 'no recrea el dbPath ausente');
  assert.equal(existsSync(`${path}.restore-previous`), true, 'conserva el original recuperable');
});

test('get obtiene una copia y replace renombra atómicamente conservando addedAt', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('old head', { addedAt:'2026-01-01T00:00:00Z' })])], 'update', 'texto');
  const copy = store.get('old-head');
  copy.head = 'mutada';
  assert.equal(store.get('old-head').head, 'old head');

  const result = store.replace('old-head', entry('new head', { meaning:'Nuevo significado' }));
  assert.equal(result.previousId, 'old-head');
  assert.equal(store.get('old-head'), null);
  assert.equal(result.entry.id, 'new-head');
  assert.equal(result.entry.addedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(result.entry.meaning, 'Nuevo significado');
  assert.ok(result.entry.updatedAt);
});

test('replace rechaza colisión y objetivo ausente sin modificar registros', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('one'), entry('two')])], 'update', 'texto');
  assert.throws(() => store.replace('one', entry('two')), error => error.status === 409 && error.code === 'ENTRY_ID_COLLISION');
  assert.throws(() => store.replace('missing', entry('three')), error => error.status === 404 && error.code === 'ENTRY_NOT_FOUND');
  assert.deepEqual(store.query({ sort:'alpha', dir:'asc' }).items.map(item => item.id), ['one', 'two']);
});

test('migra y persiste la curación global de modelos en SQLite', t => {
  const { store, path, cleanup } = tempStore();
  const snapshot = aiSnapshot();
  store.saveAiCuration(snapshot, {
    models:[
      { provider:'openai', model:'a', visible:false, category:'efficient' },
      { provider:'openai', model:'b', visible:true, category:'advanced' }
    ],
    default:{ provider:'openai', model:'b' }
  });
  store.close();
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.close();
  const reopened = new VocabStore(path);
  t.after(() => { reopened.close(); cleanup(); });
  const projected = reopened.projectAiCatalog(snapshot, { admin:true });
  assert.deepEqual(projected.providers[0].models.map(model => model.id), ['b']);
  assert.equal(projected.allProviders[0].models[0].category, 'efficient');
  assert.deepEqual(projected.default, { provider:'openai', model:'b' });
});

test('rechaza categorías, IDs, modelos desconocidos y predeterminados ocultos', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const snapshot = aiSnapshot();
  const valid = [
    { provider:'openai', model:'a', visible:true, category:'balanced' },
    { provider:'openai', model:'b', visible:false, category:'unclassified' }
  ];
  assert.throws(() => store.saveAiCuration(snapshot, { models:valid.map((item, i) => i ? item : { ...item, category:'cheap' }), default:{ provider:'openai', model:'a' } }), /categoría/);
  assert.throws(() => store.saveAiCuration(snapshot, { models:[...valid, { provider:'openai', model:'injected', visible:true, category:'advanced' }], default:{ provider:'openai', model:'a' } }), /catálogo completo/);
  assert.throws(() => store.saveAiCuration(snapshot, { models:valid.map((item, i) => i ? { ...item, model:' bad' } : item), default:{ provider:'openai', model:'a' } }), /identificador/);
  assert.throws(() => store.saveAiCuration(snapshot, { models:valid, default:{ provider:'openai', model:'b' } }), /visible/);
  assert.equal(store.aiPreferences().models.size, 0, 'una validación fallida no escribe parcialmente');
});

test('permite cero modelos visibles y exige predeterminado vacío', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const snapshot = aiSnapshot(['a']);
  const models = [{ provider:'openai', model:'a', visible:false, category:'unclassified' }];
  assert.throws(() => store.saveAiCuration(snapshot, { models, default:{ provider:'openai', model:'a' } }), /debe quedar vacío/);
  const projected = store.saveAiCuration(snapshot, { models, default:null });
  assert.deepEqual(projected.providers, []);
  assert.equal(projected.default, null);
  assert.equal(projected.allProviders[0].models[0].visible, false);
});

test('un predeterminado ausente usa fallback sin perder preferencias y se recupera al reaparecer', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.saveAiCuration(aiSnapshot(), {
    models:[
      { provider:'openai', model:'a', visible:true, category:'efficient' },
      { provider:'openai', model:'b', visible:true, category:'advanced' }
    ],
    default:{ provider:'openai', model:'b' }
  });
  const disappeared = store.projectAiCatalog(aiSnapshot(['a']), { admin:true });
  assert.deepEqual(disappeared.default, { provider:'openai', model:'a' });
  assert.equal(disappeared.defaultFallback, true);
  assert.deepEqual(disappeared.persistedDefault, { provider:'openai', model:'b' });
  const returned = store.projectAiCatalog(aiSnapshot(), { admin:true });
  assert.deepEqual(returned.default, { provider:'openai', model:'b' });
  assert.equal(returned.allProviders[0].models[1].category, 'advanced');
});

const recordGeneration = (store, id, operation) => store.recordAiGeneration({
  id, createdAt:new Date().toISOString(), operation, provider:'custom', model:'model',
  term:id, entryId:operation === 'edit' ? 'word' : null, outcome:'success', durationMs:5, itemCount:1, validCount:1
});

const generationRow = (path, id) => {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT operation, saved_count, saved_at FROM ai_generations WHERE id = ?').get(id);
    return row ? { ...row } : row;
  }
  finally { db.close(); }
};

test('consume una generación create o edit exactamente una vez al guardar', t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  const createId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  recordGeneration(store, createId, 'create');
  store.apply([source([entry('word')])], 'update', 'ia', { generationId:createId });
  assert.equal(generationRow(path, createId).saved_count, 1);
  assert.ok(generationRow(path, createId).saved_at);

  recordGeneration(store, editId, 'edit');
  store.replace('word', entry('changed'), 'ia', { generationId:editId });
  assert.equal(generationRow(path, editId).saved_count, 1);
  assert.ok(generationRow(path, editId).saved_at);
});

test('rechaza una generación inexistente y revierte tarjeta e historial', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(
    () => store.apply([source([entry('missing')])], 'update', 'ia', { generationId:id }),
    error => error.status === 400 && error.code === 'GENERATION_NOT_FOUND'
  );
  assert.equal(store.get('missing'), null);
  assert.equal(store.size, 0, 'la caché tampoco incorpora la tarjeta revertida');
  assert.equal(store.maintenanceSummary().imports, 0);
});

test('una generación consumida no puede reutilizarse ni sobrescribir su conteo', t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  recordGeneration(store, id, 'create');
  store.apply([source([entry('first')])], 'update', 'ia', { generationId:id });
  const consumed = generationRow(path, id);
  assert.throws(
    () => store.apply([source([entry('second')])], 'update', 'ia', { generationId:id }),
    error => error.status === 400 && error.code === 'GENERATION_ALREADY_CONSUMED'
  );
  assert.deepEqual(generationRow(path, id), consumed);
  assert.equal(store.get('second'), null);
  assert.equal(store.maintenanceSummary().imports, 1);
});

test('rechaza correlaciones cruzadas entre create e import y edit y replace', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('word')])], 'update', 'texto');
  const createId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const editId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  recordGeneration(store, createId, 'create');
  recordGeneration(store, editId, 'edit');
  const before = store.maintenanceSummary();

  assert.throws(
    () => store.replace('word', entry('changed'), 'ia', { generationId:createId }),
    error => error.status === 400 && error.code === 'GENERATION_OPERATION_MISMATCH'
  );
  assert.throws(
    () => store.apply([source([entry('new')])], 'update', 'ia', { generationId:editId }),
    error => error.status === 400 && error.code === 'GENERATION_OPERATION_MISMATCH'
  );
  assert.equal(store.get('word').head, 'word');
  assert.equal(store.get('new'), null);
  assert.deepEqual(store.maintenanceSummary(), before);
});

test('una importación correlacionada sin cambios no consume ni registra y permite un guardado posterior', t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  store.apply([source([entry('word')])], 'update', 'texto');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  recordGeneration(store, id, 'create');
  const imports = store.maintenanceSummary().imports;
  assert.throws(
    () => store.apply([source([entry('word')])], 'update', 'ia', { generationId:id }),
    error => error.status === 400 && error.code === 'GENERATION_WITHOUT_CHANGES'
  );
  assert.deepEqual(generationRow(path, id), { operation:'create', saved_count:0, saved_at:null });
  assert.equal(store.maintenanceSummary().imports, imports);

  store.apply([source([entry('word', { meaning:'Actualizado' })])], 'update', 'ia', { generationId:id });
  assert.equal(store.get('word').meaning, 'Actualizado');
  assert.equal(generationRow(path, id).saved_count, 1);
});

test('un fallo posterior al consumo revierte generación, tarjeta e importación', t => {
  const { store, path, cleanup } = tempStore(); t.after(cleanup);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  recordGeneration(store, id, 'create');
  assert.throws(() => store.apply([source([entry('rollback')])], 'update', null, { generationId:id }));
  assert.deepEqual(generationRow(path, id), { operation:'create', saved_count:0, saved_at:null });
  assert.equal(store.get('rollback'), null);
  assert.equal(store.size, 0);
  assert.equal(store.maintenanceSummary().imports, 0);
});

test('rechaza generationId no canónico antes de guardar o auditar', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  assert.throws(
    () => store.apply([source([entry('unsafe')])], 'update', 'ia', { generationId:'texto-arbitrario' }),
    error => error.status === 400 && error.code === 'INVALID_GENERATION_ID'
  );
  assert.equal(store.size, 0);
  assert.equal(store.maintenanceSummary().imports, 0);

  store.apply([source([entry('safe')])], 'update', 'texto');
  const before = store.maintenanceSummary();
  assert.throws(() => store.replace('safe', entry('changed'), 'ia', { generationId:null }), /generación/);
  assert.equal(store.get('safe').head, 'safe');
  assert.deepEqual(store.maintenanceSummary(), before);
});

test('agrega telemetría, deduplica vistas y actualiza el estado de aprendizaje', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const batch = {
    clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    events:[
      { type:'search', entryId:null, term:'give up', resultCount:0, value:null },
      { type:'card_view', entryId:'give-up', term:null, resultCount:null, value:null },
      { type:'card_view', entryId:'give-up', term:null, resultCount:null, value:null },
      { type:'known_changed', entryId:'give-up', term:null, resultCount:null, value:1 }
    ]
  };
  assert.equal(store.recordUsage(batch).accepted, 3);
  const stats = store.statistics('all');
  assert.equal(stats.usage.card_views, 1);
  assert.equal(stats.usage.no_result_searches, 1);
  assert.equal(stats.learning.known, 1);
  assert.equal(stats.searches[0].term, 'give up');
  assert.equal(stats.usageDaily.length, 1, 'la actividad diaria agrupa los eventos del mismo día');
  assert.equal(stats.usageDaily[0].views, 1);
  assert.equal(stats.usageDaily[0].searches, 1);
  assert.equal(stats.usageDaily[0].flips, 0);
  assert.equal(stats.usageDaily[0].audios, 0);
});

test('las limpiezas son separadas, idempotentes y mantienen la caché y el estado de seed', t => {
  const { store, path, cleanup } = tempStore();
  store.apply([source([entry('one')])], 'update', 'texto');
  store.recordUsage({
    clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    events:[{ type:'card_view', entryId:'one', term:null, resultCount:null, value:null }]
  });
  assert.equal(store.shouldSeedWhenEmpty(), true);
  const cards = store.clearMaintenance('cards');
  assert.equal(cards.changed, true);
  assert.equal(cards.removed.cards, 1);
  assert.equal(store.size, 0);
  assert.equal(store.shouldSeedWhenEmpty(), false);
  assert.equal(store.meta(12).dataEpoch, 1);
  assert.equal(store.statistics('all').usage.card_views, 1, 'las métricas sobreviven al borrado de tarjetas');

  store.clearMaintenance('audit');
  const auditSecond = store.clearMaintenance('audit');
  assert.equal(auditSecond.changed, false);
  assert.equal(auditSecond.removed.audit, 0);
  assert.equal(store.maintenanceSummary().audit, 1, 'queda una única marca audit.cleared');
  store.clearMaintenance('metrics');
  assert.equal(store.statistics('all').usage.events, 0);
  store.close();

  const reopened = new VocabStore(path);
  t.after(() => { reopened.close(); cleanup(); });
  assert.equal(reopened.shouldSeedWhenEmpty(), false, 'la inhibición de seed persiste tras reiniciar');
  assert.equal(reopened.meta(12).dataEpoch, 1);
});

test('limpiar tarjetas vacías inhibe seed una vez sin repetir epoch ni auditoría', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const first = store.clearMaintenance('cards');
  assert.equal(first.changed, true);
  assert.equal(first.removed.cards, 0);
  assert.equal(first.summary.seedSuppressed, true);
  assert.equal(first.summary.dataEpoch, 1);
  assert.equal(first.summary.audit, 1);

  const second = store.clearMaintenance('cards');
  assert.equal(second.changed, false);
  assert.equal(second.summary.dataEpoch, 1);
  assert.equal(second.summary.audit, 1);
  assert.deepEqual(second.removed, { cards:0, imports:0, audit:0, usageEvents:0, learningStates:0, aiGenerations:0, aiPreferences:0 });
});

test('reiniciar todo borra preferencias y deja solo system.reset', t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const snapshot = aiSnapshot(['a']);
  store.saveAiCuration(snapshot, {
    models:[{ provider:'openai', model:'a', visible:true, category:'balanced' }],
    default:{ provider:'openai', model:'a' }
  });
  store.apply([source([entry('one')])], 'update', 'texto');
  const result = store.clearMaintenance('all');
  assert.equal(result.changed, true);
  assert.equal(result.summary.cards, 0);
  assert.equal(result.summary.imports, 0);
  assert.equal(result.summary.audit, 1);
  assert.equal(result.summary.aiPreferences, 0);
  assert.equal(store.aiPreferences().default, null);

  const second = store.clearMaintenance('all');
  assert.equal(second.changed, false);
  assert.equal(second.summary.dataEpoch, result.summary.dataEpoch);
  assert.equal(second.summary.audit, 1);
});
