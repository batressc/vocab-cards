import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { VocabStore } from '../vocab-store.js';
import { tempStore, entry, source } from './helpers.js';

const aiSnapshot = (models = ['a', 'b']) => ({
  providers: [{ id:'openai', label:'OpenAI', stale:false, models:models.map(id => ({ id, label:id.toUpperCase(), protocol:'responses' })) }],
  default:{ provider:'openai', model:models[0] }, stale:false, errors:[]
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
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
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
